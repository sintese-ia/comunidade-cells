// Coleta automática. Roda DENTRO do app, não no n8n.
//
// Por quê aqui: o app já vive no Easypanel com o token da Meta em env var e o Postgres na rede
// interna. Pôr isso no n8n significaria duplicar a credencial, criar 4 workflows novos no meio
// dos 44 existentes (13 deles enviando mensagem, com regra dura de não encostar) e depender de
// mais uma peça no ar. O webhook de story fecha o argumento: este serviço já tem domínio
// público com SSL válido, então é só uma rota.
//
// Cada job é idempotente e registra o resultado em creator.job_log.

const https = require('https');

const GRAPH = process.env.GRAPH_VERSION || 'v21.0';
const IG_ID = process.env.IG_USER_ID || '17841405730329135';

// ---------------------------------------------------------------- http helpers
function req(url, opts = {}) {
  return new Promise((ok, err) => {
    const r = https.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        if (opts.raw) return ok({ status: res.statusCode, headers: res.headers, buf });
        try { ok(JSON.parse(buf.toString('utf8'))); }
        catch { err(new Error('resposta não-JSON de ' + String(url).slice(0, 60))); }
      });
    });
    r.on('error', err);
    r.setTimeout(opts.timeout || 60000, () => r.destroy(new Error('timeout')));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- mídia local
// MEDIDO EM 08/08: a URL de VÍDEO do Apify morre em menos de 48h — coletada em 06/08, no dia 08
// devolvia 403. A de IMAGEM continua viva. Ou seja: guardar só a URL significa uma galeria onde
// o vídeo nunca toca, porque o job é semanal e a URL não sobrevive ao intervalo.
// Por isso o vídeo é BAIXADO na coleta e fica em creator.publicacao_midia (bytea).
//
// ⚠️ Isso tem CUSTO: 34 reels deram 361 MB, ~10 MB cada. Guardar tudo para sempre significa
// ~150 MB por mês de crescimento num banco que hoje inteiro é pequeno. Então há três limites:
//   1. teto por arquivo;
//   2. só baixa sozinho o que é recente — conteúdo velho fica com thumbnail e link;
//   3. o que foi baixado é apagado depois de 90 dias, EXCETO o que virou anúncio.
// O que passou do corte não some da tela: continua com métrica, capa e o botão de buscar sob
// demanda, que traz o arquivo de volta na hora.
const TETO_MIDIA = 60 * 1024 * 1024;   // 60 MB
const JANELA_AUTO = 90;                // dias: só baixa sozinho post mais novo que isso
const RETENCAO    = 90;                // dias guardados depois do download

async function guardarVideo(pool, publicacaoId, url) {
  if (!url) return false;
  try {
    const m = await req(url, { raw: true, timeout: 60000 });
    if (m.status !== 200 || !m.buf.length) throw new Error('HTTP ' + m.status);
    if (m.buf.length > TETO_MIDIA) throw new Error('acima do teto de 30 MB (' +
      Math.round(m.buf.length / 1048576) + ' MB)');
    await pool.query(`
      INSERT INTO creator.publicacao_midia (publicacao_id,mime,bytes,tamanho,origem_url,erro)
      VALUES ($1,$2,$3,$4,$5,NULL)
      ON CONFLICT (publicacao_id) DO UPDATE SET
        mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, tamanho=EXCLUDED.tamanho,
        origem_url=EXCLUDED.origem_url, baixado_em=now(), erro=NULL`,
      [publicacaoId, m.headers['content-type'] || 'video/mp4', m.buf, m.buf.length, url]);
    await pool.query(`UPDATE creator.publicacao SET media_local='db' WHERE publicacao_id=$1`,
                     [publicacaoId]);
    return true;

  } catch (e) {
    // registra a falha em vez de sumir com ela: assim a tela consegue dizer POR QUE não toca
    await pool.query(`
      INSERT INTO creator.publicacao_midia (publicacao_id,origem_url,erro)
      VALUES ($1,$2,$3) ON CONFLICT (publicacao_id) DO UPDATE SET erro=EXCLUDED.erro`,
      [publicacaoId, url, e.message]).catch(() => {});
    return false;
  }
}

// Solta o peso do que já passou da validade. O que virou anúncio nunca é apagado — é
// justamente o arquivo que a Cells está usando em mídia paga.
async function limparMidia(pool) {
  const r = await pool.query(`
    DELETE FROM creator.publicacao_midia md
    USING creator.publicacao u
    WHERE u.publicacao_id = md.publicacao_id
      AND md.bytes IS NOT NULL
      AND md.baixado_em < now() - ($1 || ' days')::interval
      AND NOT coalesce(u.virou_anuncio, false)
    RETURNING md.publicacao_id`, [String(RETENCAO)]);
  if (r.rowCount) await pool.query(
    `UPDATE creator.publicacao SET media_local=NULL WHERE publicacao_id = ANY($1)`,
    [r.rows.map(x => x.publicacao_id)]);
  return r.rowCount;
}

// Busca UM post específico no Apify e guarda o vídeo. É o que o botão "buscar este vídeo"
// chama quando alguém quer assistir algo antigo, que o job automático não guardaria.
async function buscarVideoDe(pool, apifyToken, publicacaoId) {
  if (!apifyToken) throw new Error('APIFY_TOKEN ausente');
  const { rows } = await pool.query(
    `SELECT publicacao_id, permalink FROM creator.publicacao WHERE publicacao_id=$1`, [publicacaoId]);
  const p = rows[0];
  if (!p) throw new Error('publicação não encontrada');
  if (!p.permalink) throw new Error('esta publicação não tem link — não dá para buscar');

  const run = await req(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${apifyToken}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directUrls: [p.permalink], resultsType: 'posts', resultsLimit: 1,
                             addParentData: false }) });
  if (!run.data) throw new Error('Apify não devolveu run');
  const { id, defaultDatasetId } = run.data;

  let status = 'RUNNING';
  for (let i = 0; i < 16 && !['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status); i++) {
    await sleep(8000);
    status = (await req(`https://api.apify.com/v2/actor-runs/${id}?token=${apifyToken}`)).data?.status || status;
  }
  if (status !== 'SUCCEEDED') throw new Error('run do Apify terminou em ' + status);

  const itens = await req(
    `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${apifyToken}&format=json&clean=true`);
  const it = (itens || [])[0];
  if (!it || !it.videoUrl) throw new Error('o Apify não devolveu vídeo para este post');
  const ok = await guardarVideo(pool, p.publicacao_id, it.videoUrl);
  if (!ok) {
    const e = await pool.query(
      `SELECT erro FROM creator.publicacao_midia WHERE publicacao_id=$1`, [p.publicacao_id]);
    throw new Error(e.rows[0]?.erro || 'download falhou');
  }
  return { ok: true };
}

// ---------------------------------------------------------------- log
async function logJob(pool, nome, ok, detalhe, itens) {
  try {
    await pool.query(
      `INSERT INTO creator.job_log (job, sucesso, detalhe, itens) VALUES ($1,$2,$3,$4)`,
      [nome, ok, String(detalhe).slice(0, 2000), itens ?? null]);
  } catch (e) { console.error('[job_log]', e.message); }
}

// ---------------------------------------------------------------- 1. /tags
// Incremental: só grava o que ainda não existe (ON CONFLICT no ig_media_id), e para de paginar
// assim que bate numa página inteira já conhecida. Métrica sempre vira linha nova — curtida
// cresce por semanas e a curva importa.
const tipoDe = t => t.media_product_type === 'REELS' ? 'reels'
  : t.media_type === 'CAROUSEL_ALBUM' ? 'carrossel'
  : t.media_type === 'VIDEO' ? 'feed_video' : 'feed_imagem';

async function syncTags(pool, token) {
  if (!token) throw new Error('META_TOKEN ausente');
  const campos = 'id,username,timestamp,media_type,media_product_type,permalink,caption,like_count,comments_count';
  let url = `https://graph.facebook.com/${GRAPH}/${IG_ID}/tags?fields=${campos}&limit=50` +
            `&access_token=${encodeURIComponent(token)}`;
  let novas = 0, vistas = 0, paginas = 0, metricas = 0;

  while (url && paginas < 40) {
    const d = await req(url);
    if (d.error) throw new Error(d.error.message);
    const itens = d.data || [];
    if (!itens.length) break;
    let novasNaPagina = 0;

    for (const t of itens) {
      vistas++;
      const r = await pool.query(`
        INSERT INTO creator.publicacao
          (ig_media_id,instagram_handle,tipo,publicado_em,permalink,legenda,fonte,payload)
        VALUES ($1,$2,$3,$4,$5,$6,'tags_api',$7)
        ON CONFLICT (ig_media_id) WHERE ig_media_id IS NOT NULL DO NOTHING
        RETURNING publicacao_id`,
        [t.id, (t.username || '').toLowerCase(), tipoDe(t), t.timestamp, t.permalink,
         (t.caption || '').slice(0, 4000), t]);
      if (r.rows[0]) { novas++; novasNaPagina++; }

      const id = r.rows[0]?.publicacao_id ?? (await pool.query(
        `SELECT publicacao_id FROM creator.publicacao WHERE ig_media_id=$1`, [t.id])).rows[0]?.publicacao_id;
      if (id) {
        const m = await pool.query(`
          INSERT INTO creator.publicacao_metrica (publicacao_id,coletado_em,curtidas,comentarios,fonte)
          VALUES ($1,current_date,$2,$3,'tags_api')
          ON CONFLICT (publicacao_id,coletado_em,fonte) DO UPDATE
            SET curtidas=EXCLUDED.curtidas, comentarios=EXCLUDED.comentarios
          RETURNING metrica_id`, [id, t.like_count ?? null, t.comments_count ?? null]);
        if (m.rows[0]) metricas++;
      }
    }
    paginas++;
    // página inteira conhecida = alcançamos o que já tínhamos. O resto é passado.
    if (novasNaPagina === 0 && paginas > 1) break;
    url = d.paging?.next || null;
  }

  await pool.query(`UPDATE creator.publicacao pu SET parceiro_id=pa.parceiro_id
    FROM creator.parceiro pa WHERE pu.parceiro_id IS NULL
      AND lower(pu.instagram_handle)=lower(pa.instagram_handle)`);

  return { novas, vistas, paginas, metricas };
}

// ---------------------------------------------------------------- 1b. cadastros -> fila
// creator.leads é a entrada crua (webhook das LPs). creator.parceiro é quem entrou na fila de
// curadoria. Este job faz a ponte: todo cadastro COMPLETO com @ vira um candidato pendente.
// Idempotente por handle — rodar de novo não duplica.
// ---------------------------------------------------------------- 0b. obrigado pelo registro
// Dispara UMA vez por pessoa, quando ela acabou de se cadastrar.
//
// ⚠️ AS DUAS GUARDAS AQUI EXISTEM PARA NÃO DISPARAR EM MASSA. Este job varre TODO parceiro,
// não só os novos. Sem elas, a primeira rodada mandaria e-mail para as 51 pessoas que já estão
// na base há semanas — gente que se cadastrou em julho receberia "obrigado pelo registro" hoje.
//   1. só quem se cadastrou nas últimas 48h;
//   2. só quem nunca recebeu e-mail de cadastro (creator.email_log).
const JANELA_REGISTRO_H = 48;

// ⚠️ TERCEIRA GUARDA, e a que mais importa: `REGISTRO_DESDE`.
// Quando este recurso subiu, JÁ HAVIA 10 pessoas cadastradas nas últimas 48h. Sem um corte,
// a primeira rodada mandaria "obrigado pelo seu registro" para elas — gente que se cadastrou
// antes do e-mail existir, recebendo um agradecimento com dois dias de atraso.
// Com o corte, só quem se cadastra DEPOIS da data recebe. Sem a variável definida o job não
// manda nada: melhor um recurso desligado do que e-mail inesperado para pessoa real.
const REGISTRO_DESDE = process.env.REGISTRO_DESDE || '';

async function avisarRegistro(pool, enviar) {
  if (typeof enviar !== 'function') return { avisados: 0, motivo: 'sem canal de e-mail' };
  if (!REGISTRO_DESDE) return { avisados: 0, motivo: 'REGISTRO_DESDE não definido — desligado' };
  const { rows } = await pool.query(`
    SELECT p.parceiro_id, p.nome, p.email, p.instagram_handle
    FROM creator.parceiro p
    WHERE p.email IS NOT NULL AND p.email <> ''
      AND p.criado_em > greatest($1::timestamptz, now() - interval '${JANELA_REGISTRO_H} hours')
      AND NOT p.arquivado
      -- só ENVIO BEM-SUCEDIDO bloqueia. Se a primeira tentativa falhou (Klaviyo fora do ar,
      -- e-mail inválido), a pessoa tem que entrar na próxima rodada — senão uma falha
      -- momentânea deixa alguém sem o e-mail para sempre, em silêncio.
      AND NOT EXISTS (SELECT 1 FROM creator.email_log el
                       WHERE el.parceiro_id = p.parceiro_id AND el.tipo = 'cadastro'
                         AND el.estado = 'evento_enviado')
    LIMIT 25`, [REGISTRO_DESDE]);
  let n = 0;
  for (const p of rows) {
    try {
      const props = await enviar({ email: p.email, nome: p.nome, instagram: p.instagram_handle });
      await pool.query(`
        INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,payload)
        VALUES ($1,$2,'Creator Cadastrado','cadastro','evento_enviado',$3)`,
        [p.parceiro_id, p.email, props]);
      n++;
    } catch (e) {
      // grava a falha: sem isso a pessoa fica fora do e-mail e ninguém fica sabendo
      await pool.query(`
        INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,detalhe)
        VALUES ($1,$2,'Creator Cadastrado','cadastro','falhou',$3)`,
        [p.parceiro_id, p.email, e.message]).catch(() => {});
      console.error('[registro]', p.email, e.message);
    }
  }
  return { avisados: n, candidatos: rows.length };
}

async function syncCadastros(pool, token, aoRegistrar) {
  const r = await pool.query(`
    INSERT INTO creator.parceiro (tipo,status,lead_id,nome,email,telefone_e164,instagram_handle,criado_em)
    SELECT 'creator','pendente', v.lead_id, v.nome, v.email, v.telefone_e164,
           lower(regexp_replace(v.instagram_handle,'^@','')), v.data_cadastro
    FROM creator.vw_cadastro v
    WHERE coalesce(v.instagram_handle,'') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM creator.parceiro p
        WHERE lower(p.instagram_handle) = lower(regexp_replace(v.instagram_handle,'^@','')))
    RETURNING parceiro_id, instagram_handle`);

  // slug do link nasce junto com o parceiro. Sem isso a ficha abre com "(sem slug)" e o
  // botão de copiar link não serve para nada — foi o que aconteceu com quem entrou depois
  // da geração inicial.
  await pool.query(`
    UPDATE creator.parceiro p SET utm_slug = b.s
    FROM (SELECT parceiro_id,
                 lower(regexp_replace(coalesce(nullif(instagram_handle,''), nome),'[^a-zA-Z0-9]','','g')) s
          FROM creator.parceiro WHERE utm_slug IS NULL) b
    WHERE p.parceiro_id = b.parceiro_id AND b.s <> ''
      AND NOT EXISTS (SELECT 1 FROM creator.parceiro x WHERE x.utm_slug = b.s)`);

  // liga o que já foi publicado por essa pessoa antes de ela se cadastrar
  await pool.query(`UPDATE creator.publicacao pu SET parceiro_id=pa.parceiro_id
    FROM creator.parceiro pa WHERE pu.parceiro_id IS NULL
      AND lower(pu.instagram_handle)=lower(pa.instagram_handle)`);
  await pool.query(`UPDATE creator.perfil_snapshot s SET parceiro_id=pa.parceiro_id
    FROM creator.parceiro pa WHERE s.parceiro_id IS NULL
      AND lower(s.instagram_handle)=lower(pa.instagram_handle)`);

  // Enriquecer AGORA, não no ciclo semanal. Candidato que chega sem seguidores e sem
  // engajamento obriga a abrir o Instagram na mão — que é exatamente o que a fila existe
  // para evitar. São poucos por vez, então cabe no mesmo job.
  // Pega TODO parceiro sem nenhum snapshot — não só os que acabaram de entrar. Assim a fila
  // se conserta sozinha se um enriquecimento falhar ou se alguém for inserido por fora.
  let enriquecidos = 0, indisponiveis = 0;
  if (token) {
    const faltando = await pool.query(`
      SELECT lower(instagram_handle) AS instagram_handle FROM creator.parceiro p
      WHERE instagram_handle IS NOT NULL AND NOT p.arquivado
        AND NOT EXISTS (SELECT 1 FROM creator.perfil_snapshot s
                        WHERE lower(s.instagram_handle)=lower(p.instagram_handle))
      LIMIT 40`);
    for (const { instagram_handle: h } of faltando.rows) {
      try {
        const p = await perfilDe(token, h);
        if (p) { await salvarPerfil(pool, p); enriquecidos++; }
        else {
          // Perfil pessoal ou privado: a Meta não expõe e NUNCA vai expor enquanto continuar
          // assim. Grava um marcador para a fila mostrar "perfil pessoal" em vez de campo vazio,
          // e para o job parar de tentar de hora em hora até o fim dos tempos.
          await pool.query(`
            INSERT INTO creator.perfil_snapshot (instagram_handle, coletado_em, fonte, payload)
            VALUES ($1, current_date, 'indisponivel', $2)
            ON CONFLICT (lower(instagram_handle), coletado_em) DO NOTHING`,
            [h, { motivo: 'perfil pessoal ou privado — business_discovery não retorna' }]);
          indisponiveis++;
        }
      } catch (e) { console.error('[cadastro/enriquecer]', h, e.message); }
      await sleep(250);
    }
    await pool.query(`UPDATE creator.perfil_snapshot s SET parceiro_id=pa.parceiro_id
      FROM creator.parceiro pa WHERE s.parceiro_id IS NULL
        AND lower(s.instagram_handle)=lower(pa.instagram_handle)`);
  }

  // "obrigado pelo registro" — por último, e só para quem acabou de entrar (ver as guardas
  // em avisarRegistro). Falha de e-mail não pode derrubar o sync do cadastro.
  let registro = { avisados: 0 };
  try { registro = await avisarRegistro(pool, aoRegistrar); }
  catch (e) { console.error('[registro]', e.message); registro = { avisados: 0, erro: e.message }; }

  return { novos: r.rowCount, enriquecidos, indisponiveis, avisados: registro.avisados,
           handles: r.rows.map(x => x.instagram_handle) };
}

// ---------------------------------------------------------------- 2. business_discovery
// Engajamento = média por post sobre os últimos 12. NÃO é janela de 30 dias — quem parou de
// postar continua tendo número, e a atividade real fica em posts_30d / ultimo_post.
async function perfilDe(token, handle) {
  const f = `business_discovery.username(${handle}){followers_count,media_count,name,biography,` +
            `media.limit(12){timestamp,media_type,media_product_type,like_count,comments_count}}`;
  const url = `https://graph.facebook.com/${GRAPH}/${IG_ID}?fields=${encodeURIComponent(f)}` +
              `&access_token=${encodeURIComponent(token)}`;
  const r = await req(url);
  if (r.error || !r.business_discovery) return null;   // perfil pessoal/privado — limite da Meta
  const bd = r.business_discovery, m = (bd.media && bd.media.data) || [];
  const seg = bd.followers_count || 0;
  const lk = m.reduce((a, x) => a + (x.like_count || 0), 0);
  const cm = m.reduce((a, x) => a + (x.comments_count || 0), 0);
  const t = x => new Date(x.timestamp).getTime();
  const d30 = Date.now() - 30 * 864e5, d90 = Date.now() - 90 * 864e5;
  return {
    handle, nome: bd.name || null, bio: (bd.biography || '').slice(0, 300),
    seguidores: seg, total_posts: bd.media_count || 0,
    eng: (m.length && seg) ? +((lk + cm) / m.length / seg * 100).toFixed(2) : null,
    base_calculo: m.length,
    likes_medios: m.length ? Math.round(lk / m.length) : 0,
    coment_medios: m.length ? Math.round(cm / m.length) : 0,
    posts_30d: m.filter(x => t(x) >= d30).length,
    posts_90d: m.filter(x => t(x) >= d90).length,
    ultimo_post: m.length ? m.map(x => x.timestamp).sort().pop().slice(0, 10) : null,
  };
}

async function salvarPerfil(pool, p) {
  await pool.query(`
    INSERT INTO creator.perfil_snapshot
      (instagram_handle,coletado_em,seguidores,total_posts,posts_30d,posts_90d,engajamento_pct,
       likes_medios,coment_medios,base_calculo,ultimo_post,nome,bio,fonte,payload)
    VALUES ($1,current_date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'business_discovery',$13)
    ON CONFLICT (lower(instagram_handle),coletado_em) DO UPDATE SET
      seguidores=EXCLUDED.seguidores, total_posts=EXCLUDED.total_posts,
      posts_30d=EXCLUDED.posts_30d, posts_90d=EXCLUDED.posts_90d,
      engajamento_pct=EXCLUDED.engajamento_pct, likes_medios=EXCLUDED.likes_medios,
      coment_medios=EXCLUDED.coment_medios, base_calculo=EXCLUDED.base_calculo,
      ultimo_post=EXCLUDED.ultimo_post, nome=EXCLUDED.nome, bio=EXCLUDED.bio, payload=EXCLUDED.payload`,
    [p.handle, p.seguidores, p.total_posts, p.posts_30d, p.posts_90d, p.eng,
     p.likes_medios, p.coment_medios, p.base_calculo, p.ultimo_post, p.nome, p.bio, p]);
}

async function syncPerfis(pool, token) {
  if (!token) throw new Error('META_TOKEN ausente');
  // prioriza parceiro; depois quem já marcou a Cells. Snapshot de hoje já feito é pulado.
  const { rows } = await pool.query(`
    SELECT h FROM (
      SELECT lower(instagram_handle) h FROM creator.parceiro WHERE instagram_handle IS NOT NULL
      UNION
      SELECT lower(instagram_handle) FROM creator.publicacao
    ) x
    WHERE NOT EXISTS (
      SELECT 1 FROM creator.perfil_snapshot s
      WHERE lower(s.instagram_handle)=x.h AND s.coletado_em=current_date)`);

  let ok = 0, sem = 0;
  for (const { h } of rows) {
    try {
      const p = await perfilDe(token, h);
      if (!p) { sem++; continue; }
      await salvarPerfil(pool, p); ok++;
    } catch (e) { console.error('[perfil]', h, e.message); sem++; }
    await sleep(250);
  }
  return { atualizados: ok, sem_dados: sem, candidatos: rows.length };
}

// ---------------------------------------------------------------- 3. Apify (views de reels)
// Assíncrono com polling. NUNCA run-sync: estoura em 300s.
async function syncApify(pool, apifyToken, limite = 40) {
  if (!apifyToken) throw new Error('APIFY_TOKEN ausente');
  // Quem ainda não tem o vídeo guardado vem PRIMEIRO: a métrica desse reel pode até estar
  // fresca, mas sem o arquivo o player não toca, e a URL de hoje é a única chance de baixar.
  const { rows } = await pool.query(`
    SELECT u.publicacao_id, u.permalink,
           EXISTS (SELECT 1 FROM creator.publicacao_midia md
                   WHERE md.publicacao_id=u.publicacao_id AND md.bytes IS NOT NULL) AS tem_bytes,
           (u.publicado_em::date >= current_date - ${JANELA_AUTO}
            OR coalesce(u.virou_anuncio,false)) AS vale_guardar
    FROM creator.publicacao u
    WHERE u.tipo='reels' AND u.permalink IS NOT NULL
      AND (NOT EXISTS (
             SELECT 1 FROM creator.publicacao_metrica m
             WHERE m.publicacao_id=u.publicacao_id AND m.fonte='apify' AND m.coletado_em=current_date)
           OR NOT EXISTS (
             SELECT 1 FROM creator.publicacao_midia md
             WHERE md.publicacao_id=u.publicacao_id AND md.bytes IS NOT NULL))
    ORDER BY tem_bytes, u.publicado_em DESC LIMIT $1`, [limite]);
  if (!rows.length) return { pendentes: 0, coletados: 0 };

  const run = await req(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${apifyToken}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directUrls: rows.map(r => r.permalink),
                             resultsType: 'posts', resultsLimit: rows.length, addParentData: false }) });
  if (!run.data) throw new Error('Apify não devolveu run');
  const { id, defaultDatasetId } = run.data;

  let status = 'RUNNING';
  for (let i = 0; i < 40 && !['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status); i++) {
    await sleep(15000);
    status = (await req(`https://api.apify.com/v2/actor-runs/${id}?token=${apifyToken}`)).data?.status || status;
  }
  if (status !== 'SUCCEEDED') throw new Error('run do Apify terminou em ' + status);

  const itens = await req(
    `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${apifyToken}&format=json&clean=true`);
  // O Apify devolve -1 quando o post esconde curtidas. Guardar -1 corromperia qualquer soma —
  // vira NULL, que é o que "não sei" significa no banco.
  const nn = v => (v == null || v < 0) ? null : v;
  const porCodigo = new Map();
  for (const it of (itens || [])) if (it.shortCode) porCodigo.set(it.shortCode, it);

  let n = 0, videos = 0;
  for (const r of rows) {
    const cod = (r.permalink.match(/\/(?:reel|p|tv)\/([^/?]+)/) || [])[1];
    const it = cod && porCodigo.get(cod);
    if (!it) continue;
    await pool.query(`
      INSERT INTO creator.publicacao_metrica
        (publicacao_id,coletado_em,curtidas,comentarios,visualizacoes,reproducoes,fonte,payload)
      VALUES ($1,current_date,$2,$3,$4,$5,'apify',$6)
      ON CONFLICT (publicacao_id,coletado_em,fonte) DO UPDATE SET
        curtidas=EXCLUDED.curtidas, comentarios=EXCLUDED.comentarios,
        visualizacoes=EXCLUDED.visualizacoes, reproducoes=EXCLUDED.reproducoes`,
      [r.publicacao_id, nn(it.likesCount), nn(it.commentsCount),
       nn(it.videoViewCount), nn(it.videoPlayCount), it]);
    n++;
    // baixar AGORA: daqui a dois dias essa URL não existe mais
    if (it.videoUrl && !r.tem_bytes && r.vale_guardar
        && await guardarVideo(pool, r.publicacao_id, it.videoUrl)) videos++;
  }
  const apagados = await limparMidia(pool).catch(() => 0);
  return { pendentes: rows.length, coletados: n, videos_baixados: videos, midia_expirada: apagados };
}

// ---------------------------------------------------------------- 4. story mention (webhook)
// A mídia do story morre em 24h no CDN da Meta. Baixar AGORA ou perder para sempre.
async function guardarStory(pool, { handle, mediaUrl, ts, storyId, payload }) {
  const r = await pool.query(`
    INSERT INTO creator.publicacao
      (ig_media_id,instagram_handle,tipo,publicado_em,permalink,fonte,payload)
    VALUES ($1,$2,'story',$3,$4,'webhook_story',$5)
    ON CONFLICT (ig_media_id) WHERE ig_media_id IS NOT NULL DO NOTHING
    RETURNING publicacao_id`,
    [storyId || null, (handle || '').toLowerCase(), ts || new Date().toISOString(), null, payload]);
  if (!r.rows[0]) return null;
  const id = r.rows[0].publicacao_id;

  await pool.query(`UPDATE creator.publicacao pu SET parceiro_id=pa.parceiro_id
    FROM creator.parceiro pa WHERE pu.publicacao_id=$1
      AND lower(pu.instagram_handle)=lower(pa.instagram_handle)`, [id]);

  if (mediaUrl) {
    try {
      const m = await req(mediaUrl, { raw: true, timeout: 30000 });
      if (m.status === 200 && m.buf.length) {
        await pool.query(`
          INSERT INTO creator.publicacao_midia (publicacao_id,mime,bytes,tamanho,origem_url)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (publicacao_id) DO NOTHING`,
          [id, m.headers['content-type'] || null, m.buf, m.buf.length, mediaUrl]);
        await pool.query(`UPDATE creator.publicacao SET media_local='db' WHERE publicacao_id=$1`, [id]);
      } else throw new Error('HTTP ' + m.status);
    } catch (e) {
      await pool.query(`
        INSERT INTO creator.publicacao_midia (publicacao_id,origem_url,erro)
        VALUES ($1,$2,$3) ON CONFLICT (publicacao_id) DO NOTHING`,
        [id, mediaUrl, e.message]);
      console.error('[story midia]', e.message);
    }
  }
  return id;
}

// Extrai story mentions do payload do webhook `messages` da Meta.
function extrairStories(body) {
  const out = [];
  for (const e of (body.entry || [])) {
    for (const m of (e.messaging || [])) {
      const anexos = m.message?.attachments || [];
      for (const a of anexos) {
        if (a.type !== 'story_mention') continue;
        out.push({
          handle: m.sender?.username || m.sender?.id || '',
          mediaUrl: a.payload?.url || null,
          ts: m.timestamp ? new Date(+m.timestamp).toISOString() : null,
          storyId: m.message?.mid || null,
          payload: m,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- agendador
// Um replica só, então basta um lock em memória. Se um dia virar 2+, trocar por advisory lock
// do Postgres (pg_try_advisory_lock) — senão os dois batem na Meta ao mesmo tempo.
function agendar(pool, env) {
  const rodando = new Set();
  const roda = async (nome, fn) => {
    if (rodando.has(nome)) return;
    rodando.add(nome);
    const t0 = Date.now();
    try {
      const r = await fn();
      if (typeof env.onMudanca === 'function') env.onMudanca();
      console.log(`[job ${nome}] ok em ${((Date.now()-t0)/1000).toFixed(1)}s`, JSON.stringify(r));
      await logJob(pool, nome, true, JSON.stringify(r), r.novas ?? r.atualizados ?? r.coletados ?? 0);
    } catch (e) {
      console.error(`[job ${nome}] falhou:`, e.message);
      await logJob(pool, nome, false, e.message, 0);
    } finally { rodando.delete(nome); }
  };

  const DIA = 864e5, HORA = 36e5;
  // cadastro novo tem que aparecer na fila rápido — é o que o Gabriel abre de manhã
  setInterval(() => roda('cadastros', () => syncCadastros(pool, env.META_TOKEN, env.aoRegistrar)), HORA).unref();
  setTimeout(() => roda('cadastros', () => syncCadastros(pool, env.META_TOKEN, env.aoRegistrar)), 15000).unref();
  // /tags roda diário: marcação nova aparecendo com 1 dia de atraso já é aceitável, e é barato.
  setInterval(() => roda('tags',   () => syncTags(pool, env.META_TOKEN)),   DIA).unref();
  setInterval(() => roda('perfis', () => syncPerfis(pool, env.META_TOKEN)), 7 * DIA).unref();
  setInterval(() => roda('apify',  () => syncApify(pool, env.APIFY_TOKEN)), 7 * DIA).unref();

  // primeira rodada 2 min depois do boot, para não competir com o pré-aquecimento do cache
  setTimeout(() => roda('tags', () => syncTags(pool, env.META_TOKEN)), 120000).unref();

  return { roda, syncTags, syncPerfis, syncApify };
}

module.exports = { syncTags, syncPerfis, syncApify, syncCadastros, avisarRegistro, perfilDe, salvarPerfil,
                   guardarStory, guardarVideo, buscarVideoDe, limparMidia,
                   extrairStories, agendar, logJob };
