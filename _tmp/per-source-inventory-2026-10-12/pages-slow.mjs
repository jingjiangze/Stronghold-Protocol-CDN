// pages 三个超时路径用长超时重测，判定是「慢」还是「真的缺」
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const paths=[
 'assets/band/band_justin.png',
 'assets/module/lib-x.png',
 'assets/ui/bandChoose/btn_comfirm_check.png',
 'assets/audio/bgm/m_bat_abyssalhunters_intro.mp3',
];
async function get(p,ms){
  const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),ms);const t0=Date.now();
  try{const r=await fetch('https://spages.jiangjiangze.icu/'+p,{signal:ctl.signal,redirect:'follow',headers:{'user-agent':UA}});
    clearTimeout(t);const b=Buffer.from(await r.arrayBuffer());
    return {code:r.status,bytes:b.byteLength,ms:Date.now()-t0};}
  catch(e){clearTimeout(t);return {code:'TIMEOUT',bytes:0,ms:Date.now()-t0};}
}
for(const p of paths){
  const a=await get(p,120000);
  const b=await get(p.replace(/^\//,''),120000);
  console.log(p.padEnd(52), 'pages', String(a.code).padEnd(8), String(a.ms).padEnd(7)+'ms', '| r2', String(b.code).padEnd(6), b.ms+'ms');
}
