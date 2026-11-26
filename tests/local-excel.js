const {chromium,devices}=require('playwright');
const path=require('path'),fsx=require('fs');const D=process.argv[2];
const URL_='http://vitalcheck.test/index.html';
const serve=async c=>c.route('http://vitalcheck.test/**',route=>{
  const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/,'');
  const f=path.join(process.cwd(),rel);
  if(!f.startsWith(process.cwd())||!fsx.existsSync(f))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[path.extname(f)]||'application/octet-stream';
  return route.fulfill({status:200,body:fsx.readFileSync(f),contentType:type});
});
const kit=JSON.stringify({title:'כללית ברוכין',categories:['כללי'],items:[
  {id:'item_001',name:'מזרק 50 מ"ל',category:'מחטים & מזרקים',quantity:2,expiry:'2028-12'},
  {id:'item_002',name:'סליין <10>',category:'עירויים',quantity:10,expiry:'2021-10',renewedAt:'2026-11-24'},
  {id:'item_003',name:'Steri-strip',category:'חבישה',expiry:'2026-12'},
  {id:'item_004',name:'פלסטרים',category:'חבישה',quantity:20,expiry:null}]});
const fake=`window.__disk=${JSON.stringify(kit)};
  const h={name:'kit.json',kind:'file',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    getFile:async()=>new File([window.__disk],'kit.json'),isSameEntry:async o=>o===h,
    createWritable:async()=>{let buf='';return {write:async t=>{buf=t},close:async()=>{window.__disk=buf;}}}};
  window.showOpenFilePicker=async()=>[h];`;
(async()=>{const b=await chromium.launch();
for (const dev of [null,'Pixel 7']){
  const c=await b.newContext({...(dev?devices[dev]:{}),acceptDownloads:true});await serve(c);const p=await c.newPage();const errs=[];
  p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.addInitScript(fake);await p.goto(URL_);await p.click('#openExistingBtn');await p.waitForTimeout(300);
  if(dev && !(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');
  await p.click('#fileMenuBtn');
  const [dl]=await Promise.all([p.waitForEvent('download'),p.click('#excelBtn')]);
  const out=path.join(D,(dev?'m-':'d-')+'export.xlsx');await dl.saveAs(out);
  console.log((dev||'desktop')+' file:',dl.suggestedFilename(),'toast:',await p.textContent('#toastText'),'errors:',errs);
  // filtered export
  await p.fill('#searchInput','חבישה');if(!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');await p.click('#fileMenuBtn');
  const [dl2]=await Promise.all([p.waitForEvent('download'),p.click('#excelBtn')]);await dl2.saveAs(path.join(D,'f-export.xlsx'));
  console.log(' filtered toast:',await p.textContent('#toastText'));
}
await b.close();})();
