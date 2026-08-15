// Queries do painel. Tudo sai do schema `creator` — ver
// cells-skills-novo/4. canais/influencer/lp-creators/sql/
//
// Duas famílias:
//   PAINEL  — sem parâmetro, carregadas de uma vez e cacheadas. Alimentam o HTML.
//   ANALISE — com parâmetro (período e creator), rodadas sob demanda no /api/analise.
//
// REGRA: se um número não existe ainda (venda, clique, view), a query devolve NULL/0 e a tela
// mostra estado vazio. Nunca preencher com estimativa — foi decisão explícita.
//
// ⚠️ O QUE É "VIEWS" AQUI (corrigido em 10/08/2026)
// A tabela guarda DOIS contadores de vídeo, e eles não são a mesma coisa:
//   visualizacoes = videoViewCount do Apify = video_view_count do Instagram. É a métrica ANTIGA
//                   (view de 3s do player de vídeo de feed). Para reels o Instagram praticamente
//                   parou de alimentá-la — sobra um resíduo minúsculo.
//   reproducoes   = videoPlayCount = plays, com replay. É o que o Instagram chama de "views"
//                   hoje, e é o número que o creator vê no app.
// O painel mostrava a coluna errada. No reel do @drjrcalhau isso era 125 contra 2.349 — 19x.
// Nos 101 reels medidos, plays > views em 101 de 101, com fator de 2,5x a 64x: não é escala,
// é outra métrica. Por isso a leitura correta é coalesce(reproducoes, visualizacoes) em TODO
// lugar que a palavra "views" chega na tela.

// ------------------------------------------------------------------ PAINEL
const painel = {

  // ---- topo: os números que resumem o canal ----
  resumo: `
    SELECT
      (SELECT count(*) FROM creator.publicacao)                                 AS publicacoes,
      (SELECT count(DISTINCT lower(instagram_handle)) FROM creator.publicacao)  AS perfis,
      (SELECT count(*) FROM creator.parceiro)                                   AS cadastrados,
      (SELECT count(*) FROM creator.parceiro WHERE status='ativo')              AS ativos,
      (SELECT count(*) FROM creator.parceiro WHERE status='pendente' AND NOT arquivado) AS pendentes,
      -- ⚠️ vw_venda_valida, não creator.venda: a tabela crua tem pedido cancelado,
      -- reembolsado, pending e o cupom fantasma DRCARLOS. Em 15/08 a diferença era
      -- 122 → 87 pedidos e R$ 19.699,85 → R$ 15.651,62. O rodapé é o número que o Gabriel
      -- lê de relance; ele não pode discordar da tela de Apuração logo abaixo.
      (SELECT count(*) FROM creator.vw_venda_valida)                            AS vendas,
      (SELECT round(sum(receita_liquida),2) FROM creator.vw_venda_valida)       AS receita,
      (SELECT count(*) FROM creator.cupom WHERE ativo)                          AS cupons,
      (SELECT min(publicado_em)::date FROM creator.publicacao)                  AS desde,
      (SELECT max(publicado_em)::date FROM creator.publicacao)                  AS ate
  `,

  // ---- CADASTROS: candidato + métrica do perfil na mesma linha ----
  // É a tela que o Gabriel abre de manhã. Tudo que decide o status tem que estar aqui,
  // sem precisar abrir o Instagram de ninguém.
  cadastros: `
    -- ⚠️ Tráfego que não atribui a ninguém: o link da pessoa já circula (o utm_slug nasce no
    -- cadastro), mas sem cupom ativo a venda que vier dele não gruda em ninguém. Hoje é 1
    -- caso — Solange Müller, 7 cliques, pendente desde sempre — e ele estava enterrado num
    -- .md em vez de aparecer na tela de quem decide.
    -- (Sem crase neste comentário: crase aqui dentro FECHA o template literal do JS.)
    --
    -- ⚠️ CTE, não subconsulta correlacionada. Escrito como subconsulta por linha, isto sozinho
    -- levou a query de 45ms para 8s — creator.vw_clique_dia varre web.sessions com join OR, e
    -- rodava uma vez POR CADASTRO. Medido antes de subir; é a mesma armadilha que fez o portal
    -- da creator levar 15s em 14/08.
    WITH orfaos AS (
      SELECT k.parceiro_id, sum(k.cliques)::int AS cliques
        FROM creator.vw_clique_dia k
       WHERE NOT EXISTS (SELECT 1 FROM creator.cupom c2
                          WHERE c2.parceiro_id = k.parceiro_id AND c2.ativo)
       GROUP BY 1
    )
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.email, p.telefone_e164,
           p.status, p.arquivado, p.tags, p.utm_slug, p.criado_em::date AS cadastro,
           p.aprovado_em::date AS aprovado, p.reprovado_motivo, p.decidido_por,
           p.atualizado_em,
           s.seguidores, s.engajamento_pct, s.posts_30d, s.ultimo_post, s.bio,
           (s.fonte = 'indisponivel') AS perfil_indisponivel,
           (SELECT count(*) FROM creator.publicacao u
            WHERE lower(u.instagram_handle)=lower(p.instagram_handle))::int AS marcacoes,
           v.views_marc, v.reels_medidos,
           CASE WHEN s.seguidores > 0 AND v.views_marc > 0
                THEN round(v.views_marc::numeric / s.seguidores, 2) END AS vps,
           (SELECT count(*) FROM creator.envio e WHERE e.parceiro_id=p.parceiro_id)::int AS envios,
           coalesce(orf.cliques, 0) AS cliques_orfaos,
           (SELECT c.codigo FROM creator.cupom c
             WHERE c.parceiro_id=p.parceiro_id AND c.ativo ORDER BY c.cupom_id LIMIT 1) AS cupom,
           (SELECT count(*) FROM creator.vw_venda_valida vn
             WHERE vn.parceiro_id=p.parceiro_id)::int AS pedidos,
           (SELECT round(sum(vn.receita_liquida),2) FROM creator.vw_venda_valida vn
             WHERE vn.parceiro_id=p.parceiro_id) AS receita,
           -- ⚠️ Estar ATIVO não quer dizer que a pessoa foi avisada. Os 28 que vieram do cupom
           -- legado nasceram ativos e com cupom sem nunca receber um e-mail. Sem esta coluna a
           -- tela mostra os dois casos igual — e foi exatamente o que confundiu em 08/08.
           -- (sem crase neste comentário: o SQL mora em template literal e crase encerra a string)
           EXISTS (SELECT 1 FROM creator.email_log el
                    WHERE el.parceiro_id=p.parceiro_id AND el.tipo='aprovacao'
                      AND el.estado='evento_enviado') AS avisado,
           -- ⚠️ APROVAÇÃO E STATUS SÃO COISAS DIFERENTES (13/08). Os 27 que vieram do cupom
           -- legado nasceram 'ativo' com aprovado_em NULL: nunca passaram por curadoria.
           -- Decisão do Gabriel: todos precisam ser aprovados, MENOS os 5 que venderam em 2026,
           -- carimbados com aprovado_por='mantido_2026'. O cupom continua vivo no meio disso.
           (p.status='ativo' AND p.aprovado_em IS NULL) AS reaprovar,
           (p.aprovado_por = 'mantido_2026')            AS mantido,
           -- ---- o que a PESSOA declarou no formulário (item 1: pesquisa por nicho/idade) ----
           -- Nunca inferido: se ela não respondeu, fica null e a tela mostra vazio.
           ld.nichos, ld.idade, ld.sexo, ld.cidade, ld.cor_etnia,
           ld.seguidores_instagram AS seg_declarado, ld.modelo_trabalho, ld.vendas_mes,
           left(coalesce(ld.motivacao,''), 400) AS motivacao,
           -- item 3: o @ vira link. A URL vem do formulário; quando não veio (cupom legado),
           -- monta a partir do handle — que é o mesmo caminho que o Instagram usa.
           coalesce(ld.instagram_url,
                    CASE WHEN p.instagram_handle IS NOT NULL
                         THEN 'https://instagram.com/' || p.instagram_handle END) AS instagram_url,
           -- ---- nível e comissão (item 9) ----
           nv.nivel, nv.nivel_forcado, nv.receita_3m, nv.pedidos_3m,
           nv.comissao_unica_pct, nv.comissao_assinatura_pct,
           nv.proximo_nivel, nv.falta_para_proximo,
           -- pastas (item 7): lista fechada e montável, ao contrário de tags, que é texto
           -- livre. As duas convivem — tag é anotação solta, pasta é classificação.
           -- (sem crase neste comentário: o SQL mora em template literal e crase encerra a string)
           (SELECT coalesce(json_agg(json_build_object('pasta_id', pa.pasta_id, 'nome', pa.nome)
                                     ORDER BY pa.ordem, pa.nome), '[]'::json)
              FROM creator.parceiro_pasta pp
              JOIN creator.pasta pa ON pa.pasta_id = pp.pasta_id
             WHERE pp.parceiro_id = p.parceiro_id) AS pastas
    FROM creator.parceiro p
    LEFT JOIN creator.leads    ld ON ld.lead_id     = p.lead_id
    LEFT JOIN creator.vw_nivel nv ON nv.parceiro_id = p.parceiro_id
    LEFT JOIN orfaos           orf ON orf.parceiro_id = p.parceiro_id
    LEFT JOIN LATERAL (
      SELECT seguidores, engajamento_pct, posts_30d, ultimo_post, bio, fonte
      FROM creator.perfil_snapshot ps
      WHERE lower(ps.instagram_handle)=lower(p.instagram_handle)
      ORDER BY (fonte <> 'indisponivel') DESC, coletado_em DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT sum(x.v) AS views_marc, count(*) FILTER (WHERE x.v IS NOT NULL)::int AS reels_medidos
      FROM creator.publicacao u
      JOIN LATERAL (SELECT coalesce(max(reproducoes), max(visualizacoes)) v
                    FROM creator.publicacao_metrica m
                    WHERE m.publicacao_id=u.publicacao_id) x ON true
      WHERE lower(u.instagram_handle)=lower(p.instagram_handle)
    ) v ON true
    -- origem 'fundido' = linha de cupom que virou uma só com um cadastro que já existia.
    -- Cupom e vendas foram movidos; a casca fica como trilha e não aparece em tela nenhuma.
    WHERE p.origem IS DISTINCT FROM 'fundido'
    ORDER BY p.criado_em DESC
  `,

  // ---- envios, para a ficha do cadastro ----
  envios: `
    SELECT e.envio_id, e.parceiro_id, e.tipo, e.itens, e.valor, e.status, e.rastreio,
           e.solicitado_em::date AS solicitado
    FROM creator.envio e ORDER BY e.solicitado_em DESC LIMIT 300
  `,

  // ---- publicações por parceiro, para a ficha ----
  fichaPubs: `
    SELECT u.parceiro_id, u.tipo, u.publicado_em::date AS data,
           u.permalink, left(coalesce(u.legenda,''),140) AS legenda,
           m.curtidas, m.comentarios, m.visualizacoes
    FROM creator.publicacao u
    LEFT JOIN LATERAL (
      SELECT max(curtidas) curtidas, max(comentarios) comentarios,
             coalesce(max(reproducoes), max(visualizacoes)) visualizacoes
      FROM creator.publicacao_metrica pm WHERE pm.publicacao_id=u.publicacao_id
    ) m ON true
    WHERE u.parceiro_id IS NOT NULL
    ORDER BY u.publicado_em DESC
  `,

  // ---- CAMPANHAS: uma linha por campanha, já com resultado ----
  campanhas: `
    SELECT c.*,
           (SELECT json_agg(json_build_object(
                     'acao', m.tipo_conteudo, 'pontos', m.pontos, 'meta', m.meta_qtd)
                     ORDER BY m.ordem, m.missao_id)
              FROM creator.jogo j JOIN creator.missao m ON m.jogo_id=j.jogo_id
             WHERE j.campanha_id=c.campanha_id AND j.ativo) AS acoes,
           (SELECT json_agg(json_build_object(
                     'parceiro_id', p.parceiro_id, 'nome', p.nome,
                     'handle', p.instagram_handle) ORDER BY p.nome)
              FROM creator.campanha_parceiro cp
              JOIN creator.parceiro p ON p.parceiro_id=cp.parceiro_id
             WHERE cp.campanha_id=c.campanha_id AND cp.saiu_em IS NULL) AS participantes,
           -- anexos (item 4). A coluna conteudo NUNCA sai daqui: sao ate 10 MB por arquivo e este
           -- resultado vai serializado dentro do HTML do painel. So metadado; o arquivo vem
           -- pela rota de download, que confere o vinculo com a campanha.
           -- (sem crase neste comentario: o SQL mora em template literal)
           coalesce((SELECT json_agg(json_build_object(
                       'anexo_id', x.anexo_id, 'nome', x.nome, 'mime', x.mime,
                       'bytes', x.bytes, 'baixados', x.baixados) ORDER BY x.criado_em)
                       FROM creator.campanha_anexo x
                      WHERE x.campanha_id = c.campanha_id), '[]'::json) AS anexos
    FROM creator.vw_campanha_resultado c
    ORDER BY (c.status='ativa') DESC, c.inicio DESC
  `,

  // ---- placar por creator dentro de cada campanha de pontuação ----
  placar: `
    SELECT campanha_id, parceiro_id, nome, instagram_handle,
           sum(pontos_unitarios * feito)::int AS pontos,
           sum(feito)::int AS entregas,
           string_agg(tipo_conteudo || ' ' || feito, ' · ' ORDER BY tipo_conteudo) AS detalhe
    FROM creator.vw_pontuacao
    GROUP BY 1,2,3,4
    HAVING sum(feito) > 0
    ORDER BY 5 DESC
  `,

  // ---- MENÇÕES: todo conteúdo com mídia coletada ----
  // A URL de mídia vem do payload do Apify e EXPIRA. Não guardamos o arquivo: o job semanal
  // renova a URL, e o vídeo é servido na hora pelo /api/midia. Guardar em bytea inflaria o banco.
  mencoes: `
    SELECT u.publicacao_id, u.instagram_handle, u.tipo, u.publicado_em::date AS data,
           u.permalink, left(coalesce(u.legenda,''),240) AS legenda,
           u.parceiro_id, p.nome AS parceiro, u.parceria_paga, u.virou_anuncio,
           m.curtidas, m.comentarios,
           -- "views" na tela = plays. Ver a nota no topo do arquivo.
           coalesce(m.reproducoes, m.visualizacoes) AS visualizacoes,
           m.reproducoes, m.visualizacoes AS views_legado,
           -- a URL do CDN não vai para o browser: ele não consegue carregá-la (CORP) e ela
           -- ainda inflaria o HTML em ~100 URLs longas. A capa vem por /api/midia?tipo=capa.
           (m.payload->>'displayUrl' IS NOT NULL OR md.thumb_bytes IS NOT NULL) AS tem_capa,
           (m.payload->>'videoUrl' IS NOT NULL) AS tem_video,
           md.bytes IS NOT NULL AS tem_arquivo, md.tamanho, md.erro AS erro_midia,
           m.coletado_em::date AS midia_de
    FROM creator.publicacao u
    LEFT JOIN creator.parceiro p ON p.parceiro_id = u.parceiro_id
    LEFT JOIN creator.publicacao_midia md ON md.publicacao_id = u.publicacao_id
    LEFT JOIN LATERAL (
      SELECT curtidas, comentarios, visualizacoes, reproducoes, payload, coletado_em
      FROM creator.publicacao_metrica pm
      WHERE pm.publicacao_id = u.publicacao_id AND pm.payload->>'displayUrl' IS NOT NULL
      ORDER BY coletado_em DESC LIMIT 1
    ) m ON true
    WHERE m.payload IS NOT NULL
    ORDER BY u.publicado_em DESC
    LIMIT 300
  `,

  // ---- lista de creators para o seletor das Análises ----
  // Sem parâmetro de propósito: o seletor não pode encolher junto com o período escolhido,
  // senão filtrar por data faz o creator sumir da lista antes de você poder escolhê-lo.
  // A chave repete a regra do bloco ANALISE: handle quando existe, `id:` quando não.
  opcoes: `
    WITH hs AS (
      SELECT DISTINCT lower(instagram_handle) AS chave, NULL::bigint AS parceiro_id
        FROM creator.publicacao WHERE instagram_handle IS NOT NULL
      UNION
      SELECT DISTINCT coalesce(lower(instagram_handle), 'id:' || parceiro_id), parceiro_id
        FROM creator.parceiro
    )
    SELECT hs.chave,
           CASE WHEN hs.chave LIKE 'id:%' THEN NULL ELSE hs.chave END AS handle,
           (SELECT p.nome FROM creator.parceiro p
             WHERE coalesce(lower(p.instagram_handle),'id:'||p.parceiro_id) = hs.chave
             ORDER BY p.parceiro_id LIMIT 1) AS nome,
           (SELECT count(*) FROM creator.publicacao u
             WHERE lower(u.instagram_handle) = hs.chave)::int AS marcacoes,
           (SELECT count(*) FROM creator.vw_venda_valida v
             JOIN creator.parceiro p2 ON p2.parceiro_id = v.parceiro_id
            WHERE coalesce(lower(p2.instagram_handle),'id:'||p2.parceiro_id) = hs.chave)::int AS pedidos
    FROM (SELECT DISTINCT chave FROM hs) hs
    ORDER BY 4 DESC, 5 DESC, 1
  `,

  // ---- candidatos para casar um cupom com uma pessoa ----
  // Todo handle que a Cells conhece: quem marcou e quem se cadastrou. A tela ranqueia por
  // parecença com o código do cupom — o ranking é sugestão, quem decide é o humano.
  candidatos: `
    WITH hs AS (
      SELECT DISTINCT lower(instagram_handle) AS h FROM creator.publicacao
       WHERE instagram_handle IS NOT NULL
      UNION
      SELECT DISTINCT lower(instagram_handle) FROM creator.parceiro
       WHERE instagram_handle IS NOT NULL
    )
    SELECT hs.h AS handle,
           coalesce(
             (SELECT p.nome FROM creator.parceiro p
               WHERE lower(p.instagram_handle)=hs.h ORDER BY p.parceiro_id LIMIT 1),
             (SELECT s.nome FROM creator.perfil_snapshot s
               WHERE lower(s.instagram_handle)=hs.h AND s.nome IS NOT NULL
               ORDER BY s.coletado_em DESC LIMIT 1)) AS nome,
           (SELECT count(*) FROM creator.publicacao u
             WHERE lower(u.instagram_handle)=hs.h)::int AS marcacoes,
           (SELECT max(u.publicado_em)::date FROM creator.publicacao u
             WHERE lower(u.instagram_handle)=hs.h) AS ultima,
           EXISTS (SELECT 1 FROM creator.parceiro p
                    WHERE lower(p.instagram_handle)=hs.h) AS ja_cadastrado
    FROM hs ORDER BY 3 DESC, 1
  `,

  // ---- LEGADO: o inventário de cupons da loja ----
  // Separado do programa de propósito. Aqui mora tudo que já existiu, inclusive o cupom que
  // foi criado e nunca vendeu — que é o número que ninguém olhava.
  legado: `SELECT * FROM creator.vw_legado`,

  // ---- e-mails de aprovação, para a ficha ----
  emails: `
    SELECT parceiro_id, para, tipo, estado, detalhe, criado_em
    FROM creator.email_log ORDER BY criado_em DESC LIMIT 300
  `,

  // ---- cupom por parceiro, com o estado na Shopify ----
  cupons: `
    SELECT c.cupom_id, c.parceiro_id, c.codigo, c.desconto_pct, c.comissao_pct, c.combinavel,
           c.shopify_discount_id, c.shopify_erro, c.link_redirect_id, c.ativo,
           c.criado_em::date AS criado
    FROM creator.cupom c WHERE c.ativo ORDER BY c.cupom_id
  `,

  // ---- faixas e comissão, para a tela mostrar a régua ----
  // Vem do banco e não do código: mudar corte ou percentual é UPDATE em
  // creator.nivel_faixa / creator.nivel_regra, sem deploy.
  niveis: `
    SELECT f.nivel, f.ordem, f.piso, f.rotulo,
           max(r.comissao_pct) FILTER (WHERE r.tipo_pedido='unica')      AS unica_pct,
           max(r.comissao_pct) FILTER (WHERE r.tipo_pedido='assinatura') AS assinatura_pct,
           (SELECT count(*) FROM creator.vw_nivel v
             WHERE v.nivel = f.nivel AND v.status='ativo')::int          AS creators
    FROM creator.nivel_faixa f
    LEFT JOIN creator.nivel_regra r ON r.nivel = f.nivel
    GROUP BY 1,2,3,4 ORDER BY f.ordem
  `,

  // ---- pastas, com quanta gente tem em cada ----
  pastas: `
    SELECT pa.pasta_id, pa.nome, pa.cor, pa.ordem,
           (SELECT count(*)::int FROM creator.parceiro_pasta pp
             WHERE pp.pasta_id = pa.pasta_id) AS creators
    FROM creator.pasta pa ORDER BY pa.ordem, pa.nome
  `,

  // ---- saúde dos jobs de coleta (vai para o rodapé do menu) ----
  jobs: `
    SELECT DISTINCT ON (job) job, sucesso, itens, rodou_em
    FROM creator.job_log WHERE job <> 'boot' ORDER BY job, rodou_em DESC
  `,
};

// ------------------------------------------------------------------ ANÁLISE
// Parâmetros em TODAS: $1 = de (date), $2 = ate (date), $3 = chave do creator ou ''.
//
// ⚠️ A CHAVE NÃO É SÓ O HANDLE. São duas populações que quase não se cruzam:
//   - quem MARCA a Cells no Instagram: existe por handle, muitos sem cadastro nenhum;
//   - quem VENDE por cupom nominal: 145 pessoas importadas do legado, TODAS com
//     `instagram_handle` nulo — nome no cupom, sem Instagram associado.
// Chavear só por handle jogaria os 237 pedidos e os R$ 38.883 num balde "null". Por isso a
// chave é o handle quando existe e `id:<parceiro_id>` quando não existe.
//
// ⚠️ publicacao_metrica tem MAIS DE UMA linha por publicação — uma por dia de coleta e uma por
// fonte. Somar a tabela direto multiplica tudo. O LATERAL colapsa para um valor por publicação
// ANTES de somar; max() porque contador de rede só cresce.
const CHAVE = `coalesce(lower(p.instagram_handle), 'id:' || p.parceiro_id)`;

const PUB = `
  SELECT lower(u.instagram_handle) AS ch, u.tipo, u.publicado_em::date AS dia,
         x.curtidas, x.comentarios, x.visualizacoes
  FROM creator.publicacao u
  JOIN LATERAL (SELECT max(curtidas) AS curtidas, max(comentarios) AS comentarios,
                       coalesce(max(reproducoes), max(visualizacoes)) AS visualizacoes
                FROM creator.publicacao_metrica m WHERE m.publicacao_id=u.publicacao_id) x ON true
  WHERE u.publicado_em::date BETWEEN $1 AND $2
    AND ($3 = '' OR lower(u.instagram_handle) = $3)`;

const VEN = `
  SELECT ${CHAVE} AS ch, v.pedido_em::date AS dia, v.receita_liquida, v.cliente_novo
  FROM creator.vw_venda_valida v
  JOIN creator.parceiro p ON p.parceiro_id = v.parceiro_id
  WHERE v.pedido_em::date BETWEEN $1 AND $2
    AND ($3 = '' OR ${CHAVE} = $3)`;

const CLQ = `
  SELECT ${CHAVE} AS ch, c.dia, c.cliques, c.sessoes
  FROM creator.vw_clique_dia c
  JOIN creator.parceiro p ON p.parceiro_id = c.parceiro_id
  WHERE c.dia BETWEEN $1 AND $2 AND ($3 = '' OR ${CHAVE} = $3)`;

const analise = {

  // uma linha só, com tudo que o topo da tela mostra
  geral: `
    WITH pub AS (${PUB}), ven AS (${VEN}), clq AS (${CLQ})
    SELECT
      (SELECT count(*)                                              FROM pub)::int AS marcacoes,
      (SELECT count(DISTINCT ch)                                    FROM pub)::int AS perfis,
      (SELECT count(*) FILTER (WHERE tipo='reels')                  FROM pub)::int AS reels,
      (SELECT count(*) FILTER (WHERE tipo='carrossel')              FROM pub)::int AS carrossel,
      (SELECT count(*) FILTER (WHERE tipo IN ('feed_imagem','feed_video')) FROM pub)::int AS feed,
      (SELECT count(*) FILTER (WHERE tipo='story')                  FROM pub)::int AS stories,
      (SELECT sum(curtidas)                                         FROM pub)::int AS curtidas,
      (SELECT sum(comentarios)                                      FROM pub)::int AS comentarios,
      (SELECT sum(visualizacoes)                                    FROM pub)::int AS views,
      (SELECT count(*) FILTER (WHERE visualizacoes IS NOT NULL)     FROM pub)::int AS reels_medidos,
      (SELECT count(*)                                              FROM ven)::int AS pedidos,
      (SELECT round(sum(receita_liquida),2)                         FROM ven)      AS receita,
      (SELECT round(avg(receita_liquida),2)                         FROM ven)      AS ticket,
      (SELECT count(*) FILTER (WHERE cliente_novo)                  FROM ven)::int AS clientes_novos,
      (SELECT count(DISTINCT ch)                                    FROM ven)::int AS creators_que_venderam,
      (SELECT coalesce(sum(cliques),0)                              FROM clq)::int AS cliques,
      (SELECT coalesce(sum(sessoes),0)                              FROM clq)::int AS sessoes
  `,

  // ranking por creator — quem marcou, quem vendeu, quem trouxe clique
  porCreator: `
    WITH pub AS (${PUB}), ven AS (${VEN}), clq AS (${CLQ}),
    a AS (SELECT ch, count(*)::int marcacoes,
                 count(*) FILTER (WHERE tipo='reels')::int reels,
                 count(*) FILTER (WHERE tipo='carrossel')::int carrossel,
                 count(*) FILTER (WHERE tipo IN ('feed_imagem','feed_video'))::int feed,
                 count(*) FILTER (WHERE tipo='story')::int stories,
                 sum(curtidas)::int curtidas, sum(comentarios)::int comentarios,
                 sum(visualizacoes)::int views, max(dia) ultima
            FROM pub GROUP BY 1),
    b AS (SELECT ch, count(*)::int pedidos, round(sum(receita_liquida),2) receita,
                 count(*) FILTER (WHERE cliente_novo)::int clientes_novos
            FROM ven GROUP BY 1),
    c AS (SELECT ch, sum(cliques)::int cliques FROM clq GROUP BY 1),
    hs AS (SELECT ch FROM a UNION SELECT ch FROM b UNION SELECT ch FROM c)
    SELECT hs.ch AS chave,
           CASE WHEN hs.ch LIKE 'id:%' THEN NULL ELSE hs.ch END AS handle,
           p.parceiro_id, p.nome, p.status,
           coalesce(a.marcacoes,0) AS marcacoes, coalesce(a.reels,0) AS reels,
           coalesce(a.carrossel,0) AS carrossel, coalesce(a.feed,0) AS feed,
           coalesce(a.stories,0) AS stories,
           a.curtidas, a.comentarios, a.views, a.ultima,
           coalesce(b.pedidos,0) AS pedidos, b.receita, coalesce(b.clientes_novos,0) AS clientes_novos,
           coalesce(c.cliques,0) AS cliques,
           s.seguidores, s.engajamento_pct
    FROM hs
    LEFT JOIN a ON a.ch=hs.ch LEFT JOIN b ON b.ch=hs.ch LEFT JOIN c ON c.ch=hs.ch
    LEFT JOIN creator.parceiro p
           ON coalesce(lower(p.instagram_handle), 'id:' || p.parceiro_id) = hs.ch
    LEFT JOIN LATERAL (
      SELECT seguidores, engajamento_pct FROM creator.perfil_snapshot ps
      WHERE lower(ps.instagram_handle)=hs.ch AND ps.fonte <> 'indisponivel'
      ORDER BY coletado_em DESC LIMIT 1) s ON true
    ORDER BY coalesce(b.receita,0) DESC, coalesce(a.marcacoes,0) DESC
  `,

  // série mensal, para o gráfico
  serie: `
    WITH pub AS (${PUB}), ven AS (${VEN}), clq AS (${CLQ}),
    m AS (SELECT to_char(dia,'YYYY-MM') mes, count(*)::int marcacoes FROM pub GROUP BY 1),
    v AS (SELECT to_char(dia,'YYYY-MM') mes, count(*)::int pedidos,
                 round(sum(receita_liquida),2) receita FROM ven GROUP BY 1),
    c AS (SELECT to_char(dia,'YYYY-MM') mes, sum(cliques)::int cliques FROM clq GROUP BY 1),
    ms AS (SELECT mes FROM m UNION SELECT mes FROM v UNION SELECT mes FROM c)
    SELECT ms.mes, coalesce(m.marcacoes,0) AS marcacoes, coalesce(v.pedidos,0) AS pedidos,
           coalesce(v.receita,0) AS receita, coalesce(c.cliques,0) AS cliques
    FROM ms LEFT JOIN m ON m.mes=ms.mes LEFT JOIN v ON v.mes=ms.mes LEFT JOIN c ON c.mes=ms.mes
    ORDER BY 1
  `,

};

module.exports = { painel, analise };
