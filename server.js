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
const G = require('./genero');

const PORT    = process.env.PORT || 3000;
const SENHA   = process.env.SENHA || 'cells';
const TTL     = (+process.env.CACHE_MIN || 5) * 60 * 1000;
const IG_ID   = process.env.IG_USER_ID || '17841405730329135';   // @cellsoficial
const META    = process.env.META_TOKEN || '';
const GRAPH_V = process.env.GRAPH_VERSION || 'v21.0';
const APIFY   = process.env.APIFY_TOKEN || '';
const APP_SECRET   = process.env.META_APP_SECRET || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const SHOP      = process.env.SHOPIFY_SHOP  || 'r1n6nj-ui.myshopify.com';
const SHOP_TOKEN = process.env.SHOPIFY_TOKEN || '';   // precisa de write_discounts
const KLAVIYO   = process.env.KLAVIYO_KEY || '';
const SITE      = process.env.SITE_URL || 'https://cells.com.br';
// O padrão REAL da casa, medido na loja em 08/08: os ~103 cupons nominais são de 8%.
// O business case dizia 15% — está errado, e usar 15 dobraria o desconto sem ninguém decidir.
const DESCONTO_PADRAO = +process.env.DESCONTO_PADRAO || 8;
const COOKIE  = 'cc_sess';
// Os únicos status que um cadastro pode ter. A tela oferece exatamente estes, e o servidor
// recusa qualquer outro — status livre vira dialeto pessoal e quebra todo filtro depois.
const STATUS  = ['pendente', 'ativo', 'pausado', 'reprovado'];
const TOKEN   = require('crypto').createHash('sha256').update('cc|' + SENHA).digest('hex').slice(0, 32);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, max: 4, idleTimeoutMillis: 30000, statement_timeout: 60000,
});

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const TPL_CREATOR = fs.readFileSync(path.join(__dirname, 'portal.html'), 'utf8');
const COOKIE_CR = 'cc_creator';
let cache = { at: 0, json: null, erro: null };

// ---------------------------------------------------------------- Postgres
// converte tipos do pg para algo que o JSON do template entende sem surpresa
function normaliza(row) {
  const o = {};
  for (const [c, v] of Object.entries(row)) {
    o[c] = (v instanceof Date) ? v.toISOString().slice(0, 10)
         : (typeof v === 'string' && /^-?\d+\.?\d+$|^-?\d+$/.test(v)) ? Number(v)
         : v;
  }
  return o;
}

async function carregar() {
  const out = {};
  const cli = await pool.connect();
  try {
    for (const [k, sql] of Object.entries(Q.painel)) {
      const r = await cli.query(sql);
      out[k] = r.rows.map(normaliza);
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

// ⚠️ `cache.at = 0` depois de uma escrita NÃO bastava. Ele dispara a recarga mas a chamada
// atual devolve o cache velho na mesma hora — então quem grava e recarrega a página vê o mundo
// de ANTES. Foi assim que o botão "avisar os creators" não apareceu depois de vincular
// alguém: o dado estava certo no banco e certo no /api/dados, e errado no HTML servido.
// Agora `sujo` obriga a PRÓXIMA leitura a esperar a recarga. É meio segundo, uma vez, logo
// após uma ação do usuário — barato perto de mostrar informação desatualizada.
let sujo = false;
function invalida() { cache.at = 0; sujo = true; }

async function dados() {
  if (sujo || !cache.json) { sujo = false; return recarregar(); }
  if (Date.now() - cache.at >= TTL) recarregar();   // vencido: devolve o atual e renova atrás
  return cache.json;
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

// ---------------------------------------------------------------- POST genérico
function postJSON(url, headers, corpo) {
  return new Promise((ok, err) => {
    const body = Buffer.from(JSON.stringify(corpo));
    const r = https.request(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers } },
      resp => {
        const bufs = [];
        resp.on('data', c => bufs.push(c));
        resp.on('end', () => {
          const txt = Buffer.concat(bufs).toString('utf8');
          let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
          ok({ status: resp.statusCode, json, txt });
        });
      });
    r.on('error', err);
    r.setTimeout(25000, () => r.destroy(new Error('timeout')));
    r.write(body); r.end();
  });
}

// ---------------------------------------------------------------- cupom na Shopify
// O token JÁ tem read/write_discounts (confirmado 12/08 criando e alterando os 33 ativos).
// O que ele NÃO tem é `read_products`: qualquer query que peça a lista de produtos dentro
// de `customerGets.items` falha inteira com "Access denied for products field". Pedir só
// `items { __typename }` passa. Vale lembrar na hora de ler desconto de escopo restrito.
//
// Se um dia o token perder o escopo, esta função lança e o cupom fica só no nosso banco com
// `shopify_erro` preenchido. A tela mostra isso em vermelho: cupom que não existe na loja
// não funciona no checkout, e fingir que funciona é o pior resultado possível.
async function criarCupomShopify({ codigo, pct, combinavel }) {
  if (!SHOP_TOKEN) throw new Error('SHOPIFY_TOKEN não configurado — cupom NÃO existe na loja');
  const mut = `
    mutation criar($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`;
  const d = {
    title: codigo,
    code: codigo,
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: pct / 100 },
      items: { all: true },
      // O cupom precisa valer TAMBÉM na assinatura, senão quem entra no CellsClub pelo link
      // da creator não recebe desconto nenhum e o cupom parece quebrado. Nascia `false`.
      appliesOnOneTimePurchase: true,
      appliesOnSubscription: true,
    },
    // ...mas só na PRIMEIRA cobrança (decisão do Gabriel, 12/08). Sem isto o desconto se
    // repetiria em toda renovação e a margem da assinatura ia junto.
    recurringCycleLimit: 1,
    // combinar com outro desconto de PEDIDO é como o cupom de creator vira 8% + 20% de
    // campanha no mesmo carrinho. Todos os ~180 cupons da loja hoje estão com isso LIGADO;
    // os novos nascem desligados, salvo escolha explícita na tela.
    combinesWith: { orderDiscounts: !!combinavel, productDiscounts: false, shippingDiscounts: true },
    appliesOncePerCustomer: false,
  };
  const r = await postJSON(`https://${SHOP}/admin/api/2025-01/graphql.json`,
    { 'X-Shopify-Access-Token': SHOP_TOKEN }, { query: mut, variables: { d } });
  if (r.status !== 200) throw new Error('Shopify HTTP ' + r.status + ' ' + String(r.txt).slice(0, 160));
  const erroApi = r.json?.errors?.[0]?.message;
  if (erroApi) throw new Error(erroApi);
  const res = r.json?.data?.discountCodeBasicCreate;
  if (res?.userErrors?.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  const id = res?.codeDiscountNode?.id;
  if (!id) throw new Error('a Shopify não devolveu o id do desconto');
  return id;
}

// ---------------------------------------------------------------- e-mail pelo Klaviyo
// O app NÃO manda e-mail: manda um EVENTO. Quem transforma em mensagem é um flow do Klaviyo,
// que cuida de template, remetente verificado, descadastro e entrega. Construir mailer próprio
// para isso seria refazer o que já existe na casa e com pior entrega.
//
// ⚠️ CONSEQUÊNCIA QUE PRECISA APARECER NA TELA: aceitar o evento (202) NÃO é entregar o
// e-mail. Se o flow não estiver ligado no Klaviyo, o evento entra e nada sai. Por isso o
// email_log grava `evento_enviado`, nunca `enviado`.
const METRICA_APROVACAO = 'Creator Aprovado';
const METRICA_CAMPANHA  = 'Creator Campanha';
const METRICA_REGISTRO  = 'Creator Cadastrado';

// "obrigado pelo registro". Mesmo caminho dos outros: o app manda evento, o flow do Klaviyo
// entrega. Quem chama é o job de cadastros, uma vez por pessoa.
async function eventoRegistro({ email, nome, instagram, sexo }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('sem e-mail no cadastro');
  const corpo = { data: { type: 'event', attributes: {
    properties: { nome_creator: G.primeiroNome(nome) || null, instagram: instagram || null,
                  saudacao: G.saudacaoDe(nome, sexo) },
    metric: { data: { type: 'metric', attributes: { name: METRICA_REGISTRO } } },
    profile: { data: { type: 'profile', attributes: { email,
               ...(nome ? { first_name: String(nome).split(/\s+/)[0] } : {}) } } },
  } } };
  const r = await postJSON('https://a.klaviyo.com/api/events/',
    { Authorization: 'Klaviyo-API-Key ' + KLAVIYO, revision: '2024-10-15' }, corpo);
  if (r.status !== 202) throw new Error('Klaviyo HTTP ' + r.status + ' ' + String(r.txt).slice(0, 200));
  return corpo.data.attributes.properties;
}

// Mesmo caminho do aviso de aprovação, com a campanha junto. Separado em métrica própria
// porque o flow é outro: aqui o assunto é "seu link mudou para esta campanha", não boas-vindas.
async function eventoCampanha({ email, nome, campanha, briefing, cupom, link, inicio, fim }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('sem e-mail no cadastro');
  const corpo = { data: { type: 'event', attributes: {
    properties: { campanha, briefing: briefing || null, cupom: cupom || null, link,
                  inicio: inicio || null, fim: fim || null, nome_creator: nome || null },
    metric: { data: { type: 'metric', attributes: { name: METRICA_CAMPANHA } } },
    profile: { data: { type: 'profile', attributes: { email,
               ...(nome ? { first_name: String(nome).split(/\s+/)[0] } : {}) } } },
  } } };
  const r = await postJSON('https://a.klaviyo.com/api/events/',
    { Authorization: 'Klaviyo-API-Key ' + KLAVIYO, revision: '2024-10-15' }, corpo);
  if (r.status !== 202) throw new Error('Klaviyo HTTP ' + r.status + ' ' + String(r.txt).slice(0, 200));
  return corpo.data.attributes.properties;
}

async function eventoAprovacao({ email, nome, cupom, link, desconto, comissao, sexo }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('esta pessoa não tem e-mail no cadastro');
  // A saudação é decidida AQUI, não no template: o Klaviyo não tem como consultar o `sexo`
  // declarado na LP nem rodar a lista de nomes. O template só imprime.
  const corpo = {
    data: {
      type: 'event',
      attributes: {
        properties: { cupom, link, desconto_pct: desconto, comissao_pct: comissao,
                      nome_creator: G.primeiroNome(nome) || null,
                      saudacao: G.saudacaoDe(nome, sexo) },
        metric: { data: { type: 'metric', attributes: { name: METRICA_APROVACAO } } },
        profile: { data: { type: 'profile',
                   attributes: { email, ...(nome ? { first_name: String(nome).split(/\s+/)[0] } : {}) } } },
      },
    },
  };
  const r = await postJSON('https://a.klaviyo.com/api/events/',
    { Authorization: 'Klaviyo-API-Key ' + KLAVIYO, revision: '2024-10-15' }, corpo);
  if (r.status !== 202) throw new Error('Klaviyo HTTP ' + r.status + ' ' + String(r.txt).slice(0, 200));
  return corpo.data.attributes.properties;
}

// ---------------------------------------------------------------- o link do creator
// Convenção fechada com o Gabriel em 08/08:
//   utm_source=creator  ·  utm_campaign=<@ da pessoa>  ·  utm_content=<campanha>
// `content` fora significa link base — a pessoa divulgando por conta própria, que é caso
// legítimo e não dado faltando. Uma função só, porque link montado em três lugares diferentes
// vira três convenções diferentes na primeira pressa.
function linkCreator(slug, utmContent) {
  const q = new URLSearchParams({ utm_source: 'creator', utm_campaign: slug });
  if (utmContent) q.set('utm_content', utmContent);
  return SITE + '/?' + q.toString();
}

// O link CURTO — cells.com.br/r/<cupom> — é o que a creator divulga.
// Um redirect 301 na própria loja traduz para o link acima, então a atribuição é a mesma:
// o que muda é ela conseguir falar o link em vídeo sem soletrar UTM. Testado 12/08: a Shopify
// preserva a query string no destino e casa o path sem diferenciar maiúscula de minúscula.
//
// ⚠️ Link de CAMPANHA continua longo: o redirect é um por cupom e não tem como variar o
// utm_content por campanha sem criar um redirect por combinação.
function linkCurto(codigo) {
  return SITE + '/r/' + String(codigo).toLowerCase();
}

// Cria o redirect da loja. Exige `write_online_store_navigation` no app custom — o escopo foi
// adicionado em 12/08; antes disso devolvia "Access denied for urlRedirectCreate".
async function criarLinkCurtoShopify({ codigo, slug }) {
  if (!SHOP_TOKEN) throw new Error('SHOPIFY_TOKEN não configurado');
  const mut = `
    mutation criar($r: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $r) {
        urlRedirect { id path }
        userErrors { field message }
      }
    }`;
  const r = await postJSON(`https://${SHOP}/admin/api/2025-01/graphql.json`,
    { 'X-Shopify-Access-Token': SHOP_TOKEN },
    { query: mut, variables: { r: {
      path: '/r/' + String(codigo).toLowerCase(),
      target: '/?' + new URLSearchParams({ utm_source: 'creator', utm_campaign: slug }).toString(),
    } } });
  if (r.status !== 200) throw new Error('Shopify HTTP ' + r.status + ' ' + String(r.txt).slice(0, 160));
  const erroApi = r.json?.errors?.[0]?.message;
  if (erroApi) throw new Error(erroApi);
  const res = r.json?.data?.urlRedirectCreate;
  if (res?.userErrors?.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  const id = res?.urlRedirect?.id;
  if (!id) throw new Error('a Shopify não devolveu o id do redirect');
  return id;
}

// slug do link, único. `ux_parceiro_slug` é único de verdade, então tentar sem checar quebra.
async function slugLivre(cli, base) {
  // o @ entra INTEIRO, com ponto e underscore: é o que o Gabriel pediu e é o que torna o
  // link legível. Só nome de pessoa (quem não tem @) perde os separadores.
  const cru = String(base || '').trim().toLowerCase();
  const raiz = (/^[a-z0-9._]+$/.test(cru) ? cru
    : cru.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')).slice(0, 30) || 'creator';
  for (let i = 0; i < 40; i++) {
    const tentativa = i ? raiz + i : raiz;
    const r = await cli.query(`SELECT 1 FROM creator.parceiro WHERE utm_slug=$1`, [tentativa]);
    if (!r.rows[0]) return tentativa;
  }
  throw new Error('não achei slug livre para ' + raiz);
}

// ---------------------------------------------------------------- portal do creator
// Tudo aqui é escopado por parceiro_id vindo do TOKEN, nunca de parâmetro da URL.
// Se viesse da URL, trocar o número mostraria os dados de outra pessoa.
async function dadosDoCreator(parceiroId) {
  const q = (sql, p) => pool.query(sql, p).then(r => r.rows);
  const [pa] = await q(`
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.utm_slug, p.tags, p.status,
           c.codigo AS cupom
    FROM creator.parceiro p
    LEFT JOIN creator.cupom c ON c.parceiro_id = p.parceiro_id AND c.ativo
    WHERE p.parceiro_id = $1`, [parceiroId]);
  if (!pa) return null;

  const [v] = await q(`
    SELECT count(*)::int AS pedidos, coalesce(sum(receita_liquida),0) AS receita,
           round(avg(receita_liquida),2) AS ticket,
           count(*) FILTER (WHERE pedido_em >= date_trunc('month', current_date))::int AS pedidos_mes,
           coalesce(sum(receita_liquida) FILTER (WHERE pedido_em >= date_trunc('month', current_date)),0) AS receita_mes
    FROM creator.venda WHERE parceiro_id=$1 AND atribuicao='cupom'`, [parceiroId]);

  const extrato = await q(`
    SELECT pedido_id, pedido_numero, pedido_em, receita_liquida, cliente_novo
    FROM creator.venda WHERE parceiro_id=$1 AND atribuicao='cupom'
    ORDER BY pedido_em DESC LIMIT 60`, [parceiroId]);

  const publicacoes = await q(`
    SELECT u.tipo, u.publicado_em, u.permalink, left(coalesce(u.legenda,''),90) AS legenda,
           m.curtidas, m.visualizacoes
    FROM creator.publicacao u
    LEFT JOIN LATERAL (SELECT max(curtidas) curtidas,
                              coalesce(max(reproducoes), max(visualizacoes)) visualizacoes
                       FROM creator.publicacao_metrica pm WHERE pm.publicacao_id=u.publicacao_id) m ON true
    WHERE u.parceiro_id=$1 ORDER BY u.publicado_em DESC LIMIT 40`, [parceiroId]);

  const envios = await q(`
    SELECT tipo, itens, status, rastreio, solicitado_em
    FROM creator.envio WHERE parceiro_id=$1 ORDER BY solicitado_em DESC LIMIT 20`, [parceiroId]);

  const jogos = await q(`
    SELECT jogo, pontos, entregas, detalhe FROM creator.vw_placar
    WHERE parceiro_id=$1 ORDER BY pontos DESC`, [parceiroId]);

  return { parceiro: pa, vendas: v, extrato, publicacoes, envios, jogos };
}

const portalErro = (titulo, msg) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Comunidade Cells</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F8F7;color:#14181A;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;padding:20px}
.bx{background:#fff;border:1px solid #E3E8E7;border-left:3px solid #8A5800;border-radius:4px;
padding:26px;max-width:420px;text-align:center}h1{margin:0 0 9px;font-size:19px}
p{margin:0;font-size:13.5px;color:#6C7679;line-height:1.6}</style></head>
<body><div class="bx"><h1>${titulo}</h1><p>${msg}</p></div></body></html>`;

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
        // ⚠️ Recusar em silêncio é como ficar cego. Em 10/08 passamos horas sem saber se a Meta
        // não entregava ou se a gente estava rejeitando: o 401 só ia para o log do container,
        // que o Easypanel não expõe por API. Agora a recusa deixa rastro NO BANCO.
        // O corpo NÃO é guardado como veio — ele não foi verificado, e gravar jsonb não
        // confiável é justamente o que a assinatura existe para impedir. Guarda-se só o
        // suficiente para diagnosticar: que chegou, de onde, e como a assinatura veio.
        console.error('[webhook] assinatura inválida');
        pool.query(
          `INSERT INTO jarvis.webhook_bruto (origem, payload, erro)
           VALUES ('meta:recusado', $1::jsonb, 'assinatura invalida')`,
          [JSON.stringify({
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
            ua: String(req.headers['user-agent'] || '').slice(0, 120),
            assinatura_recebida: String(veio).slice(0, 80),
            tinha_assinatura: !!veio,
            bytes: raw.length,
          })]).catch(e => console.error('[webhook] nem o rastro da recusa gravou:', e.message));
        res.writeHead(401, {'content-type':'text/plain'}); return res.end('assinatura inválida');
      }
      // Responder 200 rápido: a Meta re-entrega se demorar, e o download da mídia é lento.
      res.writeHead(200, {'content-type':'text/plain'}); res.end('ok');
      // O 200 já foi enviado acima, então a Meta NÃO re-entrega se o que vem abaixo falhar.
      // Por isso o payload cru é gravado primeiro, numa transação própria: se a derivação
      // estourar, a mensagem continua no banco e dá para reprocessar. Sem isso, uma falha
      // silenciosa aqui vira cliente sem resposta que ninguém enxerga.
      let bruto = null;
      try {
        const r = await pool.query(
          `INSERT INTO jarvis.webhook_bruto (origem, payload) VALUES ('meta', $1::jsonb) RETURNING id`,
          [raw.toString('utf8')]);
        bruto = r.rows[0].id;
      } catch (e) { console.error('[webhook] não consegui guardar o cru:', e.message); }

      try {
        const body = JSON.parse(raw.toString('utf8'));
        const stories = J.extrairStories(body);
        for (const s of stories) await J.guardarStory(pool, s, META);
        if (stories.length) {
          console.log('[webhook] story mentions gravados:', stories.length);
          await J.logJob(pool, 'story', true, 'webhook', stories.length);
        }
        const msgs = J.extrairMensagens(body);
        for (const m of msgs) await J.guardarMensagem(pool, m);
        if (msgs.length) console.log('[webhook] DMs gravadas:', msgs.length);
        if (bruto) await pool.query(
          'UPDATE jarvis.webhook_bruto SET processado=true WHERE id=$1', [bruto]);
      } catch (e) {
        console.error('[webhook]', e.message);
        J.logJob(pool, 'story', false, e.message, 0);
        if (bruto) pool.query(
          'UPDATE jarvis.webhook_bruto SET erro=$2, tentativas=tentativas+1 WHERE id=$1',
          [bruto, String(e.message).slice(0, 400)]).catch(() => {});
      }
    });
  }

  // ---- portal do creator (link mágico) ----
  if (u.pathname === '/creator') {
    const ck = req.headers.cookie || '';
    let pid = null;
    const t = u.searchParams.get('t');

    if (t) {
      try {
        const r = await pool.query(`
          UPDATE creator.acesso SET usos = usos + 1, ultimo_uso = now(),
                 primeiro_uso = coalesce(primeiro_uso, now())
          WHERE token = $1 AND revogado_em IS NULL AND expira_em > now()
          RETURNING parceiro_id`, [t]);
        if (!r.rows[0]) {
          res.writeHead(403, {'content-type':'text/html; charset=utf-8'});
          return res.end(portalErro('Este link não vale mais',
            'Ele expirou ou foi desativado. Peça um novo para a equipe da Cells.'));
        }
        pid = r.rows[0].parceiro_id;
        // cookie assinado com o token: quem não tem o token não forja o cookie
        const sig = crypto.createHash('sha256').update('cr|' + SENHA + '|' + pid).digest('hex').slice(0, 32);
        res.writeHead(303, { Location: '/creator', 'Set-Cookie':
          `${COOKIE_CR}=${pid}.${sig}; Path=/creator; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000` });
        return res.end();
      } catch (e) {
        res.writeHead(500, {'content-type':'text/html; charset=utf-8'});
        return res.end(portalErro('Deu erro aqui', 'Tente de novo em instantes.'));
      }
    }

    const m = /cc_creator=(\d+)\.([a-f0-9]{32})/.exec(ck);
    if (m) {
      const esperado = crypto.createHash('sha256').update('cr|' + SENHA + '|' + m[1]).digest('hex').slice(0, 32);
      if (m[2] === esperado) pid = +m[1];
    }
    if (!pid) {
      res.writeHead(401, {'content-type':'text/html; charset=utf-8'});
      return res.end(portalErro('Você precisa do seu link',
        'O acesso é por link pessoal enviado pela Cells. Se você perdeu o seu, é só pedir outro.'));
    }
    try {
      const d = await dadosDoCreator(pid);
      if (!d) { res.writeHead(404, {'content-type':'text/html; charset=utf-8'});
        return res.end(portalErro('Não encontrei seu cadastro', 'Fale com a equipe da Cells.')); }
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      return res.end(TPL_CREATOR.replace('__DADOS__', JSON.stringify(d).replace(/</g, '\\u003c')));
    } catch (e) {
      res.writeHead(500, {'content-type':'text/html; charset=utf-8'});
      return res.end(portalErro('Deu erro aqui', 'Tente de novo em instantes.'));
    }
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

  // ---------------- mídia: assistir aqui e baixar ----------------
  // O CDN da Meta é quem guarda o arquivo — nós só repassamos. Duas razões para não mandar o
  // browser direto na URL do CDN: ela expira (e o usuário veria um vídeo quebrado sem entender
  // por quê) e ela vaza o payload do Apify para a tela.
  //   ?inline=1  → toca no player, com suporte a Range para dar seek
  //   sem inline → baixa como anexo, para virar anúncio
  if (u.pathname === '/api/midia') {
    const pub = +u.searchParams.get('pub');
    const querVideo = u.searchParams.get('tipo') !== 'imagem';
    const inline = u.searchParams.get('inline') === '1';
    if (!pub) return json(400, { erro: 'publicacao ausente' });
    try {
      // ---- capa ----
      // MEDIDO EM 08/08 abrindo no Chrome: <img src="https://…cdninstagram.com/…"> volta
      // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin e a galeria inteira aparece EM BRANCO. O CDN da
      // Meta manda Cross-Origin-Resource-Policy, e nenhum atributo de <img> contorna isso.
      // A saída é o servidor buscar e servir do mesmo domínio. Guarda na primeira vez: a
      // segunda visita não toca no CDN.
      if (u.searchParams.get('tipo') === 'capa') {
        const c = await pool.query(`
          SELECT md.thumb_bytes, md.thumb_mime,
                 (SELECT pm.payload->>'displayUrl' FROM creator.publicacao_metrica pm
                   WHERE pm.publicacao_id=$1 AND pm.payload->>'displayUrl' IS NOT NULL
                   ORDER BY pm.coletado_em DESC LIMIT 1) AS url
          FROM creator.publicacao p
          LEFT JOIN creator.publicacao_midia md ON md.publicacao_id = p.publicacao_id
          WHERE p.publicacao_id=$1`, [pub]);
        const row = c.rows[0];
        if (!row) return json(404, { erro: 'publicação não encontrada' });
        const serve = (mime, buf) => {
          res.writeHead(200, { 'content-type': mime || 'image/jpeg',
            'content-length': buf.length, 'cache-control': 'private, max-age=604800' });
          res.end(buf);
        };
        if (row.thumb_bytes) return serve(row.thumb_mime, row.thumb_bytes);
        if (!row.url) return json(404, { erro: 'sem capa coletada' });
        const up = await new Promise((ok, err) => {
          https.get(row.url, r2 => ok(r2)).on('error', err)
            .setTimeout(20000, function(){ this.destroy(new Error('timeout')); });
        });
        if (up.statusCode !== 200) { up.resume(); return json(410, { erro: 'capa expirou no CDN' }); }
        const bufs = [];
        up.on('data', d => bufs.push(d));
        return up.on('end', async () => {
          const buf = Buffer.concat(bufs);
          pool.query(`
            INSERT INTO creator.publicacao_midia (publicacao_id,thumb_bytes,thumb_mime,thumb_em)
            VALUES ($1,$2,$3,now())
            ON CONFLICT (publicacao_id) DO UPDATE SET
              thumb_bytes=EXCLUDED.thumb_bytes, thumb_mime=EXCLUDED.thumb_mime, thumb_em=now()`,
            [pub, buf, up.headers['content-type'] || 'image/jpeg']).catch(e =>
              console.error('[capa]', e.message));
          serve(up.headers['content-type'], buf);
        });
      }

      // 1) o arquivo guardado, quando existe. É o único caminho confiável para vídeo: a URL do
      //    CDN morre em menos de 48h e o job é semanal.
      if (querVideo) {
        const g = await pool.query(`
          SELECT md.mime, md.bytes, md.tamanho, pu.instagram_handle, pu.publicado_em
          FROM creator.publicacao_midia md
          JOIN creator.publicacao pu ON pu.publicacao_id = md.publicacao_id
          WHERE md.publicacao_id=$1 AND md.bytes IS NOT NULL`, [pub]);
        if (g.rows[0]) {
          const { mime, bytes } = g.rows[0];
          const nome = `${g.rows[0].instagram_handle}-${String(g.rows[0].publicado_em).slice(0,10)}-${pub}.mp4`;
          const tot = bytes.length;
          const faixa = inline && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          if (faixa) {
            const ini = faixa[1] ? +faixa[1] : 0;
            const fim = faixa[2] ? Math.min(+faixa[2], tot - 1) : tot - 1;
            if (ini >= tot || ini > fim) {
              res.writeHead(416, { 'content-range': `bytes */${tot}` }); return res.end();
            }
            res.writeHead(206, {
              'content-type': mime || 'video/mp4', 'accept-ranges': 'bytes',
              'content-range': `bytes ${ini}-${fim}/${tot}`, 'content-length': fim - ini + 1,
              'cache-control': 'private, max-age=3600', 'content-disposition': 'inline',
            });
            return res.end(bytes.subarray(ini, fim + 1));
          }
          res.writeHead(200, {
            'content-type': mime || 'video/mp4', 'accept-ranges': 'bytes', 'content-length': tot,
            'cache-control': 'private, max-age=3600',
            'content-disposition': inline ? 'inline' : `attachment; filename="${nome}"`,
          });
          return res.end(bytes);
        }
      }

      // 2) senão, tenta o CDN — vale para imagem, e para vídeo recém-coletado ainda não guardado
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
      // repassar o Range é o que faz a barra do player arrastar em vez de travar
      const cab = {};
      if (inline && req.headers.range) cab.range = req.headers.range;
      const up = await new Promise((ok, err) => {
        https.get(alvo, { headers: cab }, resp => ok(resp))
          .on('error', err).setTimeout(45000, function(){ this.destroy(new Error('timeout')); });
      });
      if (up.statusCode !== 200 && up.statusCode !== 206) {
        up.resume();
        // URL do CDN expira. Dizer isso é melhor que servir 0 bytes e o usuário achar que baixou.
        return json(410, { erro: 'a URL da mídia expirou no CDN da Meta (coletada em ' +
          String(row.coletado_em).slice(0,10) + '). Rode o job do Apify para renovar.' });
      }
      const cabeca = {
        'content-type': up.headers['content-type'] ||
          (ext === 'mp4' ? 'video/mp4' : 'image/jpeg'),
        'cache-control': 'no-store',
        'content-disposition': inline ? 'inline' : `attachment; filename="${nome}"`,
      };
      if (up.headers['content-length']) cabeca['content-length'] = up.headers['content-length'];
      if (up.headers['content-range'])  cabeca['content-range']  = up.headers['content-range'];
      if (inline) cabeca['accept-ranges'] = 'bytes';
      res.writeHead(up.statusCode, cabeca);
      return up.pipe(res);
    } catch (e) { return json(500, { erro: e.message }); }
  }

  // busca um vídeo específico no Apify e guarda — para assistir conteúdo antigo, que o job
  // automático não guarda de propósito (ver JANELA_AUTO em jobs.js)
  if (u.pathname === '/api/midia/buscar' && req.method === 'POST') {
    const pub = +u.searchParams.get('pub');
    if (!pub) return json(400, { erro: 'publicacao ausente' });
    try {
      await J.buscarVideoDe(pool, APIFY, pub);
      invalida();
      return json(200, { ok: true });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- ANÁLISES ----------------
  // Sob demanda, nunca cacheada: o período e o creator vêm da tela e mudam a cada clique.
  if (u.pathname === '/api/analise') {
    const hoje = new Date().toISOString().slice(0, 10);
    const data = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
    const de   = data(u.searchParams.get('de'))  || '2020-01-01';
    const ate  = data(u.searchParams.get('ate')) || hoje;
    // a chave é handle OU `id:<n>` — ver o comentário do bloco ANALISE em queries.js
    const c = (u.searchParams.get('c') || '').trim().toLowerCase().slice(0, 60);
    if (c && !/^[a-z0-9._]+$|^id:\d+$/.test(c)) return json(400, { erro: 'creator inválido' });
    if (de > ate) return json(400, { erro: 'a data inicial é depois da final' });
    try {
      const p = [de, ate, c];
      const [g, pc, se] = await Promise.all([
        pool.query(Q.analise.geral, p),
        pool.query(Q.analise.porCreator, p),
        pool.query(Q.analise.serie, p),
      ]);
      return json(200, {
        ok: true, de, ate, creator: c || null,
        geral: normaliza(g.rows[0] || {}),
        porCreator: pc.rows.map(normaliza),
        serie: se.rows.map(normaliza),
      });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
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
      invalida();
      return json(200, { ok: true, publicacao: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // gera link de acesso do creator (o admin copia e envia — não disparo mensagem sozinho)
  if (u.pathname === '/api/acesso' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    const dias = Math.min(365, +u.searchParams.get('dias') || 90);
    if (!id) return json(400, { erro: 'parceiro ausente' });
    try {
      const tok = crypto.randomBytes(24).toString('base64url');
      await pool.query(
        `INSERT INTO creator.acesso (token,parceiro_id,expira_em,criado_por)
         VALUES ($1,$2, now() + ($3 || ' days')::interval, $4)`,
        [tok, id, String(dias), (u.searchParams.get('por') || 'painel').slice(0, 60)]);
      return json(200, { ok: true, url: 'https://comunidade-cells.sinteseia.com.br/creator?t=' + tok,
                         expira_em_dias: dias });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- campanhas ----------------
  // Uma campanha é de COMISSÃO (% sobre o vendido pelo cupom) ou de PONTUAÇÃO (pontos por
  // ação). O "jogo" continua existindo no banco porque é onde as missões moram, mas nasce
  // junto com a campanha e nunca aparece na tela — era uma caixa a mais sem função própria.
  if (u.pathname === '/api/campanha' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
    return req.on('end', async () => {
      const cli = await pool.connect();
      try {
        const d = JSON.parse(b || '{}');
        const hoje = new Date().toISOString().slice(0, 10);

        // mudar só o status (ativar, encerrar, arquivar) — não mexe no resto
        if (d.campanha_id && d.status && !d.nome) {
          if (!['rascunho','ativa','encerrada','arquivada'].includes(d.status))
            return json(400, { erro: 'status desconhecido' });
          const r = await cli.query(
            `UPDATE creator.campanha SET status=$2 WHERE campanha_id=$1 RETURNING *`,
            [d.campanha_id, d.status]);
          invalida(); return json(200, { ok: true, campanha: r.rows[0] });
        }

        if (!d.nome || !String(d.nome).trim()) return json(400, { erro: 'nome é obrigatório' });
        const tipo = d.tipo === 'pontuacao' ? 'pontuacao' : 'comissao';
        const pct = tipo === 'comissao' ? Number(String(d.comissao_pct || '').replace(',', '.')) : null;
        if (tipo === 'comissao' && !(pct > 0 && pct <= 100))
          return json(400, { erro: 'campanha de comissão precisa de um percentual entre 0 e 100' });
        const acoes = (d.acoes || []).filter(a => a && a.acao && +a.pontos > 0);
        if (tipo === 'pontuacao' && !acoes.length)
          return json(400, { erro: 'campanha de pontuação precisa de pelo menos uma ação com pontos' });
        // utm_content: é ele que separa o resultado desta campanha do de outra no clique
        const conteudo = String(d.utm_content || '').trim().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_-]/g,'') || null;
        if (conteudo && conteudo.length < 3)
          return json(400, { erro: 'utm_content muito curto — use algo como 2026-08_lancamento' });

        const inicio = /^\d{4}-\d{2}-\d{2}$/.test(d.inicio || '') ? d.inicio : hoje;
        const fim    = /^\d{4}-\d{2}-\d{2}$/.test(d.fim || '') ? d.fim : null;
        if (fim && fim < inicio) return json(400, { erro: 'a data final é antes da inicial' });

        await cli.query('BEGIN');
        const r = await cli.query(
          `INSERT INTO creator.campanha (nome,briefing,tipo,comissao_pct,inicio,fim,status,
                                         utm_content,criado_por)
           VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9) RETURNING *`,
          [String(d.nome).trim().slice(0, 120), d.briefing || null, tipo, pct, inicio, fim,
           d.status === 'ativa' ? 'ativa' : 'rascunho', conteudo, (d.por || 'painel').slice(0, 60)]);
        const camp = r.rows[0];

        if (tipo === 'pontuacao') {
          const j = await cli.query(
            `INSERT INTO creator.jogo (campanha_id,titulo,tipo,inicio,fim)
             VALUES ($1,$2,'pontos_brindes',$3::date,$4::date) RETURNING jogo_id`,
            [camp.campanha_id, camp.nome, inicio, fim]);
          for (const [i, a] of acoes.entries())
            await cli.query(
              `INSERT INTO creator.missao (jogo_id,tipo_conteudo,pontos,ordem)
               VALUES ($1,$2,$3,$4)`, [j.rows[0].jogo_id, a.acao, Math.round(+a.pontos), i]);
        }
        await cli.query('COMMIT');
        invalida();
        return json(200, { ok: true, campanha: camp });
      } catch (e) {
        await cli.query('ROLLBACK').catch(() => {});
        return json(200, { ok: false, erro: e.message });
      } finally { cli.release(); }
    });
  }

  // vincular/desvincular creator da campanha
  if (u.pathname === '/api/campanha/parceiro' && req.method === 'POST') {
    const c = +u.searchParams.get('campanha'), p = +u.searchParams.get('parceiro');
    const sai = u.searchParams.get('sair') === '1';
    if (!c || !p) return json(400, { erro: 'campanha e parceiro são obrigatórios' });
    try {
      if (sai) await pool.query(
        `UPDATE creator.campanha_parceiro SET saiu_em=now() WHERE campanha_id=$1 AND parceiro_id=$2`, [c, p]);
      else await pool.query(
        `INSERT INTO creator.campanha_parceiro (campanha_id,parceiro_id) VALUES ($1,$2)
         ON CONFLICT (campanha_id,parceiro_id) DO UPDATE SET saiu_em=NULL`, [c, p]);
      invalida(); return json(200, { ok: true });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- APROVAR: cupom + link + e-mail, num clique ----------------
  // Pedido do Gabriel em 08/08: aprovar tem que criar o cupom e o link e avisar a pessoa.
  //
  // A ordem importa e é deliberada. Primeiro grava no NOSSO banco, depois tenta a Shopify,
  // por último o e-mail — do mais reversível para o menos. Se o e-mail sair e o cupom não
  // existir, a pessoa recebe um código quebrado e a Cells queima a primeira impressão; o
  // contrário (cupom existe, e-mail falhou) é só reenviar.
  if (u.pathname === '/api/aprovar' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 8000) req.destroy(); });
    return req.on('end', async () => {
      const cli = await pool.connect();
      let etapa = 'início';
      try {
        const d = JSON.parse(b || '{}');
        const id = +d.parceiro_id;
        if (!id) return json(400, { erro: 'parceiro ausente' });

        const codigo = String(d.cupom || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{3,24}$/.test(codigo))
          return json(400, { erro: 'cupom: use de 3 a 24 letras ou números, sem espaço nem acento' });
        const desconto = Number(String(d.desconto_pct ?? DESCONTO_PADRAO).replace(',', '.'));
        const comissao = d.comissao_pct == null || d.comissao_pct === ''
          ? null : Number(String(d.comissao_pct).replace(',', '.'));
        if (!(desconto > 0 && desconto <= 100)) return json(400, { erro: 'desconto fora de 0 a 100' });
        if (comissao != null && !(comissao >= 0 && comissao <= 100))
          return json(400, { erro: 'comissão fora de 0 a 100' });

        etapa = 'conferindo o cadastro';
        const pa = (await cli.query(`
          SELECT p.*, l.sexo FROM creator.parceiro p
          LEFT JOIN creator.leads l ON l.lead_id = p.lead_id
          WHERE p.parceiro_id=$1`, [id])).rows[0];
        if (!pa) return json(404, { erro: 'parceiro não encontrado' });

        // O código tem que ser único na LOJA, não só aqui. `creator.legado` tem o inventário
        // inteiro da Shopify — inclusive cupons que nunca venderam e por isso não estão em
        // creator.cupom. Sem esta checagem, dá para reaproveitar sem querer o código de outra
        // pessoa e misturar a venda dos dois.
        etapa = 'conferindo se o código já existe';
        const cho = await cli.query(`
          SELECT 'programa' AS onde FROM creator.cupom WHERE upper(codigo)=$1
          UNION ALL SELECT 'loja' FROM creator.legado WHERE upper(codigo)=$1`, [codigo]);
        if (cho.rows[0])
          return json(409, { erro: 'o código ' + codigo + ' já existe ('
            + (cho.rows[0].onde === 'loja' ? 'na Shopify' : 'no programa') + '). Escolha outro.' });

        await cli.query('BEGIN');
        etapa = 'gravando o link';
        const slug = pa.utm_slug || await slugLivre(cli, pa.instagram_handle || pa.nome || codigo);

        etapa = 'criando o cupom na Shopify';
        let shopifyId = null, shopifyErro = null;
        try { shopifyId = await criarCupomShopify({ codigo, pct: desconto, combinavel: !!d.combinavel }); }
        catch (e) { shopifyErro = e.message; }

        // O link curto é um extra: se falhar, a pessoa recebe o link longo, que funciona
        // igual. Por isso não aborta a aprovação nem entra em `shopify_erro` — aquilo é
        // reservado para cupom quebrado, que é o defeito que a tela precisa gritar.
        etapa = 'criando o link curto';
        let redirectId = null;
        try { redirectId = await criarLinkCurtoShopify({ codigo, slug }); }
        catch (e) { console.error('link curto falhou para ' + codigo + ':', e.message); }
        const link = redirectId ? linkCurto(codigo) : linkCreator(slug);

        etapa = 'gravando o cupom';
        const cup = (await cli.query(`
          INSERT INTO creator.cupom (parceiro_id, codigo, desconto_pct, comissao_pct,
                                     combinavel, shopify_discount_id, shopify_erro,
                                     link_redirect_id, ativo)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,
          [id, codigo, desconto, comissao, !!d.combinavel, shopifyId, shopifyErro, redirectId])).rows[0];

        etapa = 'atualizando o cadastro';
        const novo = (await cli.query(`
          UPDATE creator.parceiro SET status='ativo', utm_slug=$2, aprovado_em=now(),
                 aprovado_por=$3, decidido_por=$3, arquivado=false,
                 reprovado_em=NULL, reprovado_motivo=NULL, atualizado_em=now()
           WHERE parceiro_id=$1 RETURNING *`, [id, slug, (d.por || 'painel').slice(0, 60)])).rows[0];

        // registra no legado também, para o inventário não ficar desatualizado no dia seguinte
        await cli.query(`
          INSERT INTO creator.legado (codigo, titulo, status_shopify, desconto_pct, combina_pedido,
                                      usos_shopify, classe, parceiro_id, instagram_handle, obs)
          VALUES ($1,$1,$2,$3,$4,0,'nominal',$5,$6,'criado pelo painel na aprovação')
          ON CONFLICT (upper(codigo)) DO UPDATE SET parceiro_id=EXCLUDED.parceiro_id,
                 instagram_handle=EXCLUDED.instagram_handle, sincronizado_em=now()`,
          [codigo, shopifyErro ? 'NAO_CRIADO' : 'ACTIVE', desconto, !!d.combinavel,
           id, novo.instagram_handle]);
        await cli.query('COMMIT');
        invalida();

        // ---- e-mail, por último e fora da transação ----
        // Fora de propósito: e-mail não tem rollback. Se ele falhar, a aprovação continua
        // valendo e o painel oferece reenviar — o contrário perderia o cupom já criado.
        const email = String(d.email || pa.email || '').trim();
        let envio = { estado: 'nao_enviado', detalhe: null };
        if (d.enviar_email !== false) {
          try {
            const props = await eventoAprovacao({ email, nome: novo.nome, cupom: codigo, link,
                                                  desconto, comissao, sexo: pa.sexo });
            envio = { estado: 'evento_enviado', detalhe: null };
            await pool.query(`
              INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,payload)
              VALUES ($1,$2,$3,'aprovacao','evento_enviado',$4)`,
              [id, email, METRICA_APROVACAO, props]);
          } catch (e) {
            envio = { estado: 'falhou', detalhe: e.message };
            await pool.query(`
              INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,detalhe)
              VALUES ($1,$2,$3,'aprovacao','falhou',$4)`,
              [id, email || '(sem e-mail)', METRICA_APROVACAO, e.message]).catch(() => {});
          }
        }

        return json(200, { ok: true, parceiro: normaliza(novo), cupom: normaliza(cup),
                           link, slug, shopify_erro: shopifyErro, email: envio });
      } catch (e) {
        await cli.query('ROLLBACK').catch(() => {});
        return json(200, { ok: false, erro: e.message, etapa });
      } finally { cli.release(); }
    });
  }

  // reenvia o e-mail de aprovação de quem já tem cupom
  if (u.pathname === '/api/reenviar' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    if (!id) return json(400, { erro: 'parceiro ausente' });
    try {
      const r = await pool.query(`
        SELECT p.parceiro_id, p.nome, p.email, p.utm_slug,
               c.codigo, c.desconto_pct, c.comissao_pct, c.shopify_erro, c.link_redirect_id,
               l.sexo
        FROM creator.parceiro p
        LEFT JOIN creator.cupom c ON c.parceiro_id=p.parceiro_id AND c.ativo
        LEFT JOIN creator.leads l ON l.lead_id = p.lead_id
        WHERE p.parceiro_id=$1 ORDER BY c.cupom_id LIMIT 1`, [id]);
      const p = r.rows[0];
      if (!p) return json(404, { erro: 'parceiro não encontrado' });
      if (!p.codigo) return json(400, { erro: 'esta pessoa ainda não tem cupom' });
      // Mandar cupom que não funciona no checkout é pior do que não mandar nada: a pessoa
      // divulga, o seguidor tenta usar, não vale, e quem paga o vexame é o creator.
      if (p.shopify_erro && !u.searchParams.get('mesmo_assim'))
        return json(409, { erro: 'o cupom ' + p.codigo + ' não funciona no checkout: '
          + p.shopify_erro, cupom_quebrado: true });
      // mesmo critério da aprovação: link curto quando existe, longo como rede de segurança
      const link = p.link_redirect_id ? linkCurto(p.codigo) : linkCreator(p.utm_slug);
      const props = await eventoAprovacao({ email: p.email, nome: p.nome, cupom: p.codigo, link,
                                            desconto: p.desconto_pct, comissao: p.comissao_pct,
                                            sexo: p.sexo });
      await pool.query(`
        INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,payload)
        VALUES ($1,$2,$3,'aprovacao','evento_enviado',$4)`,
        [id, p.email, METRICA_APROVACAO, props]);
      return json(200, { ok: true, para: p.email });
    } catch (e) {
      await pool.query(`
        INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,detalhe)
        VALUES ($1,'(reenvio)',$2,'aprovacao','falhou',$3)`,
        [id, METRICA_APROVACAO, e.message]).catch(() => {});
      return json(200, { ok: false, erro: e.message });
    }
  }

  // ---------------- quem seria avisado de uma campanha ----------------
  // GET, sem efeito nenhum: a tela precisa mostrar a lista ANTES de disparar. Mandar e-mail
  // para N pessoas de uma vez é a ação menos reversível deste painel.
  if (u.pathname === '/api/campanha/aviso') {
    const c = +u.searchParams.get('campanha');
    if (!c) return json(400, { erro: 'campanha ausente' });
    try {
      const r = await pool.query(`
        SELECT p.parceiro_id, p.nome, p.email, p.utm_slug, p.instagram_handle,
               cu.codigo AS cupom,
               (SELECT max(el.criado_em) FROM creator.email_log el
                 WHERE el.parceiro_id=p.parceiro_id AND el.campanha_id=$1
                   AND el.estado='evento_enviado')::date AS avisado_em
        FROM creator.campanha_parceiro cp
        JOIN creator.parceiro p ON p.parceiro_id = cp.parceiro_id
        LEFT JOIN creator.cupom cu ON cu.parceiro_id = p.parceiro_id AND cu.ativo
        WHERE cp.campanha_id = $1 AND cp.saiu_em IS NULL
        ORDER BY p.nome`, [c]);
      const cam = (await pool.query(
        `SELECT nome, utm_content, briefing, inicio, fim FROM creator.campanha WHERE campanha_id=$1`,
        [c])).rows[0];
      if (!cam) return json(404, { erro: 'campanha não encontrada' });
      return json(200, { ok: true, campanha: normaliza(cam),
        pessoas: r.rows.map(x => normaliza({ ...x,
          link: linkCreator(x.utm_slug, cam.utm_content) })) });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- avisar os creators de uma campanha ----------------
  // Manda um evento por pessoa. Falha de uma NÃO derruba as outras — e o resultado volta
  // pessoa a pessoa, para a tela poder dizer quem foi e quem não foi em vez de "enviado".
  if (u.pathname === '/api/campanha/avisar' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const d = JSON.parse(b || '{}');
        const c = +d.campanha_id;
        const ids = Array.isArray(d.parceiros) ? d.parceiros.map(Number).filter(Boolean) : [];
        if (!c) return json(400, { erro: 'campanha ausente' });
        if (!ids.length) return json(400, { erro: 'ninguém selecionado' });

        const cam = (await pool.query(
          `SELECT campanha_id, nome, utm_content, briefing, inicio, fim
             FROM creator.campanha WHERE campanha_id=$1`, [c])).rows[0];
        if (!cam) return json(404, { erro: 'campanha não encontrada' });
        // sem utm_content o link da campanha é igual ao link base, e o e-mail estaria
        // avisando de uma mudança que não existe
        if (!cam.utm_content)
          return json(400, { erro: 'esta campanha não tem utm_content — sem ele o link não muda' });

        const pessoas = (await pool.query(`
          SELECT p.parceiro_id, p.nome, p.email, p.utm_slug, cu.codigo AS cupom
          FROM creator.parceiro p
          LEFT JOIN creator.cupom cu ON cu.parceiro_id=p.parceiro_id AND cu.ativo
          WHERE p.parceiro_id = ANY($1)`, [ids])).rows;

        const res = [];
        for (const p of pessoas) {
          const link = linkCreator(p.utm_slug, cam.utm_content);
          try {
            const props = await eventoCampanha({ email: p.email, nome: p.nome, campanha: cam.nome,
              briefing: cam.briefing, cupom: p.cupom, link,
              inicio: cam.inicio, fim: cam.fim });
            await pool.query(`
              INSERT INTO creator.email_log (parceiro_id,campanha_id,para,assunto,tipo,estado,payload)
              VALUES ($1,$2,$3,$4,'campanha','evento_enviado',$5)`,
              [p.parceiro_id, c, p.email, METRICA_CAMPANHA, props]);
            res.push({ parceiro_id: p.parceiro_id, nome: p.nome, ok: true });
          } catch (e) {
            await pool.query(`
              INSERT INTO creator.email_log (parceiro_id,campanha_id,para,assunto,tipo,estado,detalhe)
              VALUES ($1,$2,$3,$4,'campanha','falhou',$5)`,
              [p.parceiro_id, c, p.email || '(sem e-mail)', METRICA_CAMPANHA, e.message]).catch(() => {});
            res.push({ parceiro_id: p.parceiro_id, nome: p.nome, ok: false, erro: e.message });
          }
        }
        invalida();
        return json(200, { ok: true, avisados: res.filter(x => x.ok).length,
                           falharam: res.filter(x => !x.ok), total: res.length });
      } catch (e) { return json(200, { ok: false, erro: e.message }); }
    });
  }

  // ---------------- cadastros: mudar status ----------------
  // POST /api/parceiro?id=1&acao=status&valor=ativo | arquivar | desarquivar | tags
  //
  // A resposta devolve a linha com RETURNING *, ou seja, o que o Postgres tem DEPOIS do
  // UPDATE — não o que a tela achava que ia acontecer. A tela repinta com esse valor, então
  // ver o status novo na tela é a prova de que ele gravou.
  if (u.pathname === '/api/parceiro' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    const acao = u.searchParams.get('acao');
    const valor = u.searchParams.get('valor');
    const por = (u.searchParams.get('por') || 'painel').slice(0, 60);
    const motivo = (u.searchParams.get('motivo') || '').slice(0, 400);
    const tags = (u.searchParams.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!id) return json(400, { erro: 'id ausente' });

    if (acao === 'status') {
      if (!STATUS.includes(valor))
        return json(400, { erro: 'status desconhecido: use ' + STATUS.join(', ') });
      try {
        const r = await pool.query(`
          UPDATE creator.parceiro SET status=$2, decidido_por=$3, atualizado_em=now(),
            arquivado = false,
            aprovado_em  = CASE WHEN $2='ativo'     THEN coalesce(aprovado_em, now()) ELSE aprovado_em END,
            reprovado_em = CASE WHEN $2='reprovado' THEN coalesce(reprovado_em, now()) ELSE NULL END,
            reprovado_motivo = CASE WHEN $2='reprovado' THEN coalesce($4, reprovado_motivo) ELSE NULL END
          WHERE parceiro_id=$1 RETURNING *`, [id, valor, por, motivo || null]);
        if (!r.rows[0]) return json(404, { erro: 'parceiro não encontrado' });
        invalida();                     // a lista mudou: a próxima leitura tem que ser fresca
        return json(200, { ok: true, parceiro: normaliza(r.rows[0]) });
      } catch (e) { return json(200, { ok: false, erro: e.message }); }
    }

    // ---- casar cupom com creator ----
    // O cupom legado chegou só com o código ("JESS"), sem Instagram. Casar é dizer quem é a
    // pessoa. Dois caminhos, e a diferença importa:
    //   - handle livre  → só carimba o handle nesta linha;
    //   - handle JÁ é de outro parceiro → FUNDE, porque `ux_parceiro_handle` é único e porque
    //     duas linhas para a mesma pessoa é exatamente o problema que estamos resolvendo.
    // A fusão move cupom e vendas para o parceiro que já existe e guarda a linha antiga em
    // `_fusao_parceiro`, para dar para desfazer.
    if (acao === 'casar') {
      const h = (u.searchParams.get('handle') || '').trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(h)) return json(400, { erro: 'handle inválido' });
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        const eu = (await cli.query(
          `SELECT * FROM creator.parceiro WHERE parceiro_id=$1 FOR UPDATE`, [id])).rows[0];
        if (!eu) throw new Error('parceiro não encontrado');
        if (eu.instagram_handle) throw new Error('este cadastro já tem Instagram: @' + eu.instagram_handle);

        const dono = (await cli.query(
          `SELECT * FROM creator.parceiro WHERE lower(instagram_handle)=$1 AND parceiro_id<>$2`,
          [h, id])).rows[0];

        let alvo = id, fundido = false;
        if (dono) {
          // `creator._fusao_parceiro` é criada na migração, não aqui: o app roda como
          // `creator_app`, que não tem CREATE no schema. Tentar criar aqui derrubava a fusão
          // inteira com "permission denied" — e passou no meu teste local porque eu tinha
          // subido o servidor com o usuário admin. Teste local tem que usar o mesmo usuário.
          //
          // A linha fundida NÃO é apagada: vira `origem='fundido'` + arquivada, e some das
          // telas pela query. Apagar exigiria DELETE em `parceiro`, que é o grant mais
          // perigoso deste schema — um bug ali varre cadastro. Marcar resolve igual, é
          // reversível, e a própria linha é a trilha de auditoria.
          await cli.query(
            `INSERT INTO creator._fusao_parceiro (parceiro_id,nome,origem,para_parceiro_id,handle)
             VALUES ($1,$2,$3,$4,$5)`, [id, eu.nome, eu.origem, dono.parceiro_id, h]);
          for (const t of ['cupom', 'venda', 'envio', 'custo'])
            await cli.query(`UPDATE creator.${t} SET parceiro_id=$1 WHERE parceiro_id=$2`,
                            [dono.parceiro_id, id]);
          await cli.query(
            `UPDATE creator.acesso SET revogado_em=now() WHERE parceiro_id=$1 AND revogado_em IS NULL`, [id]);
          // solta o utm_slug: o índice é único e a casca não aparece em tela nenhuma, então
          // segurando o slug ela bloqueia em silêncio o link de uma pessoa viva
          await cli.query(
            `UPDATE creator.parceiro SET origem='fundido', arquivado=true, arquivado_em=now(),
               status='reprovado', decidido_por=$2, utm_slug=NULL, atualizado_em=now()
             WHERE parceiro_id=$1`, [id, por]);
          alvo = dono.parceiro_id; fundido = true;
        } else {
          await cli.query(
            `UPDATE creator.parceiro SET instagram_handle=$2, atualizado_em=now(), decidido_por=$3
             WHERE parceiro_id=$1`, [id, h, por]);
        }
        // liga as publicações desse handle ao parceiro certo — é o que faz a ficha e a
        // pontuação passarem a enxergar o conteúdo dessa pessoa
        const pubs = await cli.query(
          `UPDATE creator.publicacao SET parceiro_id=$1
           WHERE lower(instagram_handle)=$2 AND parceiro_id IS DISTINCT FROM $1`, [alvo, h]);

        // O cupom legado veio com o CÓDIGO no lugar do nome ("AURA10"). Agora que sabemos de
        // quem é, o nome do perfil vale mais que o código — mas só troca se ainda for o código,
        // nunca por cima de um nome que alguém escreveu.
        await cli.query(`
          UPDATE creator.parceiro p SET nome = s.nome
          FROM (SELECT nome FROM creator.perfil_snapshot
                 WHERE lower(instagram_handle)=$2 AND nome IS NOT NULL
                 ORDER BY coletado_em DESC LIMIT 1) s
          WHERE p.parceiro_id=$1 AND s.nome <> ''
            AND upper(regexp_replace(p.nome,'[^A-Za-z0-9]','','g'))
                = upper(regexp_replace(coalesce(
                    (SELECT c.codigo FROM creator.cupom c WHERE c.parceiro_id=p.parceiro_id
                      ORDER BY c.cupom_id LIMIT 1), '@@'),'[^A-Za-z0-9]','','g'))`, [alvo, h]);
        await cli.query('COMMIT');
        invalida();
        const r = await pool.query(`SELECT * FROM creator.parceiro WHERE parceiro_id=$1`, [alvo]);
        return json(200, { ok: true, parceiro: normaliza(r.rows[0]), fundido,
                           publicacoes_ligadas: pubs.rowCount });
      } catch (e) {
        await cli.query('ROLLBACK').catch(() => {});
        return json(200, { ok: false, erro: e.message });
      } finally { cli.release(); }
    }

    const acoes = {
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
      invalida();
      return json(200, { ok: true, parceiro: normaliza(r.rows[0]) });
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
        invalida();
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
      invalida();
      return json(200, { ok: true, envio: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // disparo manual de job (o agendador roda sozinho; isto é para não esperar o ciclo)
  if (u.pathname === '/api/job' && req.method === 'POST') {
    const nome = u.searchParams.get('n');
    const fns = { cadastros: () => J.syncCadastros(pool, META, eventoRegistro),
                  tags:  () => J.syncTags(pool, META),
                  perfis:() => J.syncPerfis(pool, META),
                  apify: () => J.syncApify(pool, APIFY) };
    if (!fns[nome]) return json(400, { erro: 'job desconhecido: use cadastros, tags, perfis ou apify' });
    try {
      const r = await fns[nome]();
      invalida();   // o job mexeu no banco — a próxima leitura tem que ser fresca
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

  J.agendar(pool, { META_TOKEN: META, APIFY_TOKEN: APIFY, aoRegistrar: eventoRegistro,
                    onMudanca: () => { invalida(); } });
  if (!APP_SECRET) console.log('  [aviso] META_APP_SECRET vazio — webhook de story recusa POST');
  setInterval(() => recarregar().catch(() => {}), Math.max(60000, TTL / 2)).unref();
});
