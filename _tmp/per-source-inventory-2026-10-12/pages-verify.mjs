// pages 三路径：长超时 + 字节比对，判定「慢但完整」还是「真的缺」
import fs from 'node:fs';
const index=JSON.parse(fs.readFileSync(new URL('./wscdn-index.json',import.meta.url),'utf8'));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const paths=['assets/band/band_justin.png','assets/module/lib-x.png','assets/ui/bandChoose/btn_comfirm_check.png'];
async function get(base,p,ms){
  const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),ms);const t0=Date.now();
  try{const r=await fetch(base+'/'+p,{signal:ctl.signal,redirect:'follow',headers:{'user-agent':UA}});
    clearTimeout(t);const b=Buffer.from(await r.arrayBuffer());
    return {code:r.status,bytes:b.byteLength,ms:Date.now()-t0};}
  catch(e){clearTimeout(t);return {code:'TIMEOUT',bytes:0,ms:Date.now()-t0};}
}
for(const p of paths){
  const exp=index.files[p].size;
  const a=await get('https://spages.jiangjiangze.icu',p,120000);
  const b=await get('https://weishucdn.jiangjiangze.icu',p,60000);
  console.log(p.padEnd(46),'expect='+String(exp).padEnd(8),
    '| pages',String(a.code).padEnd(5),String(a.bytes).padEnd(8),(a.ms+'ms').padEnd(9),(a.code===200&&a.bytes===exp)?'✓字节相符':'✗',
    '| r2',String(b.code).padEnd(4),String(b.bytes).padEnd(8),(b.ms+'ms').padEnd(9));
}
