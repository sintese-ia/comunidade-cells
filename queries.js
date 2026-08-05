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
             sum(x.reproducoes)   AS plays_marc
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
      pa.parceiro_id, pa.status AS status_parceiro, pa.nome AS nome_cadastro
    FROM snap s
    FULL OUTER JOIN pub p ON p.h = s.h
    LEFT JOIN met m       ON m.h = COALESCE(s.h, p.h)
    LEFT JOIN creator.parceiro pa ON lower(pa.instagram_handle) = COALESCE(s.h, p.h)
    ORDER BY s.engajamento_pct DESC NULLS LAST
  `,

  // ---- cadastrados aguardando curadoria ----
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
