import pathlib, re, sys
alvo = sys.argv[1] if len(sys.argv)>1 else 'template.html'
s = pathlib.Path(alvo).read_text()
script = re.findall(r'<script[^>]*>(.*?)</script>', s, re.S)
js = '\n'.join(script)
html = re.sub(r'<script[^>]*>.*?</script>', '', s, flags=re.S)
# ids que o HTML declara + os que o proprio JS cria dinamicamente
declarados = set(re.findall(r'id="([^"]+)"', html))
dinamicos  = set(re.findall(r"id=[\"']?\s*\+?\s*['\"]?([a-zA-Z][\w-]*)['\"]?\+", js))
dinamicos |= set(re.findall(r"'id=\"([a-zA-Z][\w-]*)", js))
usados = set(re.findall(r"getElementById\('([^']+)'\)", js))
orfas = sorted(u for u in usados
               if u not in declarados
               and not any(u.startswith(p) for p in ('c-','k-','sv-'))
               and not any(u.startswith(d) for d in dinamicos))
print(f"{alvo}: {len(usados)} ids usados no JS · {len(declarados)} declarados no HTML")
if orfas:
    print("  ⚠️ getElementById que devolve NULL (mata o script):")
    for o in orfas: print("     ·", o)
    sys.exit(1)
print("  ✓ nenhum getElementById órfão")
