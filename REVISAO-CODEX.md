# Prompt para revisão pelo Codex

Copiar daqui pra baixo.

---

Você vai revisar a plataforma da **Comunidade Cells**, um app em produção que roda o programa de creators da Cells (marca de magnésio). Quero uma revisão crítica de verdade: correção, segurança e risco operacional. Não quero elogio nem reescrita — quero os problemas que vão me machucar.

## O que é

Duas telas num processo Node só, sem framework:

- **`/admin`** — painel interno (Gabriel, dono, e a Rafa, que cobra as creators). Seis abas: busca, criadores, dashboard, campanhas, extrações, gestão. Protegido por senha única em cookie.
- **`/creator`** — portal onde cada creator entra com e-mail ou @ e senha, vê cupom, link, comissão, nível, metas, envios e dados pessoais.
- **Jobs** rodam no mesmo processo (coleta de publicações do Instagram, vendas, cadastros).
- **`/webhook/meta`** recebe menções de story do Instagram.

Pilha: Node >= 20, dependência única `pg`, Postgres gerenciado, deploy por Dockerfile no Easypanel a partir do GitHub. HTML é template string com `__DATA__` substituído no servidor — não há build, não há framework, não há teste automatizado.

## Onde está

```
~/Documents/MAGNUS/cells/apps/comunidade-cells/
  server.js      2.916 linhas   rotas, auth, jobs, integrações (Meta, Shopify, Klaviyo)
  queries.js       607 linhas   todo o SQL do painel e das análises
  jobs.js        1.101 linhas   coletas agendadas
  template.html  2.863 linhas   o painel inteiro: markup + CSS + JS num arquivo
  portal.html      757 linhas   o portal da creator
  entrar.html      187 linhas   tela de login
```

## Como conectar no banco (SOMENTE LEITURA)

```
~/Documents/cells-crm-app/.env.local   →  DATABASE_URL   (leitura)
```

Schema principal: `creator`. Também lê de `commerce`, `core` e `crm`.

**Antes de qualquer consulta, mande `SET jit = off`.** O banco vem com JIT ligado e isso faz query de 4,8s virar 46s — já medido. Não é opinião, é a diferença entre a query voltar e você achar que travou.

Não há `psql` na máquina. Use `python3` com `psycopg2`.

## Regras duras

1. **Não escreva no banco.** Existe uma credencial de escrita na máquina; não use. Se quiser provar um bug que depende de escrita, descreva o teste, não execute.
2. **Não faça deploy e não commite.** Só leitura e análise.
3. **O repositório é PÚBLICO** (github.com/sintese-ia/comunidade-cells). Não acrescente segredo nenhum a arquivo, nem em exemplo.
4. **Não reescreva o app.** Se a sua recomendação for "migra pra framework X", ela não serve. O dono abandona o que fica complicado — proposta que não cabe em um arquivo e um comando é proposta descartada.
5. **Não toque em `ops/`** (estado operacional, com dado pessoal).

## O que eu quero que você olhe, em ordem

### 1. Segurança
É o que mais me preocupa, porque o painel tem dado pessoal de 240 pessoas (CPF, PIX, endereço, telefone) e o portal é público na internet.

- Autenticação do admin: senha única em `process.env.SENHA`, com **fallback para a string `'cells'`** se a variável não existir. Cookie é derivado dela. Quão ruim é isso na prática, e qual o conserto mínimo?
- Sessão da creator: cookie assinado, 90 dias. Procure caminho em que alguém veja dado de outra creator — troca de id, parâmetro não validado, endpoint que confia no corpo da requisição.
- Toda rota `/api/*` que escreve: confira uma a uma se exige autenticação. Quero saber se alguma escreve sem checar.
- SQL: tudo deveria ser parametrizado. Procure concatenação.
- `/webhook/meta`: a assinatura HMAC é verificada mesmo? Dá pra injetar publicação falsa?
- Rate limiting e enumeração de conta no login e no código por e-mail.
- Vazamento de PII em log, em resposta de erro ou no HTML servido.

### 2. Correção do que vira dinheiro
Erro aqui paga comissão errada ou manda kit pra pessoa errada.

- `queries.js`: a lógica de atribuição de venda, apuração e nível. Procure dupla contagem, pedido cancelado entrando, cupom de programa errado somando junto.
- Fuso: o negócio é `America/Sao_Paulo` e o banco guarda `timestamptz`. Procure comparação de data que troca o mês na virada.
- `node-pg` devolve `bigint` como **string**: `'0'` é truthy em JS. Procure contador sem `::int` no SQL que vira bug silencioso na tela.
- Views em `creator` que o app consome: `vw_venda`, `vw_venda_valida`, `vw_apuracao`, `vw_nivel`, `vw_comissao_a_pagar`, `vw_campanha_resultado`. Há um bug conhecido (abaixo) — procure os irmãos dele.

### 3. Robustez operacional
- Jobs rodam no mesmo processo do servidor. O que acontece com uma requisição enquanto um job pesado roda?
- Tratamento de falha nas integrações (Meta, Shopify, Klaviyo, Apify): o que acontece quando a API de fora devolve 429 ou 500? Falha silenciosa é o pior caso e já aconteceu aqui.
- Idempotência das rotas que criam coisa no mundo (cupom na Shopify, e-mail, envio).
- O cache do painel: TTL de 5 min, `stale-while-revalidate`, invalidação manual em escrita. Procure caminho em que a tela mostre dado velho sem avisar.

### 4. Frontend
- `template.html` tem 2.863 linhas de markup, CSS e JS juntos. Não quero que você quebre em módulos — quero saber onde isso já está causando bug de verdade: seletor de CSS que cancela outro, listener duplicado, estado que não repinta.
- Acessibilidade básica e comportamento no celular, principalmente no portal da creator, que é aberto do telefone.

## Problemas que eu JÁ conheço — não precisa reportar, mas me corrija se discordar

1. **`creator.vw_venda` é lenta** (8,7s sozinha): o join com `creator.cupom` usa `OR` mais `jsonb_array_elements_text` por pedido. `vw_campanha_resultado` chama ela uma vez por campanha, então as consultas `campanhas` e `geral` estouram o tempo e a aba Campanhas aparece vazia. Já escalado, esperando dono. **Se você tiver uma reescrita segura (UNION no lugar do OR), isso me interessa muito** — mas note que `vw_venda_valida` depende dela e é a base do placar de atribuição.
2. **JIT do Postgres** fazia toda query pesada custar ~10x. Resolvido com `pool.on('connect')` mandando `SET jit = off`.
3. **Query lenta congelava o painel inteiro** por 24h: sem `statement_timeout`, a promessa de recarga ficava pendurada. Resolvido com teto de 25s e degradação por bloco.
4. **`ops/` está no `.gitignore` mas já foi commitada antes disso**, num repo público — tem telefone de 26 creators, hash de senha e textos de disparo no histórico do Git. Em aberto: limpar histórico exige force-push e é decisão do dono.
5. `vw_nivel.receita_mes` usa o mês corrente em vez da competência apurada, então quem vendeu no mês fechado aparece sem nível.

## O que eu quero de volta

Uma lista de achados, **ordenada por risco real**, não por categoria. Para cada um:

- **o que está errado**, em uma frase
- **como reproduzir ou onde ver** — arquivo e linha, ou a query que mostra
- **o estrago concreto** — quem é prejudicado e como. "Má prática" sem consequência não me serve
- **o conserto mínimo** que cabe neste app, do tamanho de um diff

No fim, separe o que é **urgente** (dado pessoal, dinheiro errado, dado que some) do que é **dívida** (incomoda, não sangra).

Se achar que eu estou errado em alguma das premissas acima, diga.
