# Disparo Comunidade Cells — retomada 15/09 (12 restantes; sem pausa de leva)
import csv, json, random, time, urllib.request, re, os
S = os.path.dirname(os.path.abspath(__file__))
API = 'https://evolutionapi.sinteseia.com.br/message/sendText/Celular%20Gabriel'
KEY = 'AkIlbPky26wcLcHJ0NV2bw0uICqBvZpC'
SENT, LOG = os.path.join(S,'disparo_sent.log'), os.path.join(S,'disparo_log.txt')
def log(m):
    line = time.strftime('%H:%M:%S') + ' ' + m
    print(line, flush=True); open(LOG,'a').write(line+'\n')
ja = set(l.strip() for l in open(SENT)) if os.path.exists(SENT) else set()
rows = list(csv.DictReader(open(os.path.join(S,'disparo_aprovado.csv'), encoding='utf-8')))
fila = []
for r in rows:
    if (r.get('STATUS (escreva OK para aprovar)') or '').strip().lower() != 'ok': continue
    nome = r['Membro'].strip()
    if nome in ja: continue
    tel = '55' + re.sub(r'\D','', r['Telefone'])
    msgs = [ (r.get(c) or '').strip().replace('🙏acha','🙏 acha') for c in ('Mensagem 1','Mensagem 2','Mensagem 3') ]
    msgs = [m for m in msgs if m]
    if msgs: fila.append((nome, tel, msgs))
log(f'fila: {len(fila)} pessoas')
def envia(tel, texto):
    corpo = json.dumps({'number': tel, 'text': texto, 'delay': random.randint(4000,9000)}).encode()
    req = urllib.request.Request(API, data=corpo, method='POST',
        headers={'apikey': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=30))
for i,(nome,tel,msgs) in enumerate(fila):
    ok = True
    for nm,m in enumerate(msgs,1):
        for tent in (1,2):
            try:
                r = envia(tel,m); log(f'{nome} [{nm}/{len(msgs)}] -> {r.get("status","?")}'); break
            except Exception as e:
                log(f'{nome} [{nm}/{len(msgs)}] ERRO tent{tent}: {e}')
                if tent==2: ok=False
                time.sleep(10)
        if not ok: break
        time.sleep(random.uniform(4,10))
    if ok: open(SENT,'a').write(nome+'\n')
    else: log(f'{nome}: FALHOU, segue a fila')
    if i < len(fila)-1: 
        p = random.uniform(60,180); log(f'... aguardando {int(p)}s'); time.sleep(p)
log('=== DISPARO CONCLUIDO ===')
