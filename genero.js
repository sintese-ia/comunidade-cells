// Como o e-mail decide entre "bem-vindo", "bem-vinda" e "bem-vindo(a)".
//
// REGRA DURA, definida pelo Gabriel em 09/08: **nunca chutar**.
//   - a pessoa DECLAROU o sexo na LP  → usa a declaração;
//   - não declarou                    → "seja bem-vindo(a)".
//
// Existia aqui uma inferência por primeiro nome (terminação -a/-o mais uma lista de nomes).
// Ela acertava 20 de 20 contra os declarados — e foi REMOVIDA mesmo assim. Acerto alto não é
// certeza, e o custo dos dois lados não é simétrico: "(a)" é uma pequena deselegância de
// escrita; chamar alguém pelo gênero errado é ofensa pessoal, no primeiro e-mail que a marca
// manda. Não é o tipo de coisa que se decide por probabilidade.
//
// Consequência aceita: hoje só ~29 dos 77 cadastros declararam, então a maioria recebe "(a)".
// Isso melhora conforme a LP for preenchida — e o jeito de melhorar é o campo na LP, nunca
// uma regra mais esperta aqui.

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');

/** 'f', 'm' ou null. Só olha o que foi DECLARADO — o nome não entra na conta. */
function generoDe(_nome, sexoDeclarado) {
  const d = norm(sexoDeclarado);
  if (d.startsWith('f')) return 'f';   // feminino, feminina, f
  if (d.startsWith('m')) return 'm';   // masculino, m
  return null;
}

/** "seja bem-vindo" | "seja bem-vinda" | "seja bem-vindo(a)".
 *  As três encaixam em "{Nome}, {saudacao} à Comunidade Cells". */
function saudacaoDe(nome, sexoDeclarado) {
  const g = generoDe(nome, sexoDeclarado);
  return g === 'f' ? 'seja bem-vinda' : g === 'm' ? 'seja bem-vindo' : 'seja bem-vindo(a)';
}

/** Só o primeiro nome, com a inicial maiúscula. "GABRIEL RODRIGUES DE OLIVEIRA" → "Gabriel".
 *  Isto é formatação, não inferência: não muda o que a pessoa é, só como o nome aparece. */
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  if (!p) return '';
  return (p === p.toUpperCase() || p === p.toLowerCase())
    ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
    : p;
}

module.exports = { generoDe, saudacaoDe, primeiroNome };
