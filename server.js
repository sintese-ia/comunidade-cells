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
// Grupo da comunidade de creators no WhatsApp. Vai no e-mail de aprovação: é o único canal
// onde a creator fala com a Cells e com as outras. Em env var porque link de grupo do WhatsApp
// pode ser revogado a qualquer momento e trocar não pode exigir deploy.
const COMUNIDADE_WPP = process.env.COMUNIDADE_WHATSAPP
  || 'https://chat.whatsapp.com/KMN0hiWiLHw1NFJFPxGqlR';
// DECISAO DO GABRIEL, 24/08/2026: cupom de creator e SEMPRE 10%.
// Antes o padrao era 8 (o que a loja tinha em 08/08) e a tela repetia o 8 por conta propria,
// em outro arquivo — dois lugares para o mesmo numero, que e como um deles envelhece calado.
// Agora o numero nasce AQUI e desce para a tela dentro do payload (desconto_padrao).
// Isto muda so o SUGERIDO: os cupons que ja existem continuam com o percentual que tem, e o
// campo do dialogo continua editavel para a excecao.
const DESCONTO_PADRAO = +process.env.DESCONTO_PADRAO || 10;
const COOKIE  = 'cc_sess';
// Os únicos status que um cadastro pode ter. A tela oferece exatamente estes, e o servidor
// recusa qualquer outro — status livre vira dialeto pessoal e quebra todo filtro depois.
const STATUS  = ['pendente', 'ativo', 'pausado', 'reprovado'];
const TOKEN   = require('crypto').createHash('sha256').update('cc|' + SENHA).digest('hex').slice(0, 32);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, max: 4, idleTimeoutMillis: 30000, statement_timeout: 60000,
});

// ⚠️ SEM ISTO O PROCESSO INTEIRO MORRE quando uma conexão OCIOSA cai.
// O `pg` emite 'error' no pool nesse caso; um EventEmitter sem listener de 'error' vira
// exceção não tratada e o Node encerra. Aconteceu aqui em 14/08: `read ETIMEDOUT` numa
// conexão parada derrubou o servidor sem nenhuma requisição em andamento.
// Em produção o Easypanel sobe de novo, então o sintoma é container reiniciando sozinho —
// falha que se cura e por isso não aparece. O pool descarta o cliente quebrado e abre outro;
// o que faltava era só alguém escutar.
pool.on('error', e => console.error('[pg] conexão ociosa caiu (o pool se recupera):', e.message));

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const TPL_CREATOR = fs.readFileSync(path.join(__dirname, 'portal.html'), 'utf8');
const TPL_ENTRAR  = fs.readFileSync(path.join(__dirname, 'entrar.html'), 'utf8');
// A porta do codigo por e-mail nasce DESLIGADA e so liga por env var, de proposito: ligar
// significa que o app passa a mandar e-mail sozinho para creator de verdade assim que
// alguem digita o proprio endereco. Isso e decisao do Gabriel, nao efeito colateral de
// deploy. Com ela desligada, a rota responde e a tela nem oferece a opcao.
const LOGIN_CODIGO = /^(1|on|sim|true)$/i.test(process.env.LOGIN_CODIGO || '');
const CODIGO_MIN   = 10;    // minutos de vida do codigo
const CODIGO_ERROS = 5;     // tentativas erradas antes de queimar
const COOKIE_CR = 'cc_creator';
// Endereço público do portal. Vira link em e-mail, então não pode ser caminho relativo —
// e estava escrito na mão em dois lugares, que é como um deles fica para trás numa mudança.
const PORTAL_URL = (process.env.PORTAL_URL || 'https://comunidade-cells.sinteseia.com.br')
  .replace(/\/+$/, '');
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

// Renomeia o código de resgate na loja. Só o `code` (e o `title`, que é o rótulo do admin) —
// percentual, escopo e ciclos ficam intocados, e é por isso que o input vai enxuto: mandar
// `customerGets` inteiro APAGA o que não vier junto (aprendido em 12/08, quase custou 18
// escopos). O Shopify mescla o que vem parcial.
//
// ⚠️ O pedido ANTIGO continua com o código antigo gravado nele. Renomear não reescreve
// histórico de pedido — a ligação com a pessoa é por `creator.venda.cupom_id`, que não muda.
async function renomearCupomShopify({ discountId, novo }) {
  if (!SHOP_TOKEN) throw new Error('SHOPIFY_TOKEN não configurado');
  const mut = `
    mutation renomear($id: ID!, $d: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $d) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`;
  const r = await postJSON(`https://${SHOP}/admin/api/2025-01/graphql.json`,
    { 'X-Shopify-Access-Token': SHOP_TOKEN },
    { query: mut, variables: { id: discountId, d: { code: novo, title: novo } } });
  if (r.status !== 200) throw new Error('Shopify HTTP ' + r.status + ' ' + String(r.txt).slice(0, 160));
  const erroApi = r.json?.errors?.[0]?.message;
  if (erroApi) throw new Error(erroApi);
  const res = r.json?.data?.discountCodeBasicUpdate;
  if (res?.userErrors?.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  return res?.codeDiscountNode?.id;
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
const METRICA_CODIGO    = 'Creator Codigo Acesso';
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
async function eventoCampanha({ email, nome, campanha, briefing, cupom, link, inicio, fim, anexos }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('sem e-mail no cadastro');
  // ⚠️ O arquivo NÃO vai anexado: anexo pesado derruba entregabilidade, e link registra quem
  // baixou o briefing — que é o único sinal de que a campanha foi lida. O link exige login da
  // creator e confere se ela participa da campanha, então mandar por e-mail é seguro.
  // Para o link aparecer no e-mail, o template do Klaviyo precisa imprimir `event.anexos`;
  // enquanto ninguém mexer no template, a propriedade viaja e não é usada — igual ao bloco do
  // WhatsApp de 14/08.
  const corpo = { data: { type: 'event', attributes: {
    properties: { campanha, briefing: briefing || null, cupom: cupom || null, link,
                  inicio: inicio || null, fim: fim || null, nome_creator: nome || null,
                  anexos: (anexos || []).length ? anexos : null },
    metric: { data: { type: 'metric', attributes: { name: METRICA_CAMPANHA } } },
    profile: { data: { type: 'profile', attributes: { email,
               ...(nome ? { first_name: String(nome).split(/\s+/)[0] } : {}) } } },
  } } };
  const r = await postJSON('https://a.klaviyo.com/api/events/',
    { Authorization: 'Klaviyo-API-Key ' + KLAVIYO, revision: '2024-10-15' }, corpo);
  if (r.status !== 202) throw new Error('Klaviyo HTTP ' + r.status + ' ' + String(r.txt).slice(0, 200));
  return corpo.data.attributes.properties;
}

// Codigo de acesso. Mesmo caminho dos outros e-mails: o app manda o evento, o flow do
// Klaviyo entrega. DIFERENCA IMPORTANTE: este e transacional e tem prazo — o codigo vale 10
// minutos. Se o Klaviyo enfileirar, a creator fica olhando para a tela. Por isso o
// email_log guarda a hora do evento: da para medir o atraso real antes de confiar nele.
// O codigo viaja em `codigo` nas properties. Se o template do Klaviyo nao imprimir essa
// propriedade, a pessoa recebe um e-mail sem codigo — testar o template ANTES de ligar.
async function eventoCodigo({ email, nome, codigo, minutos, sexo }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('sem e-mail no cadastro');
  const corpo = { data: { type: 'event', attributes: {
    properties: { codigo, minutos, nome_creator: G.primeiroNome(nome) || null,
                  saudacao: G.saudacaoDe(nome, sexo) },
    metric: { data: { type: 'metric', attributes: { name: METRICA_CODIGO } } },
    profile: { data: { type: 'profile', attributes: { email,
               ...(nome ? { first_name: String(nome).split(/\s+/)[0] } : {}) } } },
  } } };
  const r = await postJSON('https://a.klaviyo.com/api/events/',
    { Authorization: 'Klaviyo-API-Key ' + KLAVIYO, revision: '2024-10-15' }, corpo);
  if (r.status !== 202) throw new Error('Klaviyo HTTP ' + r.status + ' ' + String(r.txt).slice(0, 200));
  // devolve SEM o codigo: este objeto vai para o email_log, e log com codigo dentro e o
  // mesmo que guardar o codigo em texto — o inverso do que a tabela faz de proposito.
  return { minutos, enviado_para: email };
}

async function eventoAprovacao({ email, nome, cupom, link, desconto, comissao,
                                comissao_assinatura, nivel, sexo }) {
  if (!KLAVIYO) throw new Error('KLAVIYO_KEY não configurada');
  if (!email) throw new Error('esta pessoa não tem e-mail no cadastro');
  // A saudação é decidida AQUI, não no template: o Klaviyo não tem como consultar o `sexo`
  // declarado na LP nem rodar a lista de nomes. O template só imprime.
  const corpo = {
    data: {
      type: 'event',
      attributes: {
        properties: { cupom, link, desconto_pct: desconto, comissao_pct: comissao,
                      // a assinatura paga mais que a compra única e o e-mail precisa dizer
                      // os dois números, senão a creator descobre a diferença sozinha depois
                      comissao_assinatura_pct: comissao_assinatura ?? null,
                      nivel: nivel || null,
                      comunidade_whatsapp: COMUNIDADE_WPP,
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
//   utm_source=creator  ·  utm_campaign=<@ da pessoa>
//
// ⚠️ CAMPANHA NÃO TEM LINK PRÓPRIO (decisão do Gabriel, 14/08). O creator divulga UM link
// só — o dele — em toda campanha. O `utmContent` continua existindo no parâmetro para uso
// pontual, mas nenhum fluxo do painel passa mais isso. Resultado de campanha é atribuído
// por creator vinculado + janela de datas, em `creator.vw_campanha_resultado`.
//
// Uma função só, porque link montado em três lugares diferentes vira três convenções
// diferentes na primeira pressa.
// A UTM segue `core.taxonomia_utm` (tipo 'creator') — o padrão da casa, que o dash.sintese lê:
//   source=creator · medium=influencer · campaign=<slug> · content=<iniciativa>
// O `medium` faltava, e é por isso que as sessões antigas do Victor entraram como `organic`.
// As views `creator.vw_clique*` validam contra `core.taxonomia_alias`, então mudar o padrão
// aqui exige mexer LÁ também — não em literal espalhado.
//
// A taxonomia sugere `utm_source=<plataforma>` para link novo. Aqui fica `creator` de propósito:
// o link é agnóstico de plataforma — a mesma URL vai para bio, story, WhatsApp e YouTube.
// Cravar `instagram` seria mentira em parte do tráfego, e a plataforma real vem do referrer.
function linkCreator(slug, utmContent) {
  const q = new URLSearchParams({
    utm_source: 'creator', utm_medium: 'influencer', utm_campaign: slug,
  });
  if (utmContent) q.set('utm_content', utmContent);
  return SITE + '/?' + q.toString();
}

// O link CURTO — cells.com.br/r/<cupom> — é o que a creator divulga.
// Um redirect 301 na própria loja traduz para o link acima, então a atribuição é a mesma:
// o que muda é ela conseguir falar o link em vídeo sem soletrar UTM. Testado 12/08: a Shopify
// preserva a query string no destino e casa o path sem diferenciar maiúscula de minúscula.
//
// Desde 14/08 vale para CAMPANHA também: como não existe mais link por campanha, o aviso de
// campanha manda exatamente o mesmo link curto que a pessoa já divulga. Antes ele mandava um
// link longo diferente, e a creator recebia duas URLs para a mesma coisa.
function linkCurto(codigo) {
  return SITE + '/r/' + String(codigo).toLowerCase();
}

// A REGRA ÚNICA de qual link mandar para uma pessoa: curto quando o redirect existe, longo
// como rede de segurança. Aprovação, reenvio e aviso de campanha usam esta mesma função —
// antes cada um decidia por conta e o aviso de campanha mandava uma URL diferente das outras
// duas, então a mesma creator recebia dois links para o mesmo destino.
// Espera { link_redirect_id, utm_slug } e o código do cupom — que vem como `codigo` numa
// query e aliasado como `cupom` na outra; aceita os dois em vez de exigir que as queries
// concordem, que é o tipo de detalhe que quebra calado meses depois.
function linkDoCreator(p) {
  if (!p) return linkCreator(undefined);
  // ⚠️ Usa `link_path` — o caminho que o redirect REALMENTE tem na loja — e só cai no código
  // do cupom como último recurso. Derivar do código é uma suposição: na renomeação, a troca
  // do redirect é a única das quatro frentes que pode falhar sem derrubar o resto, e quando
  // ela falha o código é o novo e o redirect ainda é o antigo. O link derivado daria 404 na
  // mão da creator, com o cupom funcionando — ninguém descobriria.
  if (p.link_path) return SITE + p.link_path;
  const cod = p.codigo || p.cupom;
  return p.link_redirect_id && cod ? linkCurto(cod) : linkCreator(p.utm_slug);
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
      // mesma convenção do linkCreator() — se divergir, o link curto e o longo passam a
      // classificar em lugares diferentes no dash
      target: '/?' + new URLSearchParams({
        utm_source: 'creator', utm_medium: 'influencer', utm_campaign: slug,
      }).toString(),
    } } });
  if (r.status !== 200) throw new Error('Shopify HTTP ' + r.status + ' ' + String(r.txt).slice(0, 160));
  const erroApi = r.json?.errors?.[0]?.message;
  if (erroApi) throw new Error(erroApi);
  const res = r.json?.data?.urlRedirectCreate;
  if (res?.userErrors?.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  const id = res?.urlRedirect?.id;
  if (!id) throw new Error('a Shopify não devolveu o id do redirect');
  // devolve o PATH junto: é ele que vai para creator.cupom.link_path, e o que a loja gravou
  // é a única fonte confiável do caminho — supor que é `/r/<codigo>` é a suposição que este
  // campo existe para desfazer.
  return { id, path: res?.urlRedirect?.path || ('/r/' + String(codigo).toLowerCase()) };
}

// O link curto é `/r/<cupom>`, então renomear o cupom SEM mexer aqui deixaria a creator com um
// link que não bate mais com o código que ela fala. Este é o quarto lado do rename — os outros
// três são a loja, `creator.cupom` e `creator.legado`.
async function renomearLinkCurtoShopify({ redirectId, novo }) {
  if (!SHOP_TOKEN) throw new Error('SHOPIFY_TOKEN não configurado');
  const mut = `
    mutation mover($id: ID!, $r: UrlRedirectInput!) {
      urlRedirectUpdate(id: $id, urlRedirect: $r) {
        urlRedirect { id path }
        userErrors { field message }
      }
    }`;
  const r = await postJSON(`https://${SHOP}/admin/api/2025-01/graphql.json`,
    { 'X-Shopify-Access-Token': SHOP_TOKEN },
    { query: mut, variables: { id: redirectId,
      r: { path: '/r/' + String(novo).toLowerCase() } } });
  if (r.status !== 200) throw new Error('Shopify HTTP ' + r.status + ' ' + String(r.txt).slice(0, 160));
  const erroApi = r.json?.errors?.[0]?.message;
  if (erroApi) throw new Error(erroApi);
  const res = r.json?.data?.urlRedirectUpdate;
  if (res?.userErrors?.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
  return res?.urlRedirect?.path;
}

// ---------------------------------------------------------------- conta da creator
// ⚠️ O cookie da creator era assinado com a SENHA do admin. Dois níveis de confiança dividindo
// o mesmo segredo: trocar a senha do painel derrubaria o acesso de TODAS as creators de uma
// vez, sem aviso e sem ninguém ligar uma coisa à outra. Agora o segredo é próprio, nasce
// sozinho no primeiro boot e mora em `creator.segredo` — não depende de alguém lembrar de
// criar env var no Easypanel, que é exatamente o passo que ninguém dá.
let SEGREDO_CR = null;
async function segredoCreator() {
  if (SEGREDO_CR) return SEGREDO_CR;
  const r = await pool.query(`SELECT valor FROM creator.segredo WHERE chave='cookie_creator'`);
  if (r.rows[0]) return (SEGREDO_CR = r.rows[0].valor);
  const novo = crypto.randomBytes(32).toString('base64url');
  // ON CONFLICT: dois containers subindo juntos gerariam dois segredos e um venceria — com
  // o DO NOTHING + re-SELECT, os dois terminam com o mesmo.
  await pool.query(
    `INSERT INTO creator.segredo (chave, valor) VALUES ('cookie_creator', $1)
     ON CONFLICT (chave) DO NOTHING`, [novo]);
  const r2 = await pool.query(`SELECT valor FROM creator.segredo WHERE chave='cookie_creator'`);
  return (SEGREDO_CR = r2.rows[0].valor);
}
const assinaCreator = pid =>
  crypto.createHmac('sha256', SEGREDO_CR).update('cr|' + pid).digest('hex').slice(0, 32);

// senha: scrypt com salt por pessoa. A senha em si nunca é gravada nem logada.
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(String(senha).normalize('NFKC'), salt, 32, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), h.toString('base64')].join('$');
}
function confereSenha(senha, guardado) {
  try {
    const [alg, N, r, p, salt, hash] = String(guardado || '').split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(String(senha).normalize('NFKC'), Buffer.from(salt, 'base64'), 32,
      { N: +N, r: +r, p: +p });
    const esperado = Buffer.from(hash, 'base64');
    // timingSafeEqual estoura se os tamanhos diferem — comparar antes, não deixar lançar
    return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
  } catch (e) { return false; }
}

const digitos = s => String(s || '').replace(/\D/g, '');

// CPF/CNPJ: dígito verificador de verdade. Só contar caracteres deixa passar "11111111111",
// e aí o PIX volta do banco e ninguém sabe por quê.
function cpfValido(v) {
  const c = digitos(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (base, peso) => {
    const s = base.split('').reduce((a, d, i) => a + +d * (peso - i), 0);
    const x = (s * 10) % 11; return x === 10 ? 0 : x;
  };
  return dv(c.slice(0, 9), 10) === +c[9] && dv(c.slice(0, 10), 11) === +c[10];
}
function cnpjValido(v) {
  const c = digitos(v);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = base => {
    let peso = base.length === 12 ? 5 : 6, s = 0;
    for (const d of base) { s += +d * peso; peso = peso === 2 ? 9 : peso - 1; }
    const x = s % 11; return x < 2 ? 0 : 11 - x;
  };
  return dv(c.slice(0, 12)) === +c[12] && dv(c.slice(0, 13)) === +c[13];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// A chave PIX precisa bater com o TIPO. Chave errada não dá erro na hora — dá erro na hora
// de pagar, semanas depois, quando ninguém lembra mais.
function pixValido(tipo, chave) {
  const c = String(chave || '').trim();
  if (!c) return 'informe a chave';
  if (tipo === 'cpf')      return cpfValido(c)  ? null : 'CPF inválido';
  if (tipo === 'cnpj')     return cnpjValido(c) ? null : 'CNPJ inválido';
  if (tipo === 'email')    return EMAIL_RE.test(c) ? null : 'e-mail inválido';
  if (tipo === 'telefone') return [10, 11, 12, 13].includes(digitos(c).length)
    ? null : 'telefone inválido — use DDD + número';
  if (tipo === 'aleatoria') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(c) ? null : 'chave aleatória tem o formato 8-4-4-4-12';
  return 'tipo de chave desconhecido';
}

const UF = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR',
            'PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

// corpo JSON com teto. Sem teto, um POST gigante come a memória do container.
//
// ⚠️ `req.destroy()` mata o socket ANTES de qualquer resposta sair — o cliente vê "socket hang
// up", que o portal traduz como "sem conexão com o servidor". Ou seja: um texto colado grande
// demais no complemento do endereço se disfarçava de queda de internet, e a creator tentava de
// novo, igual, para sempre. Agora para de ler mas deixa o socket vivo, para o handler conseguir
// responder 413 com uma frase que explica o que houve.
function corpoJSON(req, limite = 8192) {
  return new Promise((ok, falha) => {
    let b = '', estourou = false;
    req.on('data', c => {
      if (estourou) return;
      b += c;
      if (b.length > limite) {
        estourou = true;
        req.pause();
        const e = new Error('o texto enviado é grande demais'); e.grande = true; falha(e);
      }
    });
    req.on('end', () => { if (!estourou) { try { ok(JSON.parse(b || '{}')); }
                                          catch (e) { falha(new Error('JSON inválido')); } } });
    req.on('error', falha);
  });
}

// Grava campo a campo e deixa rastro. Sem o rastro, "meu PIX sumiu" não tem resposta — e o
// painel do Gabriel edita os MESMOS campos, então saber quem mexeu é o que resolve a briga.
async function salvarCampos(parceiroId, campos, por) {
  const nomes = Object.keys(campos);
  if (!nomes.length) return 0;
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [antes] } = await cli.query(
      `SELECT ${nomes.map(c => `"${c}"`).join(',')} FROM creator.parceiro
        WHERE parceiro_id=$1 FOR UPDATE`, [parceiroId]);
    // ⚠️ Coluna `date` volta do node-pg como Date, e String(Date) dá "Sat Aug 08 2026 …".
    // Comparado com "2026-08-08" isso nunca bate: cada gravação acharia que a data mudou e
    // encheria o rastro de edição fantasma. Mesma armadilha que quebrou a edição de campanha
    // em 14/08 — lá saía "Sat Aug 08" na tela; aqui sairia calada, só no log.
    const txt = v => v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`
        + `-${String(v.getDate()).padStart(2, '0')}`
      : String(v ?? '');
    const mudou = nomes.filter(c => txt(antes[c]) !== txt(campos[c]));
    if (!mudou.length) { await cli.query('ROLLBACK'); return 0; }
    await cli.query(
      `UPDATE creator.parceiro SET ${mudou.map((c, i) => `"${c}"=$${i + 2}`).join(',')},
              atualizado_em = now() WHERE parceiro_id=$1`,
      [parceiroId, ...mudou.map(c => campos[c])]);
    for (const c of mudou) await cli.query(
      `INSERT INTO creator.parceiro_edicao (parceiro_id,campo,valor_antigo,valor_novo,por)
       VALUES ($1,$2,$3,$4,$5)`,
      [parceiroId, c, antes[c] == null ? null : String(antes[c]),
       campos[c] == null ? null : String(campos[c]), por]);
    await cli.query('COMMIT');
    return mudou.length;
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; }
  finally { cli.release(); }
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
  // ⚠️ Esta função é a tela que a CREATOR abre — ela não tem cache, roda por requisição.
  // Em 14/08 ela levava 15s, e 14,7s eram uma única query (`creator.vw_placar`). Se um dia
  // voltar a arrastar, medir aqui antes de culpar a rede: envolver `q` num Date.now() e
  // logar. Foi assim que apareceu.
  const t0Total = Date.now();
  const q = (sql, p) => pool.query(sql, p).then(r => r.rows);
  // `senha_hash` NÃO sai daqui — este objeto é serializado dentro do HTML que vai para o
  // navegador dela. Sai só o booleano `tem_senha`.
  const [pa] = await q(`
    SELECT p.parceiro_id, p.nome, p.instagram_handle, p.tiktok_handle, p.utm_slug, p.tags,
           p.status, p.email, p.telefone_e164, p.cpf, p.cnpj, p.nascimento,
           p.pix_tipo, p.pix_chave,
           p.end_cep, p.end_logradouro, p.end_numero, p.end_complemento,
           p.end_bairro, p.end_cidade, p.end_uf, p.end_aos_cuidados,
           (p.senha_hash IS NOT NULL) AS tem_senha,
           to_char(p.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS desde,
           c.codigo AS cupom, c.link_redirect_id, c.link_path,
           l.idade AS idade_declarada
    FROM creator.parceiro p
    -- ⚠️ LATERAL COM ORDEM, não JOIN solto. Duas creators têm mais de um cupom ativo (JESS
    -- tem 2, Lucas tem 3, todos com venda). Com o LEFT JOIN sem ordem, esta query devolvia
    -- N linhas e o código pegava a primeira — que o Postgres não promete ser sempre a mesma.
    -- A creator podia ver um cupom hoje e outro amanhã, na tela de onde ela COPIA o cupom.
    -- Agora é sempre o mais antigo (o cupom_id menor), que é o cupom principal dela; os
    -- outros vão na lista de cupons montada logo abaixo. (Sem crase neste comentário: crase
    -- dentro de template literal encerra a string — terceira vez que isso quebra o arquivo.)
    LEFT JOIN LATERAL (
      SELECT codigo, link_redirect_id, link_path FROM creator.cupom
       WHERE parceiro_id = p.parceiro_id AND ativo ORDER BY cupom_id LIMIT 1) c ON true
    -- ⚠️ SÓ a idade sai do lead aqui (e nada de crase neste comentário: crase dentro de
    -- template literal encerra a string — já quebrou este arquivo duas vezes).
    -- Todo o resto (CPF, PIX, endereço) já foi para creator.parceiro pelo job "ficha" — é lá
    -- que a creator edita, e ler as duas fontes na tela faria o valor "voltar" depois que
    -- ela apagasse.
    -- A idade fica de fora do job de propósito: o formulário perguntou IDADE, não data de
    -- nascimento, e idade envelhece. Ela aparece como o que é — uma declaração datada — para
    -- o campo de nascimento não ficar em branco sem explicação.
    LEFT JOIN LATERAL (
      SELECT x.idade FROM creator.leads x
       WHERE (x.lead_id = p.lead_id
              OR lower(regexp_replace(coalesce(x.instagram_handle,''),'^@','')) =
                 lower(coalesce(p.instagram_handle,'')))
         AND x.idade IS NOT NULL
       ORDER BY (x.lead_id = p.lead_id) DESC, x.criado_em DESC LIMIT 1) l ON true
    WHERE p.parceiro_id = $1`, [parceiroId]);
  if (!pa) return null;
  // ⚠️ O LINK VEM DAQUI, PRONTO. O portal montava o dele e usava `utm_medium=organic` — o
  // valor que a taxonomia da casa aposentou em 12/08 — e sempre o link longo, mesmo para
  // quem já tinha o curto. Ou seja: a tela onde a creator COPIA o link entregava justamente
  // a versão errada. Agora é a mesma `linkDoCreator()` da aprovação e do aviso de campanha.
  pa.link = linkDoCreator(pa);

  // TODOS os cupons ativos dela, com o link de cada um. A tela somava as vendas de todos e
  // mostrava um só: quem tem 3 cupons via um número que não fechava com o cupom exibido, e
  // divulgava um código sozinho achando que os outros tinham morrido.
  const cupons = (await q(`
    SELECT codigo, link_redirect_id, link_path FROM creator.cupom
     WHERE parceiro_id=$1 AND ativo ORDER BY cupom_id`, [parceiroId]))
    .map(c => ({ codigo: c.codigo, link: linkDoCreator({ ...c, cupom: c.codigo }) }));

  // Só o acumulado da vida. Os números DO MÊS saem do extrato, no navegador — assim o que
  // está escrito em cima é, por construção, a soma dos pedidos listados embaixo. Quando o
  // total vinha de um SELECT e a lista de outro, os dois podiam divergir e ninguém veria.
  // (Os antigos `pedidos_mes`/`receita_mes` daqui ainda cortavam o mês por UTC.)
  const [v] = await q(`
    SELECT count(*)::int AS pedidos, coalesce(sum(receita_liquida),0) AS receita,
           round(avg(receita_liquida),2) AS ticket
    FROM creator.vw_venda_valida WHERE parceiro_id=$1`, [parceiroId]);

  // ⚠️ `dia` é o dia de SÃO PAULO, calculado aqui, e é ele que a tela usa para saber a que MÊS
  // o pedido pertence. Não devolvo `pedido_em` cru para o navegador porque node-pg entrega
  // timestamptz como Date e o mês sairia do fuso de quem abriu a página — uma creator em
  // Lisboa veria pedido da meia-noite de 31/07 como agosto.
  // Sem LIMIT apertado: o creator com mais pedidos na base tem 28, e a tela agora fatia por
  // mês — cortar em 60 esconderia os meses antigos justamente de quem mais vendeu.
  // ⚠️ O extrato lê a tabela CRUA de propósito, e não vw_venda_valida: pedido cancelado tem
  // que APARECER, marcado, e não contar. Sumir com ele é pior — a creator viu a venda
  // acontecer, e um pedido que some sem explicação vira mensagem no DM perguntando o que
  // houve. Quem decide o que soma é a coluna `valida`.
  const extrato = await q(`
    SELECT v.pedido_id, v.pedido_numero, v.receita_liquida, v.cliente_novo,
           coalesce(v.virou_assinatura, false) AS virou_assinatura,
           to_char(v.pedido_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
           (v.cancelado_em IS NULL AND coalesce(v.situacao,'paid') = 'paid'
            AND NOT c.fora_apuracao) AS valida,
           CASE WHEN v.cancelado_em IS NOT NULL THEN 'cancelado'
                WHEN coalesce(v.situacao,'paid') = 'refunded' THEN 'reembolsado'
                WHEN coalesce(v.situacao,'paid') <> 'paid' THEN 'pagamento pendente'
           END AS motivo
    FROM creator.venda v
    JOIN creator.cupom c ON c.cupom_id = v.cupom_id
    WHERE v.parceiro_id=$1 AND v.atribuicao='cupom'
    ORDER BY v.pedido_em DESC LIMIT 500`, [parceiroId]);

  const publicacoes = await q(`
    SELECT u.tipo, u.publicado_em, u.permalink, left(coalesce(u.legenda,''),90) AS legenda,
           to_char(u.publicado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
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

  // ---- campanhas de que ela participa, com briefing e anexos ----
  // `conteudo` NÃO sai daqui: são até 10 MB por arquivo e este objeto é serializado dentro do
  // HTML. Só os metadados; o arquivo vem por /creator/anexo?id=, que confere o vínculo.
  const campanhas = await q(`
    SELECT c.campanha_id, c.nome, c.briefing, c.tipo, c.status,
           to_char(c.inicio,'YYYY-MM-DD') AS inicio,
           to_char(c.fim,'YYYY-MM-DD')    AS fim,
           coalesce((SELECT json_agg(json_build_object(
                       'anexo_id', x.anexo_id, 'nome', x.nome, 'mime', x.mime, 'bytes', x.bytes)
                       ORDER BY x.criado_em)
                       FROM creator.campanha_anexo x
                      WHERE x.campanha_id = c.campanha_id), '[]'::json) AS anexos
      FROM creator.campanha c
      JOIN creator.campanha_parceiro cp ON cp.campanha_id = c.campanha_id
                                        AND cp.parceiro_id = $1 AND cp.saiu_em IS NULL
     WHERE c.status <> 'cancelada'
     ORDER BY c.inicio DESC NULLS LAST`, [parceiroId]);

  // ---- cliques no link (pedido do Gabriel, 14/08) ----
  // Série diária COMPLETA, esparsa: só os dias que tiveram clique. Antes eram 30 dias fixos
  // com generate_series preenchendo os vazios no banco — não serve mais, porque a tela virou
  // mensal e precisa desenhar julho inteiro se a creator escolher julho. Quem preenche os
  // dias vazios agora é o navegador, que já sabe quantos dias tem o mês escolhido.
  // `dia` sai como texto: é chave de mês, não data para fazer conta com fuso.
  const serie = await q(`
    SELECT to_char(dia, 'YYYY-MM-DD') AS dia, sum(cliques)::int AS cliques
      FROM creator.vw_clique_dia WHERE parceiro_id = $1
     GROUP BY dia ORDER BY dia`, [parceiroId]);
  const cl = { total: serie.reduce((a, d) => a + d.cliques, 0),
               ultimo: serie.length ? serie[serie.length - 1].dia : null };

  // ---- nível e comissão ----
  // ⚠️ A comissão é CALCULADA a partir da régua de hoje (creator.nivel_regra), não lida de
  // `creator.venda.comissao_valor` — essa coluna nunca foi preenchida.
  // Por isso a tela só mostra a comissão da JANELA DE 3 MESES, que é a mesma janela que
  // define o nível. Somar a vida inteira aplicaria uma regra de 12/08/2026 a pedido de
  // janeiro/2025 e daria a entender que a Cells deve isso — o que não é verdade.
  const [nv] = await q(`
    SELECT nivel, receita_3m, pedidos_3m, receita_vida, pedidos_vida,
           comissao_unica_pct, comissao_assinatura_pct,
           proximo_nivel, proximo_piso, falta_para_proximo
      FROM creator.vw_nivel WHERE parceiro_id = $1`, [parceiroId]);

  const faixas = await q(
    'SELECT nivel, piso, rotulo, ordem FROM creator.nivel_faixa ORDER BY ordem');

  const pctU = Number(nv?.comissao_unica_pct || 0);
  const pctA = Number(nv?.comissao_assinatura_pct || 0);
  const comissaoDe = vd =>
    Math.round(Number(vd.receita_liquida || 0) * (vd.virou_assinatura ? pctA : pctU)) / 100;

  const [c3] = await q(`
    SELECT coalesce(sum(receita_liquida) FILTER (WHERE NOT coalesce(virou_assinatura,false)),0) AS unica,
           coalesce(sum(receita_liquida) FILTER (WHERE coalesce(virou_assinatura,false)),0) AS assin
      FROM creator.vw_venda_valida
     WHERE parceiro_id=$1
       AND (pedido_em AT TIME ZONE 'America/Sao_Paulo')::date
           >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '3 months')::date`,
    [parceiroId]);
  const comissao3m = Math.round(Number(c3.unica) * pctU + Number(c3.assin) * pctA) / 100;

  // comissão por pedido: o número solto no topo não convence, a linha do extrato convence.
  // Pedido inválido vai com comissão ZERO — a linha aparece, o dinheiro não.
  const extratoCom = extrato.map(e => ({ ...e, comissao: e.valida ? comissaoDe(e) : 0 }));

  // avisa se voltar a arrastar — 15s passou meses sem ninguém notar porque ninguém mediu
  const gasto = Date.now() - t0Total;
  if (gasto > 2000) console.error(`[portal] ${gasto}ms para montar o painel do parceiro ${parceiroId}`);

  // `hoje` vem do servidor em hora de São Paulo. A tela precisa saber qual é o mês corrente
  // para abrir nele, e `new Date()` no navegador responderia com o fuso de quem abriu.
  const [{ hoje }] = await q(
    `SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS hoje`);

  // ---- lista de meses: TODOS, inclusive os sem venda (pedido do Gabriel, 15/08) ----
  // Antes só entravam os meses com movimento, e o seletor pulava de março para novembro —
  // parecia que o painel tinha esquecido o meio do ano. Mês sem venda é informação: é ele que
  // mostra o buraco. Vai da entrada dela no programa (ou da primeira venda, o que veio antes)
  // até o mês corrente, sem furo.
  const desde = [pa.desde, extrato.at(-1)?.dia, serie[0]?.dia,
                 publicacoes.at(-1)?.dia].filter(Boolean).sort()[0] || hoje;
  const meses = [];
  for (let a = +desde.slice(0, 4), m = +desde.slice(5, 7);
       `${a}-${String(m).padStart(2, '0')}` <= hoje.slice(0, 7) && meses.length < 120;) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; a++; }
  }
  meses.reverse();

  return { parceiro: pa, cupons, vendas: v, extrato: extratoCom, publicacoes, envios, jogos, campanhas,
           cliques: { ...cl, serie }, nivel: nv || null, faixas, comissao_3m: comissao3m,
           taxas: { unica: pctU, assinatura: pctA }, hoje, meses };
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

  // ---- portal do creator ----
  // Duas portas: link mágico (?t=) e e-mail/@ + senha. A senha é a porta que sobrevive ao
  // link expirar; o link continua sendo a única forma de ENTRAR a primeira vez, porque
  // ninguém define senha antes de conseguir abrir a tela.
  if (u.pathname === '/creator' || u.pathname.startsWith('/creator/')) {
    await segredoCreator();
    const ck = req.headers.cookie || '';
    const setaCookie = pid =>
      `${COOKIE_CR}=${pid}.${assinaCreator(pid)}; Path=/creator; HttpOnly; Secure; ` +
      `SameSite=Lax; Max-Age=7776000`;

    // quem está logado agora (cookie), independente da rota
    let pid = null;
    const mc = new RegExp(`${COOKIE_CR}=(\\d+)\\.([a-f0-9]{32})`).exec(ck);
    if (mc && mc[2] === assinaCreator(mc[1])) pid = +mc[1];

    // ---- link mágico ----
    if (u.pathname === '/creator' && u.searchParams.get('t')) {
      try {
        const r = await pool.query(`
          UPDATE creator.acesso SET usos = usos + 1, ultimo_uso = now(),
                 primeiro_uso = coalesce(primeiro_uso, now())
          WHERE token = $1 AND revogado_em IS NULL AND expira_em > now()
          RETURNING parceiro_id`, [u.searchParams.get('t')]);
        // ⚠️ Link válido de quem não foi aprovada NÃO vira cookie. A tranca lá embaixo já
        // barra as telas, mas deixar o cookie assinado no navegador dela é guardar uma
        // credencial que passa a valer sozinha no dia em que ela for aprovada — sem ninguém
        // ter mandado o link de novo.
        if (r.rows[0]) {
          const { rows: [sit] } = await pool.query(
            `SELECT status, arquivado FROM creator.parceiro WHERE parceiro_id=$1`,
            [r.rows[0].parceiro_id]);
          if (!sit || sit.arquivado || sit.status !== 'ativo') {
            res.writeHead(403, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
            return res.end(portalErro('Sua inscrição está em análise',
              'A gente ainda está avaliando o seu cadastro. Assim que aprovar, você recebe ' +
              'um e-mail com o seu cupom e o acesso a este painel.'));
          }
        }
        if (!r.rows[0]) {
          res.writeHead(403, {'content-type':'text/html; charset=utf-8'});
          return res.end(portalErro('Este link não vale mais',
            'Ele expirou ou foi desativado. Peça um novo para a equipe da Cells.'));
        }
        // no-store no REDIRECT também, não só na página. Sem isto o navegador guarda o 303 e
        // reentrega a versão antiga da página junto — vi acontecer duas vezes em 15/08,
        // abrindo o link depois de um deploy. Na creator seria pior: ela abriria o link,
        // veria número velho e não teria como saber que é cache.
        res.writeHead(303, { Location: '/creator', 'cache-control': 'no-store',
          'Set-Cookie': setaCookie(r.rows[0].parceiro_id) });
        return res.end();
      } catch (e) {
        res.writeHead(500, {'content-type':'text/html; charset=utf-8'});
        return res.end(portalErro('Deu erro aqui', 'Tente de novo em instantes.'));
      }
    }

    // ---- entrar com e-mail/@ + senha ----
    if (u.pathname === '/creator/entrar' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req, 2048); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      const quem = String(d.identificador || '').trim().replace(/^@/, '').toLowerCase();
      const senha = String(d.senha || '');
      if (!quem || !senha) return json(400, { erro: 'informe seu e-mail (ou @) e a senha' });
      try {
        const { rows } = await pool.query(`
          SELECT parceiro_id, senha_hash, login_falhas, login_travado_ate, status, arquivado
            FROM creator.parceiro
           WHERE senha_hash IS NOT NULL
             AND (lower(email) = $1 OR lower(instagram_handle) = $1)
           ORDER BY parceiro_id LIMIT 2`, [quem]);
        // Resposta idêntica para "não existe" e "senha errada": respostas diferentes contam a
        // quem pergunta quais e-mails estão cadastrados.
        const generico = { erro: 'e-mail/@ ou senha não confere' };
        if (rows.length !== 1) return json(401, generico);
        const p = rows[0];
        if (p.login_travado_ate && new Date(p.login_travado_ate) > new Date())
          return json(429, { erro: 'muitas tentativas. Tente de novo em alguns minutos.' });
        if (!confereSenha(senha, p.senha_hash)) {
          // trava cresce com o número de erros; mora no BANCO, senão cada deploy zera a conta
          const n = (p.login_falhas || 0) + 1;
          await pool.query(
            `UPDATE creator.parceiro SET login_falhas=$2,
                    login_travado_ate = CASE WHEN $2 >= 5
                      THEN now() + least($2 - 4, 30) * interval '2 minutes' ELSE NULL END
              WHERE parceiro_id=$1`, [p.parceiro_id, n]);
          return json(401, generico);
        }
        await pool.query(
          `UPDATE creator.parceiro SET login_falhas=0, login_travado_ate=NULL, ultimo_login=now()
            WHERE parceiro_id=$1`, [p.parceiro_id]);
        // ⚠️ A SENHA CONFERE, MAS A APROVAÇÃO É OUTRA PORTA — e ela vem DEPOIS da senha, de
        // propósito: responder "em análise" antes de conferir a senha contaria a qualquer um
        // que aquele e-mail está cadastrado e em que pé está.
        // Testado em 17/08: sem isto, uma pendente recebia {"ok":true} + o cookie assinado, e
        // só então batia na parede. Dois estragos — a tela dizia "entrou" e jogava num 403; e
        // o cookie ficava 90 dias no navegador dela, valendo sozinho no dia da aprovação, sem
        // ninguém ter reenviado nada. Era o mesmo buraco que eu já tinha fechado no link.
        if (p.arquivado || p.status !== 'ativo')
          return json(403, { erro: 'sua inscrição ainda está em análise — a gente avisa por e-mail assim que aprovar' });
        res.writeHead(200, {'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store', 'Set-Cookie': setaCookie(p.parceiro_id) });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) { return json(500, { erro: 'não consegui entrar agora' }); }
    }

    // ---- entrar com CODIGO enviado por e-mail --------------------------------------
    // Duas rotas: pedir e conferir. O codigo tem 6 digitos, vale 10 minutos, serve UMA vez,
    // e no banco so existe o hash (scrypt, o mesmo da senha) — quem le a tabela nao entra na
    // conta de ninguem.
    //
    // ⚠️ A RESPOSTA E SEMPRE A MESMA, exista a conta ou nao. Responder "nao achei esse
    // e-mail" transforma o formulario numa lista de quem e creator da Cells: qualquer um
    // testa endereco por endereco e descobre. O preco e que quem digita errado nao e
    // avisado — por isso a tela diz "se existir conta, o codigo chegou".
    if (u.pathname === '/creator/codigo' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req, 2048); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      if (!LOGIN_CODIGO) return json(503, { erro: 'esta forma de entrar ainda não está ligada' });
      const email = String(d.email || '').trim().toLowerCase();
      const igual = { ok: true, minutos: CODIGO_MIN };   // a MESMA resposta em todos os caminhos
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { erro: 'digite um e-mail válido' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 60);
      try {
        const { rows } = await pool.query(`
          SELECT parceiro_id, nome, email FROM creator.parceiro
           WHERE lower(email) = $1 AND status = 'ativo' AND NOT arquivado
           ORDER BY parceiro_id LIMIT 2`, [email]);
        // dois cadastros com o mesmo e-mail: nao da para saber para quem e a conta, e mandar
        // codigo para os dois deixaria uma pessoa entrar na conta da outra
        if (rows.length !== 1) return json(200, igual);
        const p = rows[0];

        // Freio. Sem isto, o formulario vira maquina de encher a caixa de alguem: um curioso
        // digita o e-mail da creator e dispara quantos e-mails quiser em nome da Cells.
        const { rows: [uso] } = await pool.query(`
          SELECT count(*) FILTER (WHERE criado_em > now() - interval '1 hour') AS na_hora,
                 max(criado_em) AS ultimo
            FROM creator.acesso_codigo WHERE parceiro_id = $1`, [p.parceiro_id]);
        if (uso.ultimo && Date.now() - new Date(uso.ultimo).getTime() < 60000) return json(200, igual);
        if (+uso.na_hora >= 5) return json(200, igual);

        // randomInt e do crypto: Math.random e previsivel e daria para adivinhar o codigo
        // de outra pessoa a partir do proprio.
        const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

        // pedir codigo novo mata o anterior: dois codigos vivos ao mesmo tempo dobram a
        // superficie e confundem quem tem dois e-mails abertos
        await pool.query(`
          UPDATE creator.acesso_codigo SET invalidado_em = now()
           WHERE parceiro_id = $1 AND usado_em IS NULL AND invalidado_em IS NULL`, [p.parceiro_id]);
        await pool.query(`
          INSERT INTO creator.acesso_codigo (parceiro_id, codigo_hash, expira_em, pedido_ip)
          VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
          [p.parceiro_id, hashSenha(codigo), String(CODIGO_MIN), ip || null]);

        // O e-mail sai por ultimo e fora de qualquer transacao. Se o Klaviyo falhar, o codigo
        // ja existe e a pessoa pode pedir outro — o contrario (e-mail com codigo que o banco
        // nao tem) e que seria insolucionavel para ela.
        try {
          const { rows: [lead] } = await pool.query(
            `SELECT l.sexo FROM creator.parceiro pp
               LEFT JOIN creator.leads l ON l.lead_id = pp.lead_id
              WHERE pp.parceiro_id = $1`, [p.parceiro_id]);
          const props = await eventoCodigo({ email: p.email, nome: p.nome, codigo,
                                             minutos: CODIGO_MIN, sexo: lead && lead.sexo });
          await pool.query(`
            INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,payload)
            VALUES ($1,$2,'Codigo de acesso','codigo','evento_enviado',$3)`,
            [p.parceiro_id, p.email, props]);
        } catch (e) {
          await pool.query(`
            INSERT INTO creator.email_log (parceiro_id,para,assunto,tipo,estado,detalhe)
            VALUES ($1,$2,'Codigo de acesso','codigo','falhou',$3)`,
            [p.parceiro_id, p.email, e.message]).catch(() => {});
          console.error('[codigo]', e.message);
        }
        return json(200, igual);
      } catch (e) { console.error('[codigo]', e.message); return json(200, igual); }
    }

    if (u.pathname === '/creator/codigo/entrar' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req, 2048); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      if (!LOGIN_CODIGO) return json(503, { erro: 'esta forma de entrar ainda não está ligada' });
      const email  = String(d.email || '').trim().toLowerCase();
      const codigo = String(d.codigo || '').replace(/\D/g, '');
      const generico = { erro: 'código não confere ou expirou — peça um novo' };
      if (!email || codigo.length !== 6) return json(400, { erro: 'digite os 6 números do código' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 60);
      try {
        // ⚠️ O MESMO filtro do pedido, e isto mordeu no teste: sem o status aqui, um cadastro
        // velho e arquivado com o mesmo e-mail fazia a contagem dar 2 e a conferencia recusava
        // um codigo legitimo — a pessoa certa, com o codigo certo, levando "nao confere".
        // As duas rotas tem que enxergar exatamente o mesmo conjunto de pessoas.
        const { rows } = await pool.query(`
          SELECT parceiro_id, status, arquivado FROM creator.parceiro
           WHERE lower(email) = $1 AND status = 'ativo' AND NOT arquivado
           ORDER BY parceiro_id LIMIT 2`, [email]);
        if (rows.length !== 1) return json(401, generico);
        const p = rows[0];
        const { rows: [c] } = await pool.query(`
          SELECT codigo_id, codigo_hash, tentativas FROM creator.acesso_codigo
           WHERE parceiro_id = $1 AND usado_em IS NULL AND invalidado_em IS NULL
             AND expira_em > now()
           ORDER BY codigo_id DESC LIMIT 1`, [p.parceiro_id]);
        if (!c) return json(401, generico);

        // 6 digitos sao um milhao de combinacoes: sem teto de tentativa, da para chutar.
        if (c.tentativas >= CODIGO_ERROS) {
          await pool.query(`UPDATE creator.acesso_codigo SET invalidado_em=now() WHERE codigo_id=$1`,
            [c.codigo_id]);
          return json(429, { erro: 'muitas tentativas neste código. Peça um novo.' });
        }
        if (!confereSenha(codigo, c.codigo_hash)) {
          await pool.query(`UPDATE creator.acesso_codigo SET tentativas = tentativas + 1
                             WHERE codigo_id = $1`, [c.codigo_id]);
          return json(401, generico);
        }

        // ⚠️ A aprovacao e conferida DEPOIS do codigo, pelo mesmo motivo da senha: dizer "em
        // analise" antes de conferir contaria a quem perguntasse que aquele e-mail existe.
        if (p.arquivado || p.status !== 'ativo')
          return json(403, { erro: 'sua inscrição ainda está em análise — a gente avisa por e-mail assim que aprovar' });

        // uma vez so: marcar como usado ANTES de entregar o cookie
        const { rowCount } = await pool.query(`
          UPDATE creator.acesso_codigo SET usado_em = now(), usado_ip = $2
           WHERE codigo_id = $1 AND usado_em IS NULL`, [c.codigo_id, ip || null]);
        if (!rowCount) return json(401, generico);   // corrida: alguem usou primeiro

        await pool.query(`UPDATE creator.parceiro SET login_falhas=0, login_travado_ate=NULL,
                                 ultimo_login=now() WHERE parceiro_id=$1`, [p.parceiro_id]);
        res.writeHead(200, {'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store', 'Set-Cookie': setaCookie(p.parceiro_id) });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) { console.error('[codigo]', e.message); return json(500, { erro: 'não consegui entrar agora' }); }
    }

    if (u.pathname === '/creator/sair') {
      res.writeHead(303, { Location: '/creator', 'Set-Cookie':
        `${COOKIE_CR}=; Path=/creator; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      return res.end();
    }

    // ---- o portal é só de quem JÁ FOI APROVADO ----
    // ⚠️ Até 16/08 a única tranca era social: "a gente não manda o link para quem não foi
    // curado". Não é tranca — é combinado. E já estava furado: dos 2 links de acesso que
    // existiam, 1 era de uma pessoa com status `pendente`.
    // Quem ainda não passou pela curadoria não pode ver uma tela que diz o nível dela, a
    // comissão dela e as campanhas da casa — isso é dizer "você está dentro" para alguém que
    // a Cells ainda não decidiu se quer. Vale para link mágico e para senha: a checagem é
    // aqui, num lugar só, depois do `sair` (sair sempre funciona, inclusive para quem foi
    // barrada — senão o cookie fica preso no navegador dela).
    if (pid) {
      const { rows: [sit] } = await pool.query(
        `SELECT status, arquivado FROM creator.parceiro WHERE parceiro_id=$1`, [pid]);
      if (!sit || sit.arquivado || sit.status !== 'ativo') {
        pid = null;
        if (req.method === 'POST') return json(403, { erro: 'sua inscrição ainda está em análise' });
        res.writeHead(403, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
        return res.end(portalErro('Sua inscrição está em análise',
          'A gente ainda está avaliando o seu cadastro. Assim que aprovar, você recebe um ' +
          'e-mail com o seu cupom e o acesso a este painel.'));
      }
    }

    // ---- daqui para baixo, precisa estar logada ----
    if (!pid) {
      if (req.method === 'POST') return json(401, { erro: 'sessão expirada — entre de novo' });
      // ⚠️ Rota de DOWNLOAD não pode responder a tela de login com 200: o navegador salvaria
      // o HTML da tela num arquivo chamado "anexo" e a creator abriria isso achando que é o
      // briefing. Redireciona, e a tela de login aparece como tela.
      if (u.pathname === '/creator/anexo') {
        res.writeHead(303, { Location: '/creator', 'cache-control': 'no-store' });
        return res.end();
      }
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      // a tela precisa saber se a porta do codigo esta ligada — se nao estiver, ela nem
      // oferece, para nao prometer um e-mail que o servidor vai recusar a mandar
      return res.end(TPL_ENTRAR.replace('__CODIGO__', LOGIN_CODIGO ? 'true' : 'false'));
    }

    // ---- salvar perfil ----
    if (u.pathname === '/creator/perfil' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      const txt = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
      const email = txt(d.email, 160);
      if (email && !EMAIL_RE.test(email)) return json(400, { erro: 'e-mail inválido' });
      const tel = digitos(d.telefone);
      if (tel && ![10, 11].includes(tel.length))
        return json(400, { erro: 'telefone inválido — use DDD + número' });
      // ⚠️ Conferir o FORMATO não é conferir a DATA. Testado em 17/08: "2026-13-45" passava na
      // regex, chegava ao Postgres e voltava como 500 "não consegui salvar agora" — erro de
      // digitação virando falha de servidor. E "1899-01-01" e "2030-01-01" eram ACEITOS e
      // gravados: data de nascimento no futuro entrando calada no cadastro.
      const nasc = txt(d.nascimento, 10);
      if (nasc) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nasc)) return json(400, { erro: 'data de nascimento inválida' });
        const [aa, mm, dd] = nasc.split('-').map(Number);
        const dt = new Date(Date.UTC(aa, mm - 1, dd));
        // o round-trip pega 31/02: o Date normaliza para 03/03 e os componentes deixam de bater
        if (dt.getUTCFullYear() !== aa || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd)
          return json(400, { erro: 'essa data não existe' });
        const hoje = new Date();
        if (dt > hoje) return json(400, { erro: 'data de nascimento no futuro' });
        if (aa < hoje.getUTCFullYear() - 110) return json(400, { erro: 'confira o ano de nascimento' });
      }
      const uf = txt(d.end_uf, 2);
      if (uf && !UF.includes(uf.toUpperCase())) return json(400, { erro: 'UF inválida' });
      const cep = digitos(d.end_cep);
      if (cep && cep.length !== 8) return json(400, { erro: 'CEP precisa ter 8 dígitos' });

      // ⚠️ `instagram_handle` NÃO entra aqui. Ele é a chave que liga a creator às publicações
      // capturadas, ao utm_slug e ao login — deixar ela trocar sozinha órfã o histórico dela.
      // Troca de @ passa pela equipe, que sabe migrar o resto junto.
      const campos = {
        nome: txt(d.nome, 120), email,
        telefone_e164: tel ? '+55' + tel : null,
        nascimento: nasc,
        end_cep: cep || null, end_logradouro: txt(d.end_logradouro, 160),
        end_numero: txt(d.end_numero, 20), end_complemento: txt(d.end_complemento, 80),
        end_bairro: txt(d.end_bairro, 90), end_cidade: txt(d.end_cidade, 90),
        end_uf: uf ? uf.toUpperCase() : null,
        end_aos_cuidados: txt(d.end_aos_cuidados, 120),
      };
      try {
        const n = await salvarCampos(pid, campos, 'creator');
        return json(200, { ok: true, campos: n });
      } catch (e) { return json(500, { erro: 'não consegui salvar agora' }); }
    }

    // ---- salvar dados de pagamento ----
    if (u.pathname === '/creator/financeiro' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req, 2048); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      const doc = digitos(d.documento), tipoDoc = d.doc_tipo === 'cnpj' ? 'cnpj' : 'cpf';
      if (doc) {
        if (tipoDoc === 'cpf'  && !cpfValido(doc))  return json(400, { erro: 'CPF inválido' });
        if (tipoDoc === 'cnpj' && !cnpjValido(doc)) return json(400, { erro: 'CNPJ inválido' });
      }
      const pixTipo = d.pix_tipo ? String(d.pix_tipo) : null;
      const pixChave = String(d.pix_chave ?? '').trim() || null;
      if (pixTipo || pixChave) {
        if (!pixTipo || !pixChave) return json(400, { erro: 'escolha o tipo e informe a chave' });
        const erro = pixValido(pixTipo, pixChave);
        if (erro) return json(400, { erro });
      }
      // A chave PIX tem que ser do titular do documento — o banco recusa transferência para
      // chave de terceiro, e a recusa só aparece no dia do pagamento.
      if (pixTipo === 'cpf'  && doc && digitos(pixChave) !== doc)
        return json(400, { erro: 'a chave CPF precisa ser o mesmo CPF do titular' });
      if (pixTipo === 'cnpj' && doc && digitos(pixChave) !== doc)
        return json(400, { erro: 'a chave CNPJ precisa ser o mesmo CNPJ do titular' });

      const campos = { pix_tipo: pixTipo, pix_chave: pixChave };
      campos[tipoDoc] = doc || null;
      // trocar de CPF para CNPJ (ou o contrário) tem que limpar o outro, senão sobram os dois
      // e ninguém sabe qual vale na hora de pagar
      campos[tipoDoc === 'cpf' ? 'cnpj' : 'cpf'] = null;
      try {
        const n = await salvarCampos(pid, campos, 'creator');
        return json(200, { ok: true, campos: n });
      } catch (e) { return json(500, { erro: 'não consegui salvar agora' }); }
    }

    // ---- definir ou trocar a senha ----
    if (u.pathname === '/creator/senha' && req.method === 'POST') {
      let d; try { d = await corpoJSON(req, 2048); } catch (e) { return json(e.grande ? 413 : 400, { erro: e.message }); }
      const nova = String(d.nova || '');
      if (nova.length < 8) return json(400, { erro: 'a senha precisa ter pelo menos 8 caracteres' });
      if (nova.length > 200) return json(400, { erro: 'senha longa demais' });
      try {
        const { rows: [p] } = await pool.query(
          `SELECT senha_hash, email, instagram_handle FROM creator.parceiro WHERE parceiro_id=$1`, [pid]);
        // Já tem senha? Exige a atual. Sem isso, um celular emprestado com a sessão aberta
        // troca a senha e tranca a dona para fora da própria conta.
        if (p.senha_hash && !confereSenha(String(d.atual || ''), p.senha_hash))
          return json(401, { erro: 'a senha atual não confere' });
        if (!p.email && !p.instagram_handle)
          return json(400, { erro: 'preencha seu e-mail em Perfil antes — é ele que você usa para entrar' });
        await pool.query(
          `UPDATE creator.parceiro SET senha_hash=$2, senha_em=now(), login_falhas=0,
                  login_travado_ate=NULL WHERE parceiro_id=$1`, [pid, hashSenha(nova)]);
        // no rastro entra só o FATO, nunca o hash e muito menos a senha
        await pool.query(
          `INSERT INTO creator.parceiro_edicao (parceiro_id,campo,valor_antigo,valor_novo,por)
           VALUES ($1,'senha',NULL,$2,'creator')`,
          [pid, p.senha_hash ? 'trocada' : 'definida']);
        return json(200, { ok: true, entrar_com: p.email || '@' + p.instagram_handle });
      } catch (e) { return json(500, { erro: 'não consegui salvar a senha agora' }); }
    }

    // ---- baixar anexo de campanha ----
    // ⚠️ O vínculo é conferido AQUI, contra o parceiro_id do cookie. Sem esta checagem,
    // qualquer creator logada baixaria o briefing de qualquer campanha só trocando o número
    // na URL — inclusive de campanha que ela não participa.
    if (u.pathname === '/creator/anexo') {
      const anexo = +u.searchParams.get('id');
      if (!anexo) { res.writeHead(400); return res.end('anexo ausente'); }
      try {
        const { rows: [a] } = await pool.query(`
          SELECT x.anexo_id, x.nome, x.mime, x.conteudo
            FROM creator.campanha_anexo x
            JOIN creator.campanha_parceiro cp ON cp.campanha_id = x.campanha_id
                                             AND cp.parceiro_id = $2 AND cp.saiu_em IS NULL
           WHERE x.anexo_id = $1`, [anexo, pid]);
        if (!a) {
          res.writeHead(404, {'content-type':'text/html; charset=utf-8'});
          return res.end(portalErro('Arquivo não encontrado',
            'Ou ele foi removido, ou é de uma campanha da qual você não participa.'));
        }
        // quem baixou o briefing é o único sinal de que a campanha foi LIDA
        pool.query(`
          INSERT INTO creator.campanha_anexo_download (anexo_id, parceiro_id)
          VALUES ($1,$2)
          ON CONFLICT (anexo_id, parceiro_id)
          DO UPDATE SET vezes = creator.campanha_anexo_download.vezes + 1, ultimo_em = now()`,
          [anexo, pid]).catch(e => console.error('[anexo] não registrei o download:', e.message));
        pool.query(`UPDATE creator.campanha_anexo
                       SET baixados = baixados + 1, ultimo_download = now()
                     WHERE anexo_id = $1`, [anexo]).catch(() => {});

        res.writeHead(200, {
          'content-type': a.mime,
          // filename entre aspas e sem caractere de controle: o nome já foi higienizado na
          // subida, mas o header é o lugar onde um nome torto vira injeção de cabeçalho
          'content-disposition': `attachment; filename="${String(a.nome).replace(/["\r\n]/g, '')}"`,
          'content-length': a.conteudo.length,
          'cache-control': 'private, no-store',
        });
        return res.end(a.conteudo);
      } catch (e) {
        res.writeHead(500, {'content-type':'text/html; charset=utf-8'});
        return res.end(portalErro('Deu erro aqui', 'Tente de novo em instantes.'));
      }
    }

    // ---- a tela ----
    if (u.pathname === '/creator') {
      try {
        const d = await dadosDoCreator(pid);
        if (!d) { res.writeHead(404, {'content-type':'text/html; charset=utf-8'});
          return res.end(portalErro('Não encontrei seu cadastro', 'Fale com a equipe da Cells.')); }
        res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
        // replace com FUNÇÃO: com string, um `$&` ou `$'` dentro do JSON (nome de cupom, legenda
        // de post) viraria padrão de substituição e reescreveria o payload sozinho.
        const dados = JSON.stringify(d).replace(/</g, '\\u003c');
        return res.end(TPL_CREATOR.replace('__DADOS__', () => dados));
      } catch (e) {
        res.writeHead(500, {'content-type':'text/html; charset=utf-8'});
        return res.end(portalErro('Deu erro aqui', 'Tente de novo em instantes.'));
      }
    }
    return json(404, { erro: 'rota não existe' });
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
      return json(200, { ok: true, url: PORTAL_URL + '/creator?t=' + tok,
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

        // `cancelada` NÃO é o mesmo que `encerrada`, e a diferença importa na hora de ler
        // resultado: encerrada é a campanha que rodou até o fim, cancelada é a que foi
        // interrompida. Juntar as duas faz uma campanha abortada parecer performance ruim.
        const STATUS_OK = ['rascunho','ativa','encerrada','cancelada','arquivada'];

        const data = (v, padrao) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : padrao;

        // ⚠️ Coluna `date` volta do node-pg como objeto Date, não string. `String(d).slice(0,10)`
        // devolve "Sat Aug 08" e o Postgres recusa na volta com "invalid input syntax for type
        // date". E toISOString() não serve: a Date nasce à MEIA-NOITE LOCAL, então em fuso
        // negativo ela vira 03:00Z (ok) mas em fuso positivo cairia no dia anterior.
        // Por isso a formatação é pelos componentes locais.
        const ymd = v => {
          if (!v) return null;
          if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}`
            + `-${String(v.getDate()).padStart(2,'0')}`;
          return String(v).slice(0, 10);
        };

        // mudar só o status (ativar, encerrar, cancelar, arquivar) — não mexe no resto
        if (d.campanha_id && d.status && !d.nome) {
          if (!STATUS_OK.includes(d.status))
            return json(400, { erro: 'status desconhecido' });
          const r = await cli.query(
            `UPDATE creator.campanha SET status=$2 WHERE campanha_id=$1 RETURNING *`,
            [d.campanha_id, d.status]);
          invalida(); return json(200, { ok: true, campanha: r.rows[0] });
        }

        // ---- EDITAR campanha que já existe ----
        // Antes só dava para criar: definir prazo depois da criação exigia refazer tudo.
        // `tipo` fica de fora de propósito — trocar comissão↔pontuação órfãna o jogo e as
        // missões já criadas, e isso é campanha nova, não edição.
        if (d.campanha_id && d.nome) {
          const [atual] = (await cli.query(
            'SELECT * FROM creator.campanha WHERE campanha_id=$1', [d.campanha_id])).rows;
          if (!atual) return json(404, { erro: 'campanha não encontrada' });

          const inicio = data(d.inicio, ymd(atual.inicio) || hoje);
          const fim    = d.fim === '' ? null : data(d.fim, ymd(atual.fim));
          if (fim && fim < inicio) return json(400, { erro: 'a data final é antes da inicial' });

          const pctE = atual.tipo === 'comissao'
            ? Number(String(d.comissao_pct ?? atual.comissao_pct ?? '').replace(',', '.')) : null;
          if (atual.tipo === 'comissao' && !(pctE > 0 && pctE <= 100))
            return json(400, { erro: 'campanha de comissão precisa de um percentual entre 0 e 100' });

          await cli.query('BEGIN');
          const r = await cli.query(
            `UPDATE creator.campanha
                SET nome=$2, briefing=$3, inicio=$4::date, fim=$5::date, comissao_pct=$6
              WHERE campanha_id=$1 RETURNING *`,
            [d.campanha_id, String(d.nome).trim().slice(0, 120), d.briefing || null,
             inicio, fim, pctE]);
          // a janela do jogo TEM que acompanhar a da campanha, senão a pontuação passa a
          // contar post de fora do período e o placar mente
          await cli.query(
            `UPDATE creator.jogo SET inicio=$2::date, fim=$3::date WHERE campanha_id=$1`,
            [d.campanha_id, inicio, fim]);
          await cli.query('COMMIT');
          invalida();
          return json(200, { ok: true, campanha: r.rows[0] });
        }

        if (!d.nome || !String(d.nome).trim()) return json(400, { erro: 'nome é obrigatório' });
        const tipo = d.tipo === 'pontuacao' ? 'pontuacao' : 'comissao';
        const pct = tipo === 'comissao' ? Number(String(d.comissao_pct || '').replace(',', '.')) : null;
        if (tipo === 'comissao' && !(pct > 0 && pct <= 100))
          return json(400, { erro: 'campanha de comissão precisa de um percentual entre 0 e 100' });
        const acoes = (d.acoes || []).filter(a => a && a.acao && +a.pontos > 0);
        if (tipo === 'pontuacao' && !acoes.length)
          return json(400, { erro: 'campanha de pontuação precisa de pelo menos uma ação com pontos' });
        const inicio = data(d.inicio, hoje);
        const fim    = data(d.fim, null);
        if (fim && fim < inicio) return json(400, { erro: 'a data final é antes da inicial' });

        await cli.query('BEGIN');
        const r = await cli.query(
          `INSERT INTO creator.campanha (nome,briefing,tipo,comissao_pct,inicio,fim,status,
                                         criado_por)
           VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8) RETURNING *`,
          [String(d.nome).trim().slice(0, 120), d.briefing || null, tipo, pct, inicio, fim,
           d.status === 'ativa' ? 'ativa' : 'rascunho', (d.por || 'painel').slice(0, 60)]);
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
  //
  // Duas formas de chamar:
  //   ?campanha=8&parceiro=73[&sair=1]  — uma pessoa (jeito antigo, ainda usado pelo "×")
  //   corpo JSON { campanha_id, parceiros:[...] } ou { campanha_id, todos_ativos:true }
  //
  // O lote existe porque vincular no varejo era 1 chamada + 1 reload de página POR PESSOA:
  // colocar 30 creators numa campanha custava 30 recarregamentos.
  if (u.pathname === '/api/campanha/parceiro' && req.method === 'POST') {
    const cQS = +u.searchParams.get('campanha'), pQS = +u.searchParams.get('parceiro');
    const sai = u.searchParams.get('sair') === '1';

    if (cQS && pQS) {
      try {
        if (sai) await pool.query(
          `UPDATE creator.campanha_parceiro SET saiu_em=now()
            WHERE campanha_id=$1 AND parceiro_id=$2`, [cQS, pQS]);
        else await pool.query(
          `INSERT INTO creator.campanha_parceiro (campanha_id,parceiro_id) VALUES ($1,$2)
           ON CONFLICT (campanha_id,parceiro_id) DO UPDATE SET saiu_em=NULL`, [cQS, pQS]);
        invalida(); return json(200, { ok: true, vinculados: sai ? 0 : 1 });
      } catch (e) { return json(200, { ok: false, erro: e.message }); }
    }

    let b = ''; req.on('data', ch => { b += ch; if (b.length > 200000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const d = JSON.parse(b || '{}');
        const c = +d.campanha_id;
        if (!c) return json(400, { erro: 'campanha é obrigatória' });

        let ids;
        if (d.todos_ativos) {
          // "todos os ativos" resolve NO SERVIDOR, não na tela: a lista que o browser tem
          // pode estar velha (cache de 5 min), e vincular a partir dela deixaria de fora
          // quem foi aprovado nesse meio-tempo.
          ids = (await pool.query(
            `SELECT parceiro_id FROM creator.parceiro
              WHERE status='ativo' AND NOT arquivado AND origem IS DISTINCT FROM 'fundido'`))
            .rows.map(r => r.parceiro_id);
        } else {
          ids = [...new Set((d.parceiros || []).map(Number).filter(Boolean))];
        }
        if (!ids.length) return json(400, { erro: 'nenhum creator selecionado' });

        // unnest: uma ida ao banco em vez de N, e o ON CONFLICT já cobre quem saiu e voltou
        const r = await pool.query(
          `INSERT INTO creator.campanha_parceiro (campanha_id, parceiro_id)
           SELECT $1, x FROM unnest($2::bigint[]) AS x
           ON CONFLICT (campanha_id,parceiro_id) DO UPDATE SET saiu_em=NULL
           RETURNING parceiro_id`, [c, ids]);
        invalida();
        return json(200, { ok: true, vinculados: r.rowCount, pedidos: ids.length });
      } catch (e) { return json(200, { ok: false, erro: e.message }); }
    });
  }

  // ---------------- renomear o cupom de quem JÁ foi aprovado ----------------
  // O ISABELLE→ISAS de 12/08 teve que ser feito na mão em três lugares, e um deles (o link
  // curto) nem existia ainda. São QUATRO lados, e todos têm que andar juntos:
  //   1. o código de resgate na Shopify   3. `creator.legado` (inventário da loja)
  //   2. `creator.cupom`                  4. o redirect `/r/<cupom>`
  //
  // A ORDEM é do mais reversível para o menos, igual à aprovação: banco primeiro (dá rollback),
  // loja depois. Se a loja falhar, o banco volta atrás e o cupom antigo continua valendo —
  // o contrário deixaria o código vivo na loja e órfão aqui.
  if (u.pathname === '/api/cupom/renomear' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
    return req.on('end', async () => {
      const cli = await pool.connect();
      let etapa = 'lendo o cupom';
      try {
        const d = JSON.parse(b || '{}');
        const cupomId = +d.cupom_id;
        const novo = String(d.novo || '').trim().toUpperCase();
        if (!cupomId) return json(400, { erro: 'cupom ausente' });
        if (!/^[A-Z0-9]{3,24}$/.test(novo))
          return json(400, { erro: 'use de 3 a 24 letras ou números, sem espaço nem acento' });

        const [cup] = (await cli.query(
          `SELECT c.*, p.nome FROM creator.cupom c
             JOIN creator.parceiro p ON p.parceiro_id = c.parceiro_id
            WHERE c.cupom_id = $1`, [cupomId])).rows;
        if (!cup) return json(404, { erro: 'cupom não encontrado' });
        const antigo = cup.codigo;
        if (antigo.toUpperCase() === novo) return json(400, { erro: 'o código já é esse' });

        // mesma checagem da aprovação: único na LOJA inteira, não só no programa
        etapa = 'conferindo se o código já existe';
        const cho = await cli.query(`
          SELECT 'programa' AS onde FROM creator.cupom  WHERE upper(codigo)=$1 AND cupom_id<>$2
          UNION ALL SELECT 'loja'   FROM creator.legado WHERE upper(codigo)=$1`, [novo, cupomId]);
        if (cho.rows[0])
          return json(409, { erro: 'o código ' + novo + ' já existe ('
            + (cho.rows[0].onde === 'loja' ? 'na Shopify' : 'no programa') + '). Escolha outro.' });

        await cli.query('BEGIN');
        etapa = 'gravando aqui';
        await cli.query('UPDATE creator.cupom SET codigo=$2 WHERE cupom_id=$1', [cupomId, novo]);
        await cli.query('UPDATE creator.legado SET codigo=$2 WHERE upper(codigo)=$1', [antigo.toUpperCase(), novo]);

        etapa = 'renomeando na Shopify';
        if (cup.shopify_discount_id)
          await renomearCupomShopify({ discountId: cup.shopify_discount_id, novo });

        // o link curto é o único que pode falhar sem derrubar o resto: se ele não mover, o
        // cupom novo já vale no checkout e o link velho ainda redireciona. Fica registrado.
        let linkNovo = null, avisoLink = null;
        if (cup.link_redirect_id) {
          etapa = 'movendo o link curto';
          try {
            linkNovo = await renomearLinkCurtoShopify({ redirectId: cup.link_redirect_id, novo });
            // grava o caminho SÓ depois que a loja confirmou. Se a chamada falhar, link_path
            // continua o antigo e a creator segue com um link que FUNCIONA até alguém consertar.
            await cli.query('UPDATE creator.cupom SET link_path=$2 WHERE cupom_id=$1',
                            [cupomId, linkNovo]);
          } catch (e) { avisoLink = e.message; }
        }
        await cli.query('COMMIT');
        invalida();
        return json(200, { ok: true, antigo, novo, nome: cup.nome,
          link: linkNovo ? SITE + linkNovo : null, aviso_link: avisoLink });
      } catch (e) {
        await cli.query('ROLLBACK').catch(() => {});
        return json(200, { ok: false, erro: e.message, etapa });
      } finally { cli.release(); }
    });
  }

  // ---------------- pastas: criar, renomear, apagar ----------------
  if (u.pathname === '/api/pasta' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.apagar) {
          // apagar a pasta SOLTA as pessoas (ON DELETE CASCADE em parceiro_pasta), não apaga
          // ninguém — vale dizer quantas saíram, senão parece que sumiu gente.
          const [n] = (await pool.query(
            'SELECT count(*)::int AS n FROM creator.parceiro_pasta WHERE pasta_id=$1', [+d.apagar])).rows;
          await pool.query('DELETE FROM creator.pasta WHERE pasta_id=$1', [+d.apagar]);
          invalida(); return json(200, { ok: true, soltos: n.n });
        }
        const nome = String(d.nome || '').trim().slice(0, 60);
        if (!nome) return json(400, { erro: 'a pasta precisa de um nome' });
        if (d.pasta_id) {
          const r = await pool.query(
            'UPDATE creator.pasta SET nome=$2, cor=$3 WHERE pasta_id=$1 RETURNING *',
            [+d.pasta_id, nome, d.cor || null]);
          invalida(); return json(200, { ok: true, pasta: r.rows[0] });
        }
        const r = await pool.query(
          `INSERT INTO creator.pasta (nome, cor, criado_por) VALUES ($1,$2,$3) RETURNING *`,
          [nome, d.cor || null, (d.por || 'painel').slice(0, 60)]);
        invalida(); return json(200, { ok: true, pasta: r.rows[0] });
      } catch (e) {
        // o índice único é por lower(nome): "Nutri" e "nutri" são a mesma pasta de propósito
        if (/pasta_nome_uk/.test(e.message))
          return json(409, { ok: false, erro: 'já existe uma pasta com esse nome' });
        return json(200, { ok: false, erro: e.message });
      }
    });
  }

  // ---------------- pôr / tirar creator de pasta (aceita lote) ----------------
  if (u.pathname === '/api/parceiro/pasta' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; if (b.length > 200000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const d = JSON.parse(b || '{}');
        const pasta = +d.pasta_id;
        const ids = [...new Set((d.parceiros || [d.parceiro_id]).map(Number).filter(Boolean))];
        if (!pasta || !ids.length) return json(400, { erro: 'pasta e creator são obrigatórios' });
        if (d.sair) {
          const r = await pool.query(
            'DELETE FROM creator.parceiro_pasta WHERE pasta_id=$1 AND parceiro_id = ANY($2)',
            [pasta, ids]);
          invalida(); return json(200, { ok: true, saíram: r.rowCount });
        }
        const r = await pool.query(
          `INSERT INTO creator.parceiro_pasta (pasta_id, parceiro_id)
           SELECT $1, x FROM unnest($2::bigint[]) AS x
           ON CONFLICT DO NOTHING RETURNING parceiro_id`, [pasta, ids]);
        invalida(); return json(200, { ok: true, entraram: r.rowCount, pedidos: ids.length });
      } catch (e) { return json(200, { ok: false, erro: e.message }); }
    });
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
        // O e-mail e condicao para aprovar, nao enfeite: sem ele nao ha cupom entregue, nao
        // ha link entregue e nao ha porta de entrada no portal. A tela ja barra, mas validar
        // so na tela e nao validar — qualquer chamada direta na API passaria por cima.
        const emailNovo = String(d.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNovo))
          return json(400, { erro: 'informe um e-mail válido: sem ele a pessoa não recebe o cupom nem entra no portal' });
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

        // ---- comissão do NÍVEL (item 9) ----
        // A comissão vem da faixa; `cupom.comissao_pct` é exceção. Antes, aprovar sem digitar
        // nada gravava NULL e o e-mail prometia uma comissão em branco — é a origem dos 32
        // cupons sem percentual. Agora o nulo tem significado: "usa a régua".
        etapa = 'lendo a comissão do nível';
        const niv = (await cli.query(`
          SELECT coalesce(v.nivel, 'bronze') AS nivel,
                 v.comissao_unica_pct, v.comissao_assinatura_pct
            FROM creator.vw_nivel v WHERE v.parceiro_id=$1`, [id])).rows[0] || {};
        const regra = niv.comissao_unica_pct != null ? niv : (await cli.query(`
          SELECT 'bronze' AS nivel,
                 max(comissao_pct) FILTER (WHERE tipo_pedido='unica')      AS comissao_unica_pct,
                 max(comissao_pct) FILTER (WHERE tipo_pedido='assinatura') AS comissao_assinatura_pct
            FROM creator.nivel_regra WHERE nivel='bronze'`)).rows[0];
        // o que o e-mail promete: o que foi digitado, ou a régua do nível
        const comissaoEfetiva  = comissao ?? Number(regra.comissao_unica_pct);
        const comissaoAssinat  = comissao ?? Number(regra.comissao_assinatura_pct);

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
        let redirectId = null, redirectPath = null;
        try { const rd = await criarLinkCurtoShopify({ codigo, slug });
              redirectId = rd.id; redirectPath = rd.path; }
        catch (e) { console.error('link curto falhou para ' + codigo + ':', e.message); }
        const link = redirectPath ? SITE + redirectPath : linkCreator(slug);

        etapa = 'gravando o cupom';
        const cup = (await cli.query(`
          INSERT INTO creator.cupom (parceiro_id, codigo, desconto_pct, comissao_pct,
                                     combinavel, shopify_discount_id, shopify_erro,
                                     link_redirect_id, link_path, ativo)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
          [id, codigo, desconto, comissao, !!d.combinavel, shopifyId, shopifyErro,
           redirectId, redirectPath])).rows[0];

        etapa = 'atualizando o cadastro';
        const novo = (await cli.query(`
          UPDATE creator.parceiro SET status='ativo', utm_slug=$2, aprovado_em=now(),
                 aprovado_por=$3, decidido_por=$3, arquivado=false,
                 -- ⚠️ O e-mail digitado no dialogo NUNCA era gravado: viajava para o Klaviyo e
                 -- se perdia. A pessoa aparecia "sem e-mail" para sempre no painel, mesmo
                 -- depois de alguem ter digitado — e sem e-mail na ficha ela nao consegue
                 -- entrar pelo codigo. Agora fica.
                 email=$4,
                 reprovado_em=NULL, reprovado_motivo=NULL, atualizado_em=now()
           WHERE parceiro_id=$1 RETURNING *`,
          [id, slug, (d.por || 'painel').slice(0, 60), emailNovo])).rows[0];

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
        const email = emailNovo;
        let envio = { estado: 'nao_enviado', detalhe: null };
        if (d.enviar_email !== false) {
          try {
            const props = await eventoAprovacao({ email, nome: novo.nome, cupom: codigo, link,
                                                  desconto,
                                                  comissao: comissaoEfetiva,
                                                  comissao_assinatura: comissaoAssinat,
                                                  nivel: regra.nivel, sexo: pa.sexo });
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
               c.codigo, c.desconto_pct, c.shopify_erro, c.link_redirect_id,
               l.sexo,
               -- mesma regra da aprovação: o cupom só manda no percentual quando ele existe;
               -- nulo significa "usa a régua do nível", não "sem comissão"
               coalesce(c.comissao_pct, nv.comissao_unica_pct)      AS comissao_pct,
               coalesce(c.comissao_pct, nv.comissao_assinatura_pct) AS comissao_assinatura_pct,
               nv.nivel
        FROM creator.parceiro p
        LEFT JOIN creator.cupom c ON c.parceiro_id=p.parceiro_id AND c.ativo
        LEFT JOIN creator.leads l ON l.lead_id = p.lead_id
        LEFT JOIN creator.vw_nivel nv ON nv.parceiro_id = p.parceiro_id
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
      const link = linkDoCreator(p);
      const props = await eventoAprovacao({ email: p.email, nome: p.nome, cupom: p.codigo, link,
                                            desconto: p.desconto_pct, comissao: p.comissao_pct,
                                            comissao_assinatura: p.comissao_assinatura_pct,
                                            nivel: p.nivel, sexo: p.sexo });
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
               cu.codigo AS cupom, cu.link_redirect_id, cu.link_path,
               (SELECT max(el.criado_em) FROM creator.email_log el
                 WHERE el.parceiro_id=p.parceiro_id AND el.campanha_id=$1
                   AND el.estado='evento_enviado')::date AS avisado_em
        FROM creator.campanha_parceiro cp
        JOIN creator.parceiro p ON p.parceiro_id = cp.parceiro_id
        LEFT JOIN creator.cupom cu ON cu.parceiro_id = p.parceiro_id AND cu.ativo
        WHERE cp.campanha_id = $1 AND cp.saiu_em IS NULL
        ORDER BY p.nome`, [c]);
      const cam = (await pool.query(
        `SELECT nome, briefing, inicio, fim FROM creator.campanha WHERE campanha_id=$1`,
        [c])).rows[0];
      if (!cam) return json(404, { erro: 'campanha não encontrada' });
      return json(200, { ok: true, campanha: normaliza(cam),
        pessoas: r.rows.map(x => normaliza({ ...x, link: linkDoCreator(x) })) });
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
          `SELECT campanha_id, nome, briefing, inicio, fim
             FROM creator.campanha WHERE campanha_id=$1`, [c])).rows[0];
        if (!cam) return json(404, { erro: 'campanha não encontrada' });

        const pessoas = (await pool.query(`
          SELECT p.parceiro_id, p.nome, p.email, p.utm_slug,
                 cu.codigo AS cupom, cu.link_redirect_id, cu.link_path
          FROM creator.parceiro p
          LEFT JOIN creator.cupom cu ON cu.parceiro_id=p.parceiro_id AND cu.ativo
          WHERE p.parceiro_id = ANY($1)`, [ids])).rows;

        // link do briefing, não o arquivo. Só os metadados vão para o Klaviyo.
        const anexos = (await pool.query(
          `SELECT anexo_id, nome, mime, bytes FROM creator.campanha_anexo
            WHERE campanha_id=$1 ORDER BY criado_em`, [c])).rows
          .map(a => ({ nome: a.nome, tamanho_kb: Math.max(1, Math.round(a.bytes / 1024)),
                       url: PORTAL_URL + '/creator/anexo?id=' + a.anexo_id }));

        const res = [];
        for (const p of pessoas) {
          const link = linkDoCreator(p);
          try {
            const props = await eventoCampanha({ email: p.email, nome: p.nome, campanha: cam.nome,
              briefing: cam.briefing, cupom: p.cupom, link, anexos,
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
            -- NAO carimbar aprovado_em aqui. Mudar o status para 'ativo' NAO e aprovar:
            -- aprovar cria cupom, link e e-mail, e so /api/aprovar faz isso. Ate 24/08 este
            -- CASE gravava a data mesmo assim, e o estrago era duplo: dava a entender que a
            -- pessoa passou pelo fluxo completo, e desligava o alarme reaprovar (que testa
            -- aprovado_em IS NULL) exatamente nas 20 que ficaram sem cupom em 21/08.
            aprovado_em = aprovado_em,
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
                  apify: () => J.syncApify(pool, APIFY),
                  vendas: () => J.syncVendas(pool) };
    if (!fns[nome]) return json(400, { erro: 'job desconhecido: use cadastros, tags, perfis, apify ou vendas' });
    try {
      const r = await fns[nome]();
      invalida();   // o job mexeu no banco — a próxima leitura tem que ser fresca
      await J.logJob(pool, nome, true, JSON.stringify(r), r.novas ?? r.atualizados ?? r.coletados ?? r.novos ?? 0);
      return json(200, { ok: true, job: nome, resultado: r });
    }
    catch (e) { await J.logJob(pool, nome, false, e.message, 0); return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- anexos de campanha (item 4) ----------------
  // Sobe em base64 dentro de JSON, e não multipart: são 10 MB no máximo, o parser nativo do
  // Node não faz multipart e trazer uma dependência para isso é caro para o que resolve.
  if (u.pathname === '/api/campanha/anexo' && req.method === 'POST') {
    const id = +u.searchParams.get('id');
    if (!id) return json(400, { erro: 'campanha ausente' });
    // 10 MB viram ~13,4 MB em base64; o teto do corpo tem que caber isso mais o resto
    let d; try { d = await corpoJSON(req, 15 * 1024 * 1024); }
    catch (e) { return json(400, { erro: e.message === 'corpo grande' ? 'arquivo maior que 10 MB' : e.message }); }

    const OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!OK.includes(d.mime)) return json(400, {
      erro: 'só PDF, JPEG, PNG ou WEBP. Vídeo fica fora — usa storage externo e ninguém pediu.' });
    let buf;
    try { buf = Buffer.from(String(d.base64 || ''), 'base64'); }
    catch (e) { return json(400, { erro: 'arquivo ilegível' }); }
    if (!buf.length) return json(400, { erro: 'arquivo vazio' });
    if (buf.length > 10 * 1024 * 1024) return json(400, { erro: 'arquivo maior que 10 MB' });

    // ⚠️ Confere a ASSINATURA do arquivo, não só o mime que o navegador declarou. Sem isso,
    // qualquer coisa renomeada para .pdf entra no banco e depois é servida com
    // Content-Type: application/pdf para a creator.
    const assina = {
      'application/pdf': b => b.slice(0, 5).toString('latin1') === '%PDF-',
      'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8,
      'image/png':  b => b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])),
      'image/webp': b => b.slice(0, 4).toString('latin1') === 'RIFF'
                      && b.slice(8, 12).toString('latin1') === 'WEBP',
    };
    if (!assina[d.mime](buf)) return json(400, {
      erro: 'o conteúdo do arquivo não bate com o tipo declarado' });

    const nome = String(d.nome || 'arquivo').replace(/[^\w .()-]/g, '_').slice(0, 120);
    try {
      const r = await pool.query(`
        INSERT INTO creator.campanha_anexo (campanha_id, nome, mime, bytes, conteudo, criado_por)
        VALUES ($1,$2,$3,$4,$5,'painel') RETURNING anexo_id, nome, mime, bytes, criado_em`,
        [id, nome, d.mime, buf.length, buf]);
      return json(200, { ok: true, anexo: r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  if (u.pathname === '/api/campanha/anexo' && req.method === 'DELETE') {
    const anexo = +u.searchParams.get('anexo');
    if (!anexo) return json(400, { erro: 'anexo ausente' });
    try {
      const r = await pool.query(
        'DELETE FROM creator.campanha_anexo WHERE anexo_id=$1 RETURNING nome', [anexo]);
      if (!r.rows[0]) return json(404, { erro: 'anexo não existe' });
      return json(200, { ok: true, apagado: r.rows[0].nome });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // ---------------- apuração: quanto pagar, e o registro de que foi pago ----------------
  // `creator.vw_apuracao` existia desde sempre e NINGUÉM lia — nem view nem arquivo do app.
  // Era o motor de comissão sem painel: o número existia e não chegava a lugar nenhum.
  if (u.pathname === '/api/apuracao') {
    const mes = /^\d{4}-\d{2}$/.test(u.searchParams.get('mes') || '') ? u.searchParams.get('mes') : null;
    try {
      const linhas = await pool.query(`
        SELECT a.*, p.pix_tipo, p.pix_chave, p.email,
               coalesce(p.cpf, p.cnpj) AS documento
          FROM creator.vw_apuracao a
          JOIN creator.parceiro p ON p.parceiro_id = a.parceiro_id
         WHERE ($1::text IS NULL OR to_char(a.competencia,'YYYY-MM') = $1)
         ORDER BY a.competencia DESC, a.comissao_devida DESC NULLS LAST`, [mes]);
      const meses = await pool.query(`
        SELECT to_char(competencia,'YYYY-MM') AS mes, count(*)::int AS creators,
               sum(comissao_devida)::numeric(12,2) AS comissao,
               bool_and(fechado) AS fechado
          FROM creator.vw_apuracao GROUP BY 1 ORDER BY 1 DESC`);
      // ⚠️ A tela calcula competência desde janeiro/2025, mas o programa só passa a PAGAR
      // comissão a partir da vigência. Sem mandar isso para a tela, o botão "fechar o mês"
      // criaria dívida que nunca existiu — num número que a creator vê no próprio portal.
      const vig = await pool.query(
        `SELECT valor FROM creator.config WHERE chave='comissao_vigencia'`);
      return json(200, { ok: true, linhas: linhas.rows, meses: meses.rows,
                         vigencia: (vig.rows[0]?.valor || '').slice(0, 7) });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // FECHAR o mês: congela o valor. Depois disso a comissão para de se mexer — se a pessoa
  // subir de nível em outubro, julho continua valendo o que valia em julho.
  if (u.pathname === '/api/apuracao/fechar' && req.method === 'POST') {
    const mes = u.searchParams.get('mes') || '';
    if (!/^\d{4}-\d{2}$/.test(mes)) return json(400, { erro: 'mês no formato AAAA-MM' });
    // ⚠️ Não deixa fechar mês que ainda está correndo: pedido do dia 28 pode ser cancelado, e
    // congelar antes disso é congelar um número que ainda vai mudar.
    const [{ corrente }] = (await pool.query(
      `SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS corrente`)).rows;
    if (mes >= corrente) return json(400, {
      erro: `${mes} ainda não terminou. Feche só mês encerrado — pedido de agora ainda pode ser cancelado.` });
    // ⚠️ Antes da vigência o programa NÃO pagava comissão — só dava cupom de desconto. Fechar
    // uma dessas competências inventaria dívida. A trava mora no servidor, não só na tela:
    // a tela é a que dá para contornar.
    const vg = (await pool.query(
      `SELECT valor FROM creator.config WHERE chave='comissao_vigencia'`)).rows[0]?.valor;
    if (vg && mes < String(vg).slice(0, 7)) return json(400, {
      erro: `A Cells só paga comissão a partir de ${String(vg).slice(0,7)}. Antes disso o `
          + `programa só dava cupom de desconto — fechar ${mes} criaria dívida que não existe.` });
    try {
      const r = await pool.query(`
        INSERT INTO creator.comissao_mes
          (parceiro_id, competencia, nivel, pct_unica, pct_assinatura,
           pedidos, receita, comissao)
        SELECT a.parceiro_id, a.competencia, coalesce(a.nivel,'bronze'),
               coalesce(a.pct_unica,0), coalesce(a.pct_assinatura,0),
               a.pedidos, a.receita, a.comissao_devida
          FROM creator.vw_apuracao a
         WHERE to_char(a.competencia,'YYYY-MM') = $1 AND a.comissao_devida > 0
        ON CONFLICT (parceiro_id, competencia) DO NOTHING
        RETURNING parceiro_id`, [mes]);
      return json(200, { ok: true, mes, congeladas: r.rowCount });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  // marcar como paga / solicitada. `pago_ref` guarda o comprovante — sem ele, "paguei" é
  // memória de alguém.
  if (u.pathname === '/api/apuracao/status' && req.method === 'POST') {
    const id = +u.searchParams.get('id'), mes = u.searchParams.get('mes') || '';
    const st = u.searchParams.get('status') || '';
    const ref = (u.searchParams.get('ref') || '').slice(0, 120) || null;
    if (!id || !/^\d{4}-\d{2}$/.test(mes)) return json(400, { erro: 'parceiro e mês são obrigatórios' });
    if (!['fechada', 'solicitada', 'paga', 'cancelada'].includes(st))
      return json(400, { erro: 'status inválido' });
    try {
      const r = await pool.query(`
        UPDATE creator.comissao_mes
           SET status=$3, pago_ref = coalesce($4, pago_ref),
               solicitado_em = CASE WHEN $3='solicitada' THEN coalesce(solicitado_em, now()) ELSE solicitado_em END,
               pago_em       = CASE WHEN $3='paga' THEN coalesce(pago_em, now())
                                    WHEN $3='cancelada' THEN NULL ELSE pago_em END
         WHERE parceiro_id=$1 AND competencia = to_date($2,'YYYY-MM')
        RETURNING status, pago_em`, [id, mes, st, ref]);
      if (!r.rows[0]) return json(404, { erro: 'esse mês ainda não foi fechado para essa pessoa' });
      return json(200, { ok: true, ...r.rows[0] });
    } catch (e) { return json(200, { ok: false, erro: e.message }); }
  }

  if (u.pathname === '/api/jobs') {
    const r = await pool.query(
      `SELECT job, sucesso, itens, detalhe, rodou_em FROM creator.job_log ORDER BY rodou_em DESC LIMIT 40`);
    return json(200, r.rows);
  }

  if (u.pathname === '/api/dados') {
    try { return json(200, { ...await dados(), desconto_padrao: DESCONTO_PADRAO }); }
    catch (e) { return json(503, { erro: e.message }); }
  }

  if (u.pathname !== '/') { res.writeHead(404, {'content-type':'text/plain'}); return res.end('404'); }

  try {
    const d = await dados();
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'x-cc-cache': Math.round((Date.now() - cache.at) / 1000) + 's'});
    res.end(TPL.replace('__DATA__', JSON.stringify({ ...d, desconto_padrao: DESCONTO_PADRAO })
      .replace(/</g, '\\u003c')));
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
