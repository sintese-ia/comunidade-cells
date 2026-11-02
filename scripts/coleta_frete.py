#!/usr/bin/env python3
"""Grava o frete real de cada kit em creator.envio_frete.

Roda no fim do despacho, DEPOIS que a etiqueta foi comprada e o envio existe
(envio_id e PK com FK pra creator.envio — gravar antes derruba na FK).

O valor e o `fretePrevisto` do objeto logistico do Bling: o que a transportadora
COTOU na compra da etiqueta. Nao e preco de tabela, mas tambem nao e a fatura —
recobranca por cubagem/repesagem aparece depois, so na fatura do Melhor Envio.
Por isso a coluna do outro lado chama `frete_cotado`, e a conciliacao com a
fatura, quando existir, faz UPDATE do frete E da fonte pra 'melhorenvio:fatura'
(ordem de confianca: fatura > cotado > estimativa).

Idempotente: so olha envio que ainda nao tem frete. `--todos` reprocessa tudo,
`--teste` executa e da ROLLBACK (nao grava nada).

    python3 coleta_frete.py            # so os que faltam
    python3 coleta_frete.py --todos    # reprocessa todos
    python3 coleta_frete.py --teste    # ensaia num envio e desfaz
"""
import json, re, sys, time, urllib.request
import psycopg2

FONTE = 'bling:fretePrevisto@despacho'
RO  = '/Users/gabrielrodrigues/Documents/cells-crm-app/.env.local'
ADM = '/Users/gabrielrodrigues/Documents/cells-crm-app/.env.admin.local'

def env(path):
    o = {}
    for l in open(path):
        m = re.match(r'\s*([A-Z_0-9]+)\s*=\s*"?([^"\n]+)"?', l)
        if m: o[m.group(1)] = m.group(2)
    return o

def api(tok, p, tent=3):
    for i in range(tent):
        r = urllib.request.Request('https://api.bling.com.br/Api/v3' + p,
                                   headers={'Authorization': 'Bearer ' + tok, 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception:
            time.sleep(2.5 * (i + 1))   # a API do Bling falha intermitente; sem retry some envio
    return {}

def main():
    todos = '--todos' in sys.argv
    teste = '--teste' in sys.argv
    cn = psycopg2.connect(env(ADM).get('DATABASE_URL_ADMIN') or env(RO)['DATABASE_URL'])
    c = cn.cursor(); c.execute("SET jit=off")
    c.execute("SELECT access_token FROM crm.bling_tokens WHERE id=1")
    tok = c.fetchone()[0]

    filtro = "" if todos else """
      AND NOT EXISTS (SELECT 1 FROM creator.envio_frete f WHERE f.envio_id = e.envio_id)"""
    c.execute(f"""SELECT e.envio_id, e.bling_pedido_id FROM creator.envio e
                   WHERE e.bling_pedido_id IS NOT NULL {filtro}
                   ORDER BY e.envio_id""")
    alvos = c.fetchall()
    if teste and not alvos:
        c.execute("SELECT envio_id, bling_pedido_id FROM creator.envio WHERE bling_pedido_id IS NOT NULL LIMIT 1")
        alvos = c.fetchall()
    print(f'envios a coletar: {len(alvos)}' + ('  [TESTE: nada sera gravado]' if teste else ''))
    if not alvos: return

    ok = falhou = 0
    for eid, ped in alvos:
        time.sleep(1.1)                         # limite do Bling e 3/s
        d = (api(tok, '/pedidos/vendas/' + str(ped)).get('data') or {})
        vols = ((d.get('transporte') or {}).get('volumes') or [])
        if not vols:
            print(f'  envio {eid}: sem volume no pedido {ped}'); falhou += 1; continue
        time.sleep(1.1)
        o = (api(tok, '/logisticas/objetos/' + str(vols[0]['id'])).get('data') or {})
        frete = o.get('fretePrevisto')
        if frete is None:
            print(f'  envio {eid}: objeto sem fretePrevisto'); falhou += 1; continue
        c.execute("""INSERT INTO creator.envio_frete (envio_id, servico, frete, fonte)
                     VALUES (%s,%s,%s,%s)
                     ON CONFLICT (envio_id) DO UPDATE
                       SET servico=EXCLUDED.servico, frete=EXCLUDED.frete,
                           fonte=EXCLUDED.fonte, coletado_em=now()""",
                  (eid, vols[0].get('servico'), frete, FONTE))
        print(f'  envio {eid}: {vols[0].get("servico")} R$ {frete}')
        ok += 1

    if teste:
        cn.rollback(); print(f'\nTESTE ok — {ok} linha(s) gravariam, desfeito. falhas={falhou}')
    else:
        cn.commit(); print(f'\ngravados={ok} falhas={falhou}')

if __name__ == '__main__':
    main()
