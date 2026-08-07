// Queries do painel. Tudo sai do schema `creator` — ver
// cells-skills-novo/4. canais/influencer/lp-creators/sql/2026-08-05-schema-gestao-creators.sql
//
// REGRA: se um número não existe ainda (venda, clique, view), a query devolve NULL/0 e o
// template mostra estado vazio. Nunca preencher com estimativa — foi decisão explícita.

module.exports = {

  // ---- topo: os números que resumem o canal ----
  resumo: `
    SELECT
      (SELECT count(*) FROM creator.publicacao)                                 AS publicacoes,
      (SELECT count(DISTINCT lower(instagram_handle)) FROM creator.publicacao)  AS perfis,
      (SELECT count(*) FROM creator.parceiro)                                   AS cadastrados,
      (SELECT count(*) FROM creator.parceiro WHERE status='ativo')              AS ativos,
      (SELECT count(*) FROM creator.parceiro p
         WHERE EXISTS (SELECT 1 FROM creator.publicacao u
                       WHERE lower(u.instagram_handle)=lower(p.instagram_handle))) AS cadastrados_que_marcam,
      (SELECT count(*) FROM creator.venda)                                      AS vendas,
      (SELECT count(*) FROM creator.cupom WHERE ativo)                          AS cupons,
      (SELECT min(publicado_em)::date FROM creator.publicacao)                  AS desde,
      (SELECT max(publicado_em)::date FROM creator.publicacao)                  AS ate
  `,

  // ---- a base de perfis, com o último snapshot de cada um ----
  // DISTINCT ON pega a foto mais recente por handle; o LEFT JOIN traz o que a pessoa já postou.
  perfis: `
    WITH snap AS (
      SELECT DISTINCT ON (lower(instagram_handle))
             lower(instagram_handle) AS h, nome, bio, seguidores, total_posts,
             posts_30d, posts_90d, engajamento_pct, likes_medios, coment_medios,
             base_calculo, ultimo_post, coletado_em
      FROM creator.perfil_snapshot
      ORDER BY lower(instagram_handle), coletado_em DESC
    ),
    pub AS (
      SELECT lower(instagram_handle) AS h,
             count(*)                                    AS marcacoes,
             count(*) FILTER (WHERE tipo='reels')        AS reels,
             count(*) FILTER (WHERE tipo='carrossel')    AS carrossel,
             count(*) FILTER (WHERE tipo='story')        AS stories,
             count(*) FILTER (WHERE tipo IN ('feed_imagem','feed_video')) AS feed,
             max(publicado_em)::date                     AS ultima_marcacao
      FROM creator.publicacao GROUP BY 1
    ),
    -- ATENÇÃO: existe MAIS DE UMA linha de métrica por publicação — uma por dia de coleta e uma
    -- por fonte (tags_api e apify). Somar a tabela direto multiplica tudo. O LATERAL colapsa
    -- para um valor por publicação ANTES de somar; max() porque contador de rede só cresce,
    -- então o maior já observado é o melhor que temos.
    met AS (
      SELECT lower(u.instagram_handle) AS h,
             sum(x.curtidas)      AS curtidas_marc,
             sum(x.comentarios)   AS coment_marc,
             sum(x.visualizacoes) AS views_marc,
             sum(x.reproducoes)   AS plays_marc,
             count(*) FILTER (WHERE x.visualizacoes IS NOT NULL) AS reels_medidos,
             round(avg(x.visualizacoes) FILTER (WHERE x.visualizacoes IS NOT NULL)) AS media_por_reel
      FROM creator.publicacao u
      JOIN LATERAL (
        SELECT max(curtidas) AS curtidas, max(comentarios) AS comentarios,
               max(visualizacoes) AS visualizacoes, max(reproducoes) AS reproducoes
        FROM creator.publicacao_metrica m WHERE m.publicacao_id = u.publicacao_id
      ) x ON true
      GROUP BY 1
    )
    SELECT
      COALESCE(s.h, p.h)                       AS handle,
      s.nome, s.bio, s.seguidores, s.total_posts,
      s.posts_30d, s.posts_90d, s.engajamento_pct,
      s.likes_medios, s.coment_medios, s.base_calculo, s.ultimo_post,
      COALESCE(p.marcacoes,0) AS marcacoes,
      COALESCE(p.reels,0) AS reels, COALESCE(p.carrossel,0) AS carrossel,
      COALESCE(p.stories,0) AS stories, COALESCE(p.feed,0) AS feed,
      p.ultima_marcacao,
      m.curtidas_marc, m.coment_marc, m.views_marc, m.plays_marc,
      m.reels_medidos, m.media_por_reel,
      pa.parceiro_id, pa.status AS status_parceiro, pa.nome AS nome_cadastro
    FROM snap s
    FULL OUTER JOIN pub p ON p.h = s.h
    LEFT JOIN met m       ON m.h = COALESCE(s.h, p.h)
    LEFT JOIN creator.parceiro pa ON lower(pa.instagram_handle) = COALESCE(s.h, p.h)
    ORDER BY s.engajamento_pct DESC NULLS LAST
  `,

  // ---- FILA DE CURADORIA: candidato + métrica do perfil na mesma linha ----
  // É a tela que o Gabriel abre de manhã. Tudo que decide aprovar tem que estar aqui,
  // sem precisar abrir o Instagram de ninguém.
  fila: `
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.email, p.telefone_e164,
           p.status, p.arquivado, p.tags, p.criado_em::date AS cadastro,
           p.aprovado_em::date AS aprovado, p.reprovado_motivo, p.decidido_por,
           s.seguidores, s.engajamento_pct, s.posts_30d, s.ultimo_post, s.bio,
           (s.fonte = 'indisponivel') AS perfil_indisponivel,
           EXISTS (SELECT 1 FROM creator.publicacao u
                   WHERE lower(u.instagram_handle)=lower(p.instagram_handle)) AS ja_marcou,
           (SELECT count(*) FROM creator.publicacao u
            WHERE lower(u.instagram_handle)=lower(p.instagram_handle))::int AS marcacoes,
           v.views_marc, v.reels_medidos,
           CASE WHEN s.seguidores > 0 AND v.views_marc > 0
                THEN round(v.views_marc::numeric / s.seguidores, 2) END AS vps,
           (SELECT count(*) FROM creator.envio e WHERE e.parceiro_id=p.parceiro_id)::int AS envios
    FROM creator.parceiro p
    LEFT JOIN LATERAL (
      SELECT seguidores, engajamento_pct, posts_30d, ultimo_post, bio, fonte
      FROM creator.perfil_snapshot ps
      WHERE lower(ps.instagram_handle)=lower(p.instagram_handle)
      ORDER BY (fonte <> 'indisponivel') DESC, coletado_em DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT sum(x.v) AS views_marc, count(*) FILTER (WHERE x.v IS NOT NULL)::int AS reels_medidos
      FROM creator.publicacao u
      JOIN LATERAL (SELECT max(visualizacoes) v FROM creator.publicacao_metrica m
                    WHERE m.publicacao_id=u.publicacao_id) x ON true
      WHERE lower(u.instagram_handle)=lower(p.instagram_handle)
    ) v ON true
    ORDER BY p.criado_em DESC
  `,

  // ---- envios ----
  envios: `
    SELECT e.envio_id, e.parceiro_id, p.nome, p.instagram_handle,
           e.tipo, e.itens, e.valor, e.status, e.rastreio,
           e.solicitado_em::date AS solicitado, e.enviado_em::date AS enviado,
           e.entregue_em::date AS entregue, e.obs
    FROM creator.envio e
    JOIN creator.parceiro p ON p.parceiro_id = e.parceiro_id
    ORDER BY e.solicitado_em DESC LIMIT 200
  `,

  // ---- publicações por parceiro, para a ficha ----
  fichaPubs: `
    SELECT u.parceiro_id, u.instagram_handle, u.tipo, u.publicado_em::date AS data,
           u.permalink, left(coalesce(u.legenda,''),140) AS legenda,
           m.curtidas, m.comentarios, m.visualizacoes
    FROM creator.publicacao u
    LEFT JOIN LATERAL (
      SELECT max(curtidas) curtidas, max(comentarios) comentarios, max(visualizacoes) visualizacoes
      FROM creator.publicacao_metrica pm WHERE pm.publicacao_id=u.publicacao_id
    ) m ON true
    WHERE u.parceiro_id IS NOT NULL
    ORDER BY u.publicado_em DESC
  `,

  // ---- cadastrados aguardando curadoria (legado — a `fila` substitui) ----
  cadastrados: `
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.email, p.status,
           p.criado_em::date AS cadastro,
           EXISTS (SELECT 1 FROM creator.publicacao u
                   WHERE lower(u.instagram_handle)=lower(p.instagram_handle)) AS ja_marcou,
           s.seguidores, s.engajamento_pct, s.posts_30d, s.ultimo_post
    FROM creator.parceiro p
    LEFT JOIN LATERAL (
      SELECT seguidores, engajamento_pct, posts_30d, ultimo_post
      FROM creator.perfil_snapshot ps
      WHERE lower(ps.instagram_handle)=lower(p.instagram_handle)
      ORDER BY coletado_em DESC LIMIT 1
    ) s ON true
    ORDER BY p.criado_em DESC
  `,

  // ---- volume por mês, para o gráfico ----
  porMes: `
    SELECT to_char(date_trunc('month', publicado_em),'YYYY-MM') AS mes,
           count(*)                                 AS total,
           count(*) FILTER (WHERE tipo='reels')     AS reels,
           count(*) FILTER (WHERE tipo='carrossel') AS carrossel,
           count(*) FILTER (WHERE tipo='story')     AS stories,
           count(*) FILTER (WHERE tipo IN ('feed_imagem','feed_video')) AS feed
    FROM creator.publicacao
    GROUP BY 1 ORDER BY 1
  `,

  // ---- metas do mês corrente ----
  metas: `
    SELECT m.parceiro_id, p.nome, p.instagram_handle,
           m.meta_stories, m.meta_reels, m.meta_vendas,
           m.feito_stories, m.feito_reels, m.feito_vendas, m.bateu
    FROM creator.meta_mes m
    JOIN creator.parceiro p ON p.parceiro_id = m.parceiro_id
    WHERE m.competencia = date_trunc('month', current_date)::date
    ORDER BY p.nome
  `,

  // ---- custo do mês ----
  custos: `
    SELECT tipo, sum(valor) AS total, count(*) AS lancamentos
    FROM creator.custo
    WHERE competencia = date_trunc('month', current_date)::date
    GROUP BY 1 ORDER BY 2 DESC
  `,

  // ---- visão 360 por parceiro ----
  p360: `SELECT * FROM creator.vw_parceiro_360
         WHERE NOT arquivado AND (pedidos_cupom > 0 OR publicacoes > 0 OR cliques > 0)
         ORDER BY receita_cupom DESC NULLS LAST, publicacoes DESC`,

  conflitos: `SELECT * FROM creator.vw_conflito_atribuicao ORDER BY pedido_em DESC LIMIT 50`,

  // ---- vendas por parceiro (cupom nominal) ----
  // ⚠️ Só atribuição por CUPOM. Clique/UTM e assistida ainda não existem — quando existirem,
  // ficam em colunas separadas e NUNCA somadas com esta.
  vendas: `
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.origem, p.tipo,
           c.codigo AS cupom, c.desconto_pct,
           count(*)::int                          AS pedidos,
           round(sum(v.receita_liquida),2)        AS receita,
           round(avg(v.receita_liquida),2)        AS ticket,
           min(v.pedido_em)::date                 AS primeira,
           max(v.pedido_em)::date                 AS ultima,
           count(*) FILTER (WHERE v.pedido_em >= current_date - 90)::int AS pedidos_90d
    FROM creator.venda v
    JOIN creator.parceiro p ON p.parceiro_id = v.parceiro_id
    LEFT JOIN creator.cupom c ON c.cupom_id = v.cupom_id
    GROUP BY 1,2,3,4,5,6,7
    ORDER BY sum(v.receita_liquida) DESC
  `,

  // ---- o canal em um número ----
  canal: `
    SELECT count(DISTINCT v.parceiro_id)::int AS pessoas_que_venderam,
           count(*)::int                      AS pedidos,
           round(sum(v.receita_liquida),2)    AS receita,
           round(avg(v.receita_liquida),2)    AS ticket,
           count(*) FILTER (WHERE v.pedido_em >= current_date - 90)::int AS pedidos_90d,
           round(sum(v.receita_liquida) FILTER (WHERE v.pedido_em >= current_date - 90),2) AS receita_90d,
           count(*) FILTER (WHERE v.cliente_novo)::int AS clientes_novos,
           round(sum(v.receita_liquida) FILTER (WHERE v.cliente_novo),2) AS receita_novos,
           count(*) FILTER (WHERE v.cliente_novo IS NULL)::int AS sem_flag,
           min(v.pedido_em)::date AS de, max(v.pedido_em)::date AS ate
    FROM creator.venda v
  `,

  // ---- galeria de conteúdo ----
  // A URL de mídia vem do payload do Apify e EXPIRA. Não guardamos o arquivo: o job semanal
  // renova a URL, e o download é feito na hora pelo servidor. Guardar vídeo em bytea inflaria
  // o banco por nada.
  galeria: `
    SELECT u.publicacao_id, u.instagram_handle, u.tipo, u.publicado_em::date AS data,
           u.permalink, left(coalesce(u.legenda,''),200) AS legenda,
           u.parceiro_id, p.nome AS parceiro, u.parceria_paga, u.virou_anuncio,
           m.curtidas, m.comentarios, m.visualizacoes, m.reproducoes,
           m.payload->>'displayUrl' AS thumb,
           (m.payload->>'videoUrl' IS NOT NULL) AS tem_video,
           m.coletado_em AS midia_de
    FROM creator.publicacao u
    LEFT JOIN creator.parceiro p ON p.parceiro_id = u.parceiro_id
    LEFT JOIN LATERAL (
      SELECT curtidas, comentarios, visualizacoes, reproducoes, payload, coletado_em
      FROM creator.publicacao_metrica pm
      WHERE pm.publicacao_id = u.publicacao_id AND pm.payload->>'displayUrl' IS NOT NULL
      ORDER BY coletado_em DESC LIMIT 1
    ) m ON true
    WHERE m.payload IS NOT NULL
    ORDER BY coalesce(m.visualizacoes,0) DESC, u.publicado_em DESC
    LIMIT 200
  `,

  // ---- seeding: quem continua recebendo, e se o produto enviado voltou em venda ----
  seeding: `
    SELECT s.*, e.endereco_completo, e.cpf_valido, e.end_uf, e.logistica_sugerida,
           r.envios AS envios_feitos, r.custo_total, r.receita, r.retorno_x
    FROM creator.vw_seeding_elegivel s
    LEFT JOIN creator.vw_endereco e ON e.parceiro_id = s.parceiro_id
    LEFT JOIN creator.vw_seeding_retorno r ON r.parceiro_id = s.parceiro_id
    ORDER BY CASE s.decisao WHEN 'elegivel' THEN 1 WHEN 'ainda_nao' THEN 2 ELSE 3 END,
             s.conteudos DESC
  `,

  // ---- endereço: dá para postar hoje? ----
  enderecos: `
    SELECT parceiro_id, nome, instagram_handle, end_cidade, end_uf,
           endereco_completo, cpf_valido, logistica_sugerida
    FROM creator.vw_endereco
    WHERE parceiro_id IN (SELECT parceiro_id FROM creator.parceiro WHERE status='ativo' AND NOT arquivado)
    ORDER BY endereco_completo DESC, nome
  `,

  // ---- campanhas, jogos e placar ----
  campanhas: `
    SELECT c.*,
           (SELECT count(*) FROM creator.campanha_parceiro cp
            WHERE cp.campanha_id=c.campanha_id AND cp.saiu_em IS NULL)::int AS participantes,
           (SELECT count(*) FROM creator.jogo j WHERE j.campanha_id=c.campanha_id AND j.ativo)::int AS jogos
    FROM creator.campanha c ORDER BY c.inicio DESC
  `,
  jogos: `
    SELECT j.*, c.nome AS campanha,
           (SELECT json_agg(json_build_object('missao_id',m.missao_id,'tipo',m.tipo_conteudo,
                    'pontos',m.pontos,'meta',m.meta_qtd,'bonus',m.bonus_pct,'premio',m.premio)
                    ORDER BY m.ordem, m.missao_id)
            FROM creator.missao m WHERE m.jogo_id=j.jogo_id) AS missoes
    FROM creator.jogo j JOIN creator.campanha c USING (campanha_id)
    ORDER BY j.inicio DESC
  `,
  placar: `SELECT * FROM creator.vw_placar ORDER BY pontos DESC, entregas DESC`,

  // ---- saúde dos jobs de coleta ----
  jobs: `
    SELECT DISTINCT ON (job) job, sucesso, itens, detalhe, rodou_em
    FROM creator.job_log ORDER BY job, rodou_em DESC
  `,

  // ---- publicações recentes, para a aba de conteúdo ----
  recentes: `
    SELECT u.instagram_handle, u.tipo, u.publicado_em::date AS data, u.permalink,
           left(coalesce(u.legenda,''), 180) AS legenda,
           m.curtidas, m.comentarios, m.visualizacoes
    FROM creator.publicacao u
    LEFT JOIN LATERAL (
      SELECT curtidas, comentarios, visualizacoes FROM creator.publicacao_metrica pm
      WHERE pm.publicacao_id = u.publicacao_id ORDER BY coletado_em DESC LIMIT 1
    ) m ON true
    ORDER BY u.publicado_em DESC LIMIT 60
  `,
};
