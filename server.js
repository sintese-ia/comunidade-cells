// Comunidade Cells — painel interno de gestão de creators.
//
// Duas fontes, e a diferença entre elas importa:
//   - Postgres (schema `creator`), lido pela rede interna do Easypanel → o que já foi coletado.
//   - Graph API da Meta, ao vivo no /api/buscar → qualquer @ do Instagram, na hora.
//
// O token da Meta NUNCA sai do servidor. O browser chama /api/buscar e o servidor chama a Meta.
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const Q = require('./queries');
const J = require('./jobs');

const PORT    = process.env.PORT || 3000;
const SENHA   = process.env.SENHA || 'cells';
const TTL     = (+process.env.CACHE_MIN || 5) * 60 * 1000;
const IG_ID   = process.env.IG_USER_ID || '17841405730329135';   // @cellsoficial
const META    = process.env.META_TOKEN || '';
const GRAPH_V = process.env.GRAPH_VERSION || 'v21.0';
const APIFY   = process.env.APIFY_TOKEN || '';
const APP_SECRET   = process.env.META_APP_SECRET || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const COOKIE  = 'cc_sess';
const TOKEN   = require('crypto').createHash('sha256').update('cc|' + SENHA).digest('hex').slice(0, 32);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, max: 4, idleTimeoutMillis: 30000, statement_timeout: 60000,
});

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
let cache = { at: 0, json: null, erro: null };

// ---------------------------------------------------------------- Postgres
async function carregar() {
  const out = {};
  const cli = await pool.connect();
  try {
    for (const [k, sql] of Object.entries(Q)) {
      const r = await cli.query(sql);
      out[k] = r.rows.map(row => {
        const o = {};
        for (const [c, v] of Object.entries(row)) {
          o[c] = (v instanceof Date) ? v.toISOString().slice(0, 10)
               : (typeof v === 'string' && /^-?\d+\.?\d+$|^-?\d+$/.test(v)) ? Number(v)
               : v;
        }
        return o;
      });
    }
  } finally { cli.release(); }
  out.ger = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return out;
}

let emVoo = null;
function recarregar() {
  if (emVoo) return emVoo;
  emVoo = carregar()
    .then(d => { cache = { at: Date.now(), json: d, erro: null }; return d; })
    .catch(e => {
      console.error('[carga]', e.message);
      if (cache.json) { cache.erro = e.message; return cache.json; }
      throw e;
    })
    .finally(() => { emVoo = null; });
  return emVoo;
}

async function dados() {
  if (cache.json) { if (Date.now() - cache.at >= TTL) recarregar(); return cache.json; }
  return recarregar();
}

// ---------------------------------------------------------------- Meta Graph
function getJSON(url) {
  return new Promise((ok, err) => {
    https.get(url, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { err(new Error('resposta inválida da Meta')); } });
    }).on('error', err).setTimeout(20000, function () { this.destroy(new Error('timeout na Meta')); });
  });
}

// business_discovery só enxerga conta Business/Creator PÚBLICA. Perfil pessoal ou privado
// volta sem o nó `business_discovery` — e isso não é erro nosso, é limite da Meta.
async function buscarPerfil(handle) {
  if (!META) throw new Error('META_TOKEN não configurado no serviço');
  const h = String(handle).trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h)) throw new Error('handle inválido');

  const fields = `business_discovery.username(${h}){followers_count,media_count,name,biography,website,` +
    `profile_picture_url,media.limit(12){id,timestamp,media_type,media_product_type,permalink,` +
    `caption,like_count,comments_count}}`;
  const url = `https://graph.facebook.com/${GRAPH_V}/${IG_ID}?fields=${encodeURIComponent(fields)}` +
              `&access_token=${encodeURIComponent(META)}`;

  const r = await getJSON(url);
  if (r.error) {
    const m = r.error.message || 'erro da Meta';
    if (/does not exist|cannot be loaded|invalid user id|unsupported get request/i.test(m))
      throw new Error(`@${h} não foi encontrado como conta Business ou Creator pública. ` +
                      `Perfil pessoal e perfil privado não são visíveis pela API da Meta.`);
    throw new Error(m);
  }
  const bd = r.business_discovery;
  if (!bd)
    throw new Error(`@${h} existe, mas não é conta Business/Creator pública — a Meta não libera ` +
                    `os dados. Peça para converter o perfil (é grátis) ou colete por outra via.`);

  const m = (bd.media && bd.media.data) || [];
  const seg = bd.followers_count || 0;
  const lk = m.reduce((a, x) => a + (x.like_count || 0), 0);
  const cm = m.reduce((a, x) => a + (x.comments_count || 0), 0);
  const d30 = Date.now() - 30 * 864e5, d90 = Date.now() - 90 * 864e5;
  const ts = x => new Date(x.timestamp).getTime();

  return {
    handle: h,
    nome: bd.name || null,
    bio: (bd.biography || '').slice(0, 300),
    website: bd.website || null,
    foto: bd.profile_picture_url || null,
    seguidores: seg,
    total_posts: bd.media_count || 0,
    // engajamento = média por post sobre os últimos N posts (padrão das ferramentas de
    // influencer). NÃO é janela de 30 dias: quem não posta há meses continua tendo número,
    // e a atividade real fica em posts_30d / posts_90d / ultimo_post.
    eng: (m.length && seg) ? +((lk + cm) / m.length / seg * 100).toFixed(2) : null,
    base_calculo: m.length,
    likes_medios: m.length ? Math.round(lk / m.length) : 0,
    coment_medios: m.length ? Math.round(cm / m.length) : 0,
    posts_30d: m.filter(x => ts(x) >= d30).length,
    posts_90d: m.filter(x => ts(x) >= d90).length,
    // se todos os posts da amostra caem na janela, o número é PISO e não contagem exata
    piso_30d: m.length > 0 && m.filter(x => ts(x) >= d30).length === m.length,
    ultimo_post: m.length ? m.map(x => x.timestamp).sort().pop().slice(0, 10) : null,
    posts: m.map(x => ({
      tipo: x.media_product_type === 'REELS' ? 'reels'
          : x.media_type === 'CAROUSEL_ALBUM' ? 'carrossel'
          : x.media_type === 'VIDEO' ? 'vídeo' : 'imagem',
      data: (x.timestamp || '').slice(0, 10),
      permalink: x.permalink,
      curtidas: x.like_count ?? null,
      comentarios: x.comments_count ?? null,
    })),
  };
}

// Toda busca vira snapshot no banco. Pesquisar alimenta a base — não é consulta descartável.
async function salvarSnapshot(p) {
  await pool.query(`
    INSERT INTO creator.perfil_snapshot
      (instagram_handle,coletado_em,seguidores,total_posts,posts_30d,posts_90d,
       engajamento_pct,likes_medios,coment_medios,base_calculo,ultimo_post,nome,bio,fonte,payload)
    VALUES ($1,current_date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'business_discovery',$13)
    ON CONFLICT (lower(instagram_handle),coletado_em) DO UPDATE SET
      seguidores=EXCLUDED.seguidores, total_posts=EXCLUDED.total_posts,
      posts_30d=EXCLUDED.posts_30d, posts_90d=EXCLUDED.posts_90d,
      engajamento_pct=EXCLUDED.engajamento_pct, likes_medios=EXCLUDED.likes_medios,
      coment_medios=EXCLUDED.coment_medios, base_calculo=EXCLUDED.base_calculo,
      ultimo_post=EXCLUDED.ultimo_post, nome=EXCLUDED.nome, bio=EXCLUDED.bio,
      payload=EXCLUDED.payload`,
    [p.handle, p.seguidores, p.total_posts, p.posts_30d, p.posts_90d, p.eng,
     p.likes_medios, p.coment_medios, p.base_calculo, p.ultimo_post, p.nome, p.bio, p]);
}

// O que essa pessoa já postou marcando a Cells (se já postou).
async function historicoCells(h) {
  const r = await pool.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE tipo='reels')::int reels,
           count(*) FILTER (WHERE tipo='carrossel')::int carrossel,
           count(*) FILTER (WHERE tipo='story')::int stories,
           count(*) FILTER (WHERE tipo IN ('feed_imagem','feed_video'))::int feed,
           max(publicado_em)::date ultima
    FROM creator.publicacao WHERE lower(instagram_handle)=lower($1)`, [h]);
  const c = await pool.query(
    `SELECT parceiro_id,status,nome FROM creator.parceiro WHERE lower(instagram_handle)=lower($1)`, [h]);
  return { ...r.rows[0], cadastrado: c.rows[0] || null };
}

// ---------------------------------------------------------------- páginas
const esc = s => String(s).replace(/[<>&"]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[m]));

const shell = (titulo, corpo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#fff;color:#14181A;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
.bx{border:1px solid #E2E7E6;border-radius:4px;padding:32px;width:min(390px,92vw)}
.lg{font-weight:680;font-size:20px;letter-spacing:-.025em;margin:0 0 5px}
.lg em{font-style:normal;color:#0B5FFF}
p{color:#6C7679;font-size:13px;margin:0 0 20px;line-height:1.55}
label{display:block;font-family:ui-monospace,Menlo,monospace;font-size:10px;font-weight:600;
letter-spacing:.11em;text-transform:uppercase;color:#8C9497;margin-bottom:7px}
input{width:100%;border:1px solid #E2E7E6;border-radius:3px;padding:10px 11px;font-size:14px;font-family:inherit}
input:focus{outline:2px solid #0B5FFF;outline-offset:1px;border-color:#0B5FFF}
button{width:100%;margin-top:14px;background:#14181A;color:#fff;border:none;border-radius:3px;
padding:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.er{background:#FBE9E6;color:#B23A2B;font-size:12.5px;padding:9px 11px;border-radius:3px;
margin-bottom:14px;font-weight:600}
.ft{margin-top:18px;font-size:11px;color:#98A0A2;line-height:1.55}
code{background:#F3F6F5;padding:2px 5px;border-radius:2px;font-size:12px;
font-family:ui-monospace,Menlo,monospace}</style></head><body>${corpo}</body></html>`;

const login = err => shell('Comunidade Cells', `<form class="bx" method="POST" autocomplete="off">
<div class="lg">comunidade <em>cells</em></div><p>Painel interno de creators. Acesso restrito.</p>
${err ? '<div class="er">Senha incorreta.</div>' : ''}
<label for="s">Senha</label>
<input id="s" name="senha" type="password" required autofocus aria-label="Senha de acesso">
<button type="submit">Entrar</button>
<div class="ft">Dado do Postgres + busca ao vivo na Graph API da Meta.</div></form>`);

const erroPg = m => shell('Comunidade Cells', `<div class="bx" style="border-left:3px solid #B23A2B">
<div class="lg">Não consegui ler o banco</div>
<p>O painel prefere parar a mostrar número velho sem avisar.</p>
<p><code>${esc(m)}</code></p>
<p class="ft">Confira <code>DATABASE_URL</code> no serviço. Dentro do Easypanel o host é o nome do
serviço Postgres, não o domínio externo.</p></div>`);

// ---------------------------------------------------------------- servidor
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (u.pathname === '/healthz') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }

  // ---- webhook da Meta (story mention) — ANTES da parede de senha, é a Meta que chama ----
  if (u.pathname === '/webhook/meta') {
    // handshake de verificação da assinatura
    if (req.method === 'GET') {
      const ok = u.searchParams.get('hub.mode') === 'subscribe' &&
                 u.searchParams.get('hub.verify_token') === VERIFY_TOKEN && VERIFY_TOKEN;
      if (ok) { res.writeHead(200, {'content-type':'text/plain'});
                return res.end(u.searchParams.get('hub.challenge') || ''); }
      res.writeHead(403, {'content-type':'text/plain'}); return res.end('verify_token inválido');
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    // Sem APP_SECRET não dá para provar que o POST veio da Meta. Um endpoint aberto que grava
    // no banco é um convite — então recusa em vez de aceitar dado não verificado.
    if (!APP_SECRET) {
      console.error('[webhook] META_APP_SECRET ausente — POST recusado');
      res.writeHead(503, {'content-type':'text/plain'});
      return res.end('META_APP_SECRET não configurado');
    }

    const chunks = [];
    req.on('data', c => { chunks.push(c); if (chunks.length > 400) req.destroy(); });
    return req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const esperado = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
      const veio = req.headers['x-hub-signature-256'] || '';
      const bateu = veio.length === esperado.length &&
        crypto.timingSafeEqual(Buffer.from(veio), Buffer.from(esperado));
      if (!bateu) {
        console.error('[webhook] assinatura inválida');
        res.writeHead(401, {'content-type':'text/plain'}); return res.end('assinatura inválida');
      }
      // Responder 200 rápido: a Meta re-entrega se demorar, e o download da mídia é lento.
      res.writeHead(200, {'content-type':'text/plain'}); res.end('ok');
      try {
        const body = JSON.parse(raw.toString('utf8'));
        const stories = J.extrairStories(body);
        for (const s of stories) await J.guardarStory(pool, s);
        if (stories.length) {
          console.log('[webhook] story mentions gravados:', stories.length);
          await J.logJob(pool, 'story', true, 'webhook', stories.length);
        }
      } catch (e) { console.error('[webhook]', e.message); J.logJob(pool, 'story', false, e.message, 0); }
    });
  }

  const autenticado = (req.headers.cookie || '').includes(`${COOKIE}=${TOKEN}`);

  if (req.method === 'POST' && u.pathname === '/') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 4096) req.destroy(); });
    return req.on('end', () => {
      if (new URLSearchParams(b).get('senha') === SENHA) {
        res.writeHead(303, { Location: '/', 'Set-Cookie':
          `${COOKIE}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
        return res.end();
      }
      res.writeHead(401, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(login(true));
    });
  }

  if (!autenticado) {
    if (u.pathname.startsWith('/api/')) return json(401, { erro: 'não autenticado' });
    res.writeHead(401, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    return res.end(login(false));
  }

  // ---- busca ao vivo ----
  if (u.pathname === '/api/buscar') {
    const h = u.searchParams.get('h') || '';
    if (!h.trim()) return json(400, { erro: 'informe um @' });
    try {
      const p = await buscarPerfil(h);
      let cells = null, aviso = null;
      try { cells = await historicoCells(p.handle); await salvarSnapshot(p); }
      catch (e) {
        // A busca continua útil sem o banco, mas o usuário precisa saber que não foi gravada —
        // senão parece que a base está crescendo quando não está.
        console.error('[snapshot]', e.message);
        aviso = 'consulta feita, mas não foi gravada no banco: ' + e.message;
      }
      return json(200, { ok: true, perfil: p, cells, aviso });
    } catch (e) {
      return json(200, { ok: false, erro: e.message });
    }
  }

  // ---------------- download de mídia (para virar anúncio) ----------------
  // Busca no CDN da Meta e devolve como anexo. Não guardamos o arquivo — a URL é renovada
  // pelo job do Apify, e vídeo em banco é peso morto.
  if (u.pathname === '/api/midia') {
    const pub = +u.searchParams.get('pub');
    const querVideo = u.searchParams.get('tipo') !== 'imagem';
    if (!pub) return json(400, { erro: 'publicacao ausente' });
    try {
      const r = await pool.query(`
        SELECT pu.instagram_handle, pu.tipo, pu.publicado_em,
               m.payload->>'videoUrl' AS video, m.payload->>'displayUrl' AS img,
               m.coletado_em
        FROM creator.publicacao pu
        JOIN LATERAL (SELECT payload, coletado_em FROM creator.publicacao_metrica pm
                      WHERE pm.publicacao_id=pu.publicacao_id AND pm.payload->>'displayUrl' IS NOT NULL
                      ORDER BY coletado_em DESC LIMIT 1) m ON true
        WHERE pu.publicacao_id=$1`, [pub]);
      const row = r.rows[0];
      if (!row) return json(404, { erro: 'sem mídia coletada para esta publicação' });
      const alvo = (querVideo && row.video) ? row.video : row.img;
      if (!alvo) return json(404, { erro: 'mídia indisponível' });

      const ext = alvo === row.video ? 'mp4' : 'jpg';
      const nome = `${row.instagram_handle}-${String(row.publicado_em).slice(0,10)}-${pub}.${ext}`;
      const up = await new Promise((ok, err) => {
        https.get(alvo, resp => ok(resp)).on('error', err).setTimeout(45000, function(){ this.destroy(new Error('timeout')); });
      });
      if (up.statusCode !== 200) {
        up.resume();
        // URL do CDN expira. Dizer isso é melhor que servir 0 bytes e o usuário achar que baixou.
        return json(410, { erro: 'a URL da mídia expirou no CDN da Meta (coletada em ' +
          String(row.coletado_em).slice(0,10) + '). Rode o job do Apify para renovar.' });
      }
      res.writeHead(200, {
        'content-type': up.headers['content-type'] || 'application/octet-stream',
        'content-disposition': `attachment; filename="${nome}"`,
        'cache-control': 'no-store',
      });
      return up.pipe(res);
    } catch (e) { return json(500, { erro: e.message }); }
  }

  // marca conteúdo como "virou anúncio" (bônus de R$300 do business case)
  if (u.pathname === '/api/publicacao' && req.method === 'POST') {
    const pub = +u.searchParams.get('pub');
    const v = u.searchParams.get('anuncio') === '1';
    if (!pub) return json(400, { erro: 'publicacao ausente' });
    try {
      const r = await pool.query(
        `UPDATE creator.publicacao SET virou_anuncio=$2, virou_anuncio_em = CASE WHEN $2 THEN now() ELSE NULL END
         WHERE publicacao_id=$1 RETURNING publicacao_id, virou_anuncio`, [pub, v]);
      cache.at = 0;
      return json(200, { ok: true, publicacao: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- ações de curadoria ----------------
  // POST /api/parceiro?id=1&acao=aprovar|reprovar|arquivar|desarquivar|tags
  if (u.pathname === '/api/parceiro' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    const acao = u.searchParams.get('acao');
    const por = (u.searchParams.get('por') || 'painel').slice(0, 60);
    const motivo = (u.searchParams.get('motivo') || '').slice(0, 400);
    const tags = (u.searchParams.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!id) return json(400, { erro: 'id ausente' });

    const acoes = {
      aprovar:     [`UPDATE creator.parceiro SET status='ativo', aprovado_em=now(), decidido_por=$2,
                       arquivado=false, reprovado_em=NULL, reprovado_motivo=NULL,
                       atualizado_em=now() WHERE parceiro_id=$1 RETURNING *`, [id, por]],
      reprovar:    [`UPDATE creator.parceiro SET status='reprovado', reprovado_em=now(),
                       reprovado_motivo=$3, decidido_por=$2, atualizado_em=now()
                       WHERE parceiro_id=$1 RETURNING *`, [id, por, motivo]],
      arquivar:    [`UPDATE creator.parceiro SET arquivado=true, arquivado_em=now(),
                       decidido_por=$2, atualizado_em=now() WHERE parceiro_id=$1 RETURNING *`, [id, por]],
      desarquivar: [`UPDATE creator.parceiro SET arquivado=false, arquivado_em=NULL,
                       atualizado_em=now() WHERE parceiro_id=$1 RETURNING *`, [id]],
      tags:        [`UPDATE creator.parceiro SET tags=$2, atualizado_em=now()
                       WHERE parceiro_id=$1 RETURNING *`, [id, tags.length ? tags : null]],
    };
    if (!acoes[acao]) return json(400, { erro: 'ação desconhecida' });
    try {
      const [sql, params] = acoes[acao];
      const r = await pool.query(sql, params);
      if (!r.rows[0]) return json(404, { erro: 'parceiro não encontrado' });
      cache.at = 0;                       // força recarga: a fila mudou
      return json(200, { ok: true, parceiro: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- envios ----------------
  if (u.pathname === '/api/envio' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    const envioId = +u.searchParams.get('envio_id');
    const g = k => u.searchParams.get(k) || null;
    try {
      if (envioId) {                      // atualizar status de um envio existente
        const st = g('status');
        const r = await pool.query(
          `UPDATE creator.envio SET status=coalesce($2,status), rastreio=coalesce($3,rastreio),
             enviado_em = CASE WHEN $2='postado'  THEN coalesce(enviado_em, now()) ELSE enviado_em END,
             entregue_em= CASE WHEN $2='entregue' THEN coalesce(entregue_em,now()) ELSE entregue_em END
           WHERE envio_id=$1 RETURNING *`, [envioId, st, g('rastreio')]);
        cache.at = 0;
        return json(200, { ok: true, envio: r.rows[0] });
      }
      if (!id) return json(400, { erro: 'id do parceiro ausente' });
      const r = await pool.query(
        `INSERT INTO creator.envio (parceiro_id,tipo,itens,valor,obs,criado_por)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, g('tipo') || 'kit_entrada', g('itens'), g('valor') || null, g('obs'),
         (g('por') || 'painel').slice(0, 60)]);
      // o custo entra na mesma hora — senão o budget do mês mente
      if (g('valor')) await pool.query(
        `INSERT INTO creator.custo (parceiro_id,competencia,tipo,valor,descricao,lancado_por)
         VALUES ($1, date_trunc('month',current_date)::date, $2, $3, $4, $5)`,
        [id, g('tipo') === 'seeding' ? 'seeding' : g('tipo') === 'premio' ? 'premio' : 'kit_entrada',
         g('valor'), g('itens'), (g('por') || 'painel').slice(0, 60)]);
      cache.at = 0;
      return json(200, { ok: true, envio: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // disparo manual de job (o agendador roda sozinho; isto é para não esperar o ciclo)
  if (u.pathname === '/api/job' && req.method === 'POST') {
    const nome = u.searchParams.get('n');
    const fns = { cadastros: () => J.syncCadastros(pool, META),
                  tags:  () => J.syncTags(pool, META),
                  perfis:() => J.syncPerfis(pool, META),
                  apify: () => J.syncApify(pool, APIFY) };
    if (!fns[nome]) return json(400, { erro: 'job desconhecido: use cadastros, tags, perfis ou apify' });
    try {
      const r = await fns[nome]();
      cache.at = 0;   // o job mexeu no banco — a próxima leitura tem que ser fresca
      await J.logJob(pool, nome, true, JSON.stringify(r), r.novas ?? r.atualizados ?? r.coletados ?? r.novos ?? 0);
      return json(200, { ok: true, job: nome, resultado: r });
    }
    catch (e) { await J.logJob(pool, nome, false, e.message, 0); return json(200, { ok: false, erro: e.message }); }
  }

  if (u.pathname === '/api/jobs') {
    const r = await pool.query(
      `SELECT job, sucesso, itens, detalhe, rodou_em FROM creator.job_log ORDER BY rodou_em DESC LIMIT 40`);
    return json(200, r.rows);
  }

  if (u.pathname === '/api/dados') {
    try { return json(200, await dados()); }
    catch (e) { return json(503, { erro: e.message }); }
  }

  if (u.pathname !== '/') { res.writeHead(404, {'content-type':'text/plain'}); return res.end('404'); }

  try {
    const d = await dados();
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'x-cc-cache': Math.round((Date.now() - cache.at) / 1000) + 's'});
    res.end(TPL.replace('__DATA__', JSON.stringify(d).replace(/</g, '\\u003c')));
  } catch (e) {
    res.writeHead(503, {'content-type':'text/html; charset=utf-8'});
    res.end(erroPg(e.message));
  }
}).listen(PORT, () => {
  console.log('comunidade-cells on :' + PORT + (META ? '' : '  [AVISO: META_TOKEN vazio — busca ao vivo desligada]'));
  recarregar().catch(e => console.error('[boot]', e.message));

  // Checagem de ESCRITA no boot. Em 06/08 o app subiu conectando como um usuário read-only:
  // a página funcionava, a busca funcionava, e todo job falhava em silêncio porque o erro
  // era engolido pelo try/catch. Ler não prova nada — o app precisa gravar.
  pool.query(`INSERT INTO creator.job_log (job,sucesso,detalhe) VALUES ('boot',true,$1)`,
             ['app subiu e consegue gravar'])
    .then(() => console.log('  [ok] escrita no Postgres confirmada'))
    .catch(e => console.error('  [FALHA GRAVE] o app NÃO consegue gravar no Postgres:', e.message,
                              '\n  Nenhum job vai funcionar. Confira o usuário em DATABASE_URL.'));

  J.agendar(pool, { META_TOKEN: META, APIFY_TOKEN: APIFY, onMudanca: () => { cache.at = 0; } });
  if (!APP_SECRET) console.log('  [aviso] META_APP_SECRET vazio — webhook de story recusa POST');
  setInterval(() => recarregar().catch(() => {}), Math.max(60000, TTL / 2)).unref();
});
