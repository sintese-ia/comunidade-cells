// Como o e-mail decide entre "bem-vindo" e "bem-vinda".
//
// Errar o gênero de alguém no PRIMEIRO e-mail que a marca manda é um vexame pessoal, não um
// detalhe de copy. Por isso a regra é conservadora: só arrisca quando tem certeza, e quando
// não tem usa "bem-vindo(a)".
//
// Ordem de confiança:
//   1. o que a pessoa DECLAROU na LP (campo `sexo`) — nada ganha disso;
//   2. lista de primeiros nomes comuns cuja terminação engana (Rachel, Gabriel, Beatriz);
//   3. terminação -a (feminino) e -o (masculino), que em português acerta quase sempre;
//   4. sem certeza → "bem-vindo(a)".

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');

// Femininos que NÃO terminam em -a
const F = new Set(`rachel raquel monique beatriz bia yasmim yasmin ivete ione karen ester esther
isabel cristiane cristiani adriane daniele danielle michele michelle jaqueline jacqueline caroline
carolline nicole nicolle simone ivone iris ingrid elis denise elaine eliane luciene rosane solange
doris lais thais tais ines suely nataly natalie emily kelly sthefany jhenifer jennifer heloise
miriam alice eloise cassiane josiane rosangela vivian gisele grazielle janaine ariane mariane
luane evellyn evelyn madalen carmen liz mercedes noemi naomi rute rebeca ruth judite edith
soledad consuelo dulce cloe zoe fabiane fabiani viviane josefine katia`.split(/\s+/));

// Masculinos que NÃO terminam em -o
const M = new Set(`gabriel rafael raphael daniel manuel miguel israel vitor victor heitor nestor
lucas matheus mateus carlos marcos andres luis luiz thomas tomas nicolas jonas elias josue davi
levi ravi kevin alan adrian christian cristian fabian julian ivan ruan wesley kayky kaique
henrique felipe philipe alexandre vicente clemente jorge jose andre cesar nelson wilson edson
anderson emerson jefferson robson everton alisson alison jean yan ian erick erik patrick isaac
abner samuel joel gil raul saul ismael ezequiel gessiaria klinger brynner walter valter gunter
nolan dylan bryan ryan luan renan juan silas caio`.split(/\s+/));

// Terminações em -a que na verdade são masculinas
const A_MASC = new Set('luca nicola joshua josua elia jeremia sasha misha jefta'.split(/\s+/));

/** Devolve 'f', 'm' ou null (sem certeza). */
function generoDe(nome, sexoDeclarado) {
  const d = norm(sexoDeclarado);
  if (d.startsWith('f')) return 'f';
  if (d.startsWith('m')) return 'm';

  const p = norm(String(nome || '').trim().split(/\s+/)[0]);
  if (!p || p.length < 2) return null;
  if (F.has(p)) return 'f';
  if (M.has(p)) return 'm';
  if (p.endsWith('a') && !A_MASC.has(p)) return 'f';
  if (p.endsWith('o')) return 'm';
  return null;
}

/** "seja bem-vindo" | "seja bem-vinda" | "seja bem-vindo(a)" quando não dá para saber.
 *  Decisão do Gabriel: prefere o (a) explícito a uma saudação neutra. */
function saudacaoDe(nome, sexoDeclarado) {
  const g = generoDe(nome, sexoDeclarado);
  return g === 'f' ? 'seja bem-vinda' : g === 'm' ? 'seja bem-vindo' : 'seja bem-vindo(a)';
}

/** Só o primeiro nome, com a inicial maiúscula. "GABRIEL RODRIGUES DE OLIVEIRA" → "Gabriel".
 *  Nome em caixa alta no título de e-mail parece cobrança. */
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  if (!p) return '';
  // nome todo em maiúscula ou todo minúsculo vira Capitalizado; nome já misto fica como está
  return (p === p.toUpperCase() || p === p.toLowerCase())
    ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
    : p;
}

module.exports = { generoDe, saudacaoDe, primeiroNome };
