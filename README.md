# comunidade-cells

Painel interno de gestão de creators da Cells. No ar em `comunidade-cells.sinteseia.com.br`.

## O que faz

- **Busca ao vivo** (`/api/buscar?h=handle`) — chama `business_discovery` da Graph API da Meta no
  servidor e devolve seguidores, engajamento, curtidas médias e cadência de qualquer conta
  Business/Creator pública. O token **nunca** chega ao browser. Toda busca grava snapshot em
  `creator.perfil_snapshot`.
- **Base coletada** — lê o schema `creator` do Postgres pela rede interna do Easypanel.

## Env vars

| var | o quê |
|---|---|
| `DATABASE_URL` | Postgres. Dentro do Easypanel usar o host interno, não o domínio externo |
| `META_TOKEN` | system user token do app "Api Oficial - Cells". Precisa de `instagram_basic` |
| `IG_USER_ID` | default `17841405730329135` (@cellsoficial) |
| `SENHA` | senha do painel |
| `CACHE_MIN` | TTL do cache em minutos (default 5) |

## Definições que não são óbvias

**Engajamento** = média de (curtidas + comentários) por post sobre os **últimos 12 posts**,
dividida por seguidores. Não é janela de 30 dias — quem não posta há meses continua tendo
número. A atividade real está em `posts_30d` / `ultimo_post`.

**`posts_30d` pode ser piso, não contagem.** A amostra é de 12 posts; se os 12 caem na janela,
o valor real é ≥ 12. O campo `piso_30d` sinaliza isso.

**Alcance não existe no painel.** A Meta não entrega insight de post de terceiro — testado e
esgotado em 05/08/2026. Só com tag de Parceria Paga. Views de reels dependem do job do Apify.

## Limite da Graph API

`business_discovery` só enxerga conta **Business ou Creator pública**. Perfil pessoal e privado
voltam vazio — e isso não é bug, é a Meta. Dos 91 perfis que marcam a Cells, 5 caíram nesse caso.

## Schema

`4. canais/influencer/lp-creators/sql/2026-08-05-schema-gestao-creators.sql` no workspace
cells-skills-novo. Spec em `programa-creators/2026-08-05-plataforma-gestao-SPEC.md`.
