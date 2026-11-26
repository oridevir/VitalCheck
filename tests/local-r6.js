const {chromium,devices}=require('playwright');
const path=require('path'),fsx=require('fs');
const URL_='http://vitalcheck.test/index.html';
const serve=async c=>c.route('http://vitalcheck.test/**',route=>{
  const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/,'');
  const f=path.join(process.cwd(),rel);
  if(!f.startsWith(process.cwd())||!fsx.existsSync(f))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.ttf':'font/ttf'}[path.extname(f)]||'application/octet-stream';
  return route.fulfill({status:200,body:fsx.readFileSync(f),contentType:type});
});
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const kit=JSON.stringify({title:'t',categories:['כללי'],items:[
  {id:'item_001',name:'א',category:'כללי',expiry:'2027-01'},{id:'item_002',name:'ב',category:'כללי',expiry:'2027-02'}]},null,2);
// Like the phone: for STALE ms after a write, reads still return the previous content
const fake=STALE=>`window.__disk=${JSON.stringify(kit)};window.__prev=null;window.__until=0;
  const h={name:'kit.json',kind:'file',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    getFile:async()=>new File([Date.now()<window.__until&&window.__prev!==null?window.__prev:window.__disk],'kit.json'),
    isSameEntry:async o=>o===h,
    createWritable:async()=>{let buf='';return {write:async t=>{buf=t},close:async()=>{window.__prev=window.__disk;window.__disk=buf;window.__until=Date.now()+${STALE};}}}};
  window.showOpenFilePicker=async()=>[h];`;
(async()=>{const b=await chromium.launch();
async function open(stale){const c=await b.newContext(devices['Pixel 7']);await serve(c);const p=await c.newPage();p.errs=[];
  p.on('pageerror',e=>p.errs.push(e.message));p.on('console',m=>{if(m.type()==='error')p.errs.push(m.text())});
  await p.addInitScript(fake(stale));await p.goto(URL_);await p.click('#openExistingBtn');await p.waitForTimeout(300);return p;}
const disk=p=>p.evaluate(()=>JSON.parse(window.__disk));

// 1. delete + immediate undo with a stale phone read → no false alarm, item back in the file
let p=await open(800);
await p.click('#tableBody tr:first-child .delete-btn');await p.click('#dialogActions button.danger-fill');await p.waitForTimeout(100);
await p.click('#toastUndo');await p.waitForTimeout(5000);
ok(!(await p.isVisible('#dialogOverlay')),'delete+undo on slow phone: no false "changed elsewhere" window');
ok((await disk(p)).items.length===2,'file has both items after undo');
// 2. returning to the tab while the read is stale → no reload of the older version
await p.click('#tableBody tr:first-child .delete-btn');await p.click('#dialogActions button.danger-fill');await p.waitForTimeout(150);
await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await p.waitForTimeout(300);
ok(await p.evaluate(()=>items.length)===1,'stale read on tab return does not bring back the deleted item');
await p.waitForTimeout(1000);
// 3. a real change from another device still triggers the window
await p.evaluate(()=>{const d=JSON.parse(window.__disk);d.items.push({id:'item_900',name:'מהמחשב',category:'כללי',expiry:null});window.__disk=JSON.stringify(d,null,2);window.__until=0;});
await p.evaluate(()=>{items[0].quantity=3;autoSave();});await p.waitForTimeout(2000);
ok(/השתנה ממכשיר אחר/.test(await p.textContent('#dialogTitle'))&&await p.isVisible('#dialogOverlay'),'real change elsewhere still detected');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
