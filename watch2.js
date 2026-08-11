const {Pool}=require('pg');
const pool=new Pool({connectionString:'postgresql://claude_b2b:nlvhZd6c2sFjOCGW55AEqFAt1cMN@easypanel.sinteseia.com.br:5432/dadoscells'});
let ultimoWh=8, ultimoStory=0;   // só emite quando MUDA — a versão anterior repetia a cada tique
async function tick(){
  const r=await pool.query("SELECT id, origem, erro, payload::text p FROM jarvis.webhook_bruto WHERE id>$1 ORDER BY id",[ultimoWh]);
  for(const x of r.rows){
    ultimoWh=Math.max(ultimoWh,+x.id);
    const t = /story_mention/.test(x.p) ? 'STORY MENTION' : (x.origem==='meta:recusado' ? 'RECUSADO(assinatura)' : 'evento');
    console.log(`WEBHOOK #${x.id} ${t}${x.erro?' erro='+x.erro:''}`);
  }
  const s=await pool.query("SELECT publicacao_id id, instagram_handle h, parceiro_id pid, (SELECT tamanho FROM creator.publicacao_midia m WHERE m.publicacao_id=u.publicacao_id) bytes, (SELECT erro FROM creator.publicacao_midia m WHERE m.publicacao_id=u.publicacao_id) errm FROM creator.publicacao u WHERE tipo='story' AND publicacao_id>$1 ORDER BY publicacao_id",[ultimoStory]);
  for(const x of s.rows){
    ultimoStory=Math.max(ultimoStory,+x.id);
    const ok = /^\d+$/.test(x.h) ? 'HANDLE AINDA NUMERICO' : '@'+x.h;
    console.log(`STORY #${x.id} ${ok} | parceiro=${x.pid||'ORFAO'} | midia=${x.bytes?x.bytes+' bytes':'FALHOU '+(x.errm||'')}`);
  }
}
(async()=>{ for(;;){ try{ await tick(); }catch(e){ console.log('watch erro: '+e.message); } await new Promise(r=>setTimeout(r,20000)); } })();
