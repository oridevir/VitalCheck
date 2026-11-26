const {chromium,devices}=require('playwright');
const path=require('path'),fsx=require('fs');const D=process.argv[2];
const URL_='http://vitalcheck.test/index.html';
const serve=async c=>c.route('http://vitalcheck.test/**',route=>{
  const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/,'');
  const f=path.join(process.cwd(),rel);
  if(!f.startsWith(process.cwd())||!fsx.existsSync(f))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.ttf':'font/ttf'}[path.extname(f)]||'application/octet-stream';
  return route.fulfill({status:200,body:fsx.readFileSync(f),contentType:type});
});
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const old=new Date(Date.now()-40*86400000).toISOString(), recent=new Date(Date.now()-3*86400000).toISOString();
const kit=JSON.stringify({title:'כללית ברוכין',categories:['כללי','עירויים'],items:[
  {id:'item_001',name:'סליין 10 מ"ל',category:'עירויים',quantity:10,expiry:'2021-10'},
  {id:'item_002',name:'פלסטר',category:'כללי',expiry:null}],
  trash:[{id:'item_007',name:'ישן מאוד',category:'כללי',expiry:null,deletedAt:old},
         {id:'item_009',name:'משטח מעבדה',category:'מעבדה',quantity:10,expiry:'2026-06',deletedAt:recent}]},null,2);
const fake=`window.__disk=${JSON.stringify(kit)};
  const h={name:'kit.json',kind:'file',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    getFile:async()=>new File([window.__disk],'kit.json'),isSameEntry:async o=>o===h,
    createWritable:async()=>{let buf='';return {write:async t=>{buf=t},close:async()=>{window.__disk=buf;},abort:async()=>{}}}};
  window.showOpenFilePicker=async()=>[h];`;
const settle=(p,ms)=>p.waitForTimeout(ms).then(()=>p.evaluate(()=>Promise.race([saveChain,new Promise(r=>setTimeout(r,9000))])));
(async()=>{const b=await chromium.launch();
for (const dev of [null,'Pixel 7']){
const c=await b.newContext(dev?devices[dev]:{});await serve(c);const p=await c.newPage();const errs=[];
p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.addInitScript(fake);await p.goto(URL_);await p.click('#openExistingBtn');await settle(p,300);
const disk=()=>p.evaluate(()=>JSON.parse(window.__disk));
const tag=dev||'desktop';
ok(await p.evaluate(()=>trash.length===1&&trash[0].name==='משטח מעבדה'),tag+': trash loaded, >30-day item purged');
// delete → goes to trash + log
await p.locator('#tableBody tr',{hasText:'פלסטר'}).locator('.delete-btn').click();await p.click('#dialogActions button.danger-fill');await settle(p,200);
let d=await disk();
ok(d.items.length===1 && d.trash.some(t=>t.name==='פלסטר'&&t.deletedAt) && d.log[0].text.includes('נמחק "פלסטר"'),'delete: saved to trash and log in the file');
ok(d.items.length===1 && d.title==='כללית ברוכין' && Array.isArray(d.categories),'file keeps title/categories/items for the monthly report');
// undo removes from trash
await p.click('#toastUndo');await settle(p,200);d=await disk();
ok(d.items.length===2 && !d.trash.some(t=>t.name==='פלסטר') && d.log[0].text.includes('בוטלה המחיקה'),'undo: back in items, out of trash, logged');
// edit + add logged
await p.evaluate(()=>openModal('item_002'));await p.fill('#modalQuantity','5');await p.press('#modalQuantity','Enter');await settle(p,200);
await p.click('#addItemBtn');await p.fill('#modalName','מזרק');await p.fill('#modalExpiry','0628');await p.press('#modalExpiry','Enter');await settle(p,200);
d=await disk();
ok(d.log[1].text.includes('עודכן "פלסטר": כמות: — ← 5') && d.log[0].text.includes('נוסף "מזרק" (06.28)'),'edit and add logged');
ok(d.items.find(i=>i.name==='מזרק').id==='item_010','new id skips ids in trash (item_009)');
// open trash window, restore
if(dev){ if(!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle'); }
await p.click('#fileMenuBtn');await p.click('#trashBtn');await p.waitForTimeout(150);
ok(await p.isVisible('#trashModalOverlay') && (await p.textContent('#trashList')).includes('משטח מעבדה') && (await p.textContent('#logList')).includes('נוסף "מזרק"'),'window shows trash and log');
if(dev) await p.screenshot({path:D+'/trash.png'});
await p.click('#trashList button');await settle(p,200);d=await disk();
ok(d.items.some(i=>i.name==='משטח מעבדה'&&i.id==='item_009'&&!('deletedAt' in i)) && !(d.trash||[]).length && d.categories.includes('מעבדה'),'restore: back with its id and category');
ok((await p.textContent('#trashList')).includes('אין פריטים') && d.log[0].text.includes('שוחזר'),'trash window updates; restore logged');
await p.click('#trashClose');
// reopen file: trash/log persist
ok(await p.evaluate(()=>{parseData(window.__disk);return changeLog.length>=5;}),'log persists after reload');
ok(errs.length===0,tag+' no errors: '+errs.join(';'));
}
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
