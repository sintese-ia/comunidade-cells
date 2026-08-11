const {Pool}=require('pg');
const pool=new Pool({connectionString:'postgresql://claude_b2b:nlvhZd6c2sFjOCGW55AEqFAt1cMN@easypanel.sinteseia.com.br:5432/dadoscells'});
(async()=>{const r=await pool.query(process.argv[2]);console.table(r.rows);await pool.end();})().catch(e=>{console.error(e.message);process.exit(1)});
