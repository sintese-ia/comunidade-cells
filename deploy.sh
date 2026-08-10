#!/usr/bin/env bash
# Finaliza o deploy do comunidade-cells no Easypanel.
#
# Serviço, env vars, domínio (com Let's Encrypt) e DNS JÁ ESTÃO CRIADOS.
# Falta só apontar a origem do código e mandar buildar — os 3 passos abaixo.
#
# Por que isto virou script: em 05/08 o FortiGate da rede começou a devolver 403 (Web Filter)
# para *.sinteseia.com.br no meio do deploy. Postgres:5432 e GitHub passam; HTTPS para o
# Easypanel, não. Rode de uma rede sem esse filtro (4G do celular resolve) ou espere liberar.
#
#   bash deploy.sh
#
set -euo pipefail

: "${EASYPANEL_API_TOKEN:?defina EASYPANEL_API_TOKEN (está no ~/.zshrc)}"
BASE="https://easypanel.sinteseia.com.br/api/trpc"
PROJ="sintese"
SVC="comunidade-cells"

ep() {
  curl -sS -X POST "$BASE/$1" \
    -H "Authorization: Bearer $EASYPANEL_API_TOKEN" \
    -H 'Content-Type: application/json' -d "$2"
  echo
}

echo "==> checando se o painel responde"
code=$(curl -k -s -o /dev/null -w '%{http_code}' -m 15 https://easypanel.sinteseia.com.br || true)
if [ "$code" != "200" ]; then
  echo "Easypanel devolveu HTTP $code."
  [ "$code" = "403" ] && echo "403 = FortiGate/Web Filter da rede, não é o servidor. Troque de rede."
  exit 1
fi

echo "==> 1/3 origem do código"
ep "services.app.updateSourceGit" \
  "{\"json\":{\"projectName\":\"$PROJ\",\"serviceName\":\"$SVC\",\"repo\":\"https://github.com/sintese-ia/comunidade-cells.git\",\"ref\":\"main\",\"path\":\"/\"}}"

echo "==> 2/3 build por Dockerfile"
ep "services.app.updateBuild" \
  "{\"json\":{\"projectName\":\"$PROJ\",\"serviceName\":\"$SVC\",\"build\":{\"type\":\"dockerfile\",\"file\":\"Dockerfile\"}}}"

echo "==> 3/3 deploy"
ep "services.app.deployService" "{\"json\":{\"projectName\":\"$PROJ\",\"serviceName\":\"$SVC\"}}"

echo
echo "==> aguardando subir (build leva ~1-2 min)"

# ⚠️ Este laço já checou "HTTP 401 = no ar". Era MENTIRA: o container VELHO também devolve 401,
# então o script dava sucesso servindo o código antigo — aconteceu em 10/08 e só apareceu porque
# alguém foi conferir um número na tela. Agora ele compara o COMMIT que o Easypanel diz estar
# rodando com o HEAD local. Ou bate, ou o script falha.
ESPERADO=$(git rev-parse HEAD)
INPUT=$(printf '{"json":{"projectName":"%s","serviceName":"%s"}}' "$PROJ" "$SVC" \
        | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))')

for i in $(seq 1 40); do
  sleep 15
  vivo=$(curl -k -s -o /dev/null -w '%{http_code}' -m 10 https://comunidade-cells.sinteseia.com.br || true)
  rodando=$(curl -s -m 15 "$BASE/services.app.inspectService?input=$INPUT" \
              -H "Authorization: Bearer $EASYPANEL_API_TOKEN" 2>/dev/null \
            | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["result"]["data"]["json"]["commit"]["hash"])
except Exception: print("")' 2>/dev/null)

  if [ "$rodando" = "$ESPERADO" ] && [ "$vivo" = "401" ]; then
    echo "no ar em ${ESPERADO:0:7} → https://comunidade-cells.sinteseia.com.br"
    exit 0
  fi
  printf '  %02d) HTTP %s | rodando %s | esperado %s\n' "$i" "$vivo" "${rodando:0:7}" "${ESPERADO:0:7}"
done
echo "não subiu no tempo esperado — veja os logs do serviço no painel."
exit 1
