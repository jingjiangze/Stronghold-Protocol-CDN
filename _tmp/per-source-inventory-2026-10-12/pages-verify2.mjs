// band_justin 重试 3 次 + 分段（Range）验证，判定是源上缺还是源上慢
import fs from 'node:fs';
const index=JSON.parse(fs.readFileSync(new URL('./wscdn-index.json',import.meta.url),'utf8'));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const p='assets/band/band_justin.png';
const exp=index.files[p].size;
async function get(url,ms,hdrs={}){
  const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),ms);const t0=Date.now();
  try{const r=await fetch(url,{signal:ctl.signal,redirect:'follow',headers:{'user-agent':UA,...hdrs}});
    clearTimeout(t);const b=Buffer.from(await r.arrayBuffer());
    return {code:r.status,bytes:b.byteLength,ms:Date.now()-t0,len:r.headers.get('content-length'),ct:r.headers.get('content-type')};}
  catch(e){clearTimeout(t);return {code:'TIMEOUT',bytes:0,ms:Date.now()-t0};}
}
console.log('--- 全量取 4 次 ---');
for(let i=0;i<4;i++){
  const r=await get('https://spages.jiangjiangze.icu/'+p,180000);
  console.log(String(i+1).padStart(2),String(r.code).padEnd(8),String(r.bytes).padEnd(8),(r.ms+'ms').padEnd(9),r.ct||'',r.len||'', (r.code===200&&r.bytes===exp)?'✓字节相符':'');
}
console.log('--- HEAD（只看头，不取体）---');
try{const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),60000);
  const r=await fetch('https://spages.jiangjiangze.icu/'+p,{method:'HEAD',signal:ctl.signal,headers:{'user-agent':UA}});
  clearTimeout(t);console.log('HEAD',r.status,'content-length=',r.headers.get('content-length'),'ct=',r.headers.get('content-type'),'age=',r.headers.get('age'),'cf-cache-status=',r.headers.get('cf-cache-status'));
}catch(e){console.log('HEAD 超时');}
console.log('--- Range 取前 1KB ---');
const g=await get('https://spages.jiangjiangze.icu/'+p,120000,{range:'bytes=0-1023'});
console.log('RANGE',g.code,g.bytes+'B',g.ms+'ms');
console.log('expect bytes =',exp);
