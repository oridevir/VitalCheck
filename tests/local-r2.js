const {chromium,devices}=require('playwright');
const URL_='file://'+process.cwd()+'/index.html';
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};

// In-memory file handle; window.__disk holds the "file on disk"
const fake = (initial, perm) => `
  window.__disk=${JSON.stringify(initial)};window.__writes=0;
  const h={name:'kit.json',kind:'file',
    queryPermission:async()=>window.__perm||'${perm}',
    requestPermission:async()=>{window.__perm='granted';return 'granted';},
    getFile:async()=>new File([window.__disk],'kit.json'),
    isSameEntry:async(o)=>o===h,
    createWritable:async()=>{let buf='';return {write:async t=>{buf=t},close:async()=>{await new Promise(r=>setTimeout(r,Math.random()*30));window.__disk=buf;window.__writes++;}}}};
  window.__h=h;window.showOpenFilePicker=async()=>[h];`;

const kit = JSON.stringify({title:'t',categories:['כללי'],items:[
  {name:'אלף',expiry:'2027-01'},{name:'בית',expiry:'12/2026'},{id:'item_005',name:'גימל',expiry:'2026-12-15'},{id:'item_005',name:'דלת',expiry:'bad'}]},null,2);

(async()=>{const b=await chromium.launch();
async function page(script, dev){const c=await b.newContext(dev?devices[dev]:{});const p=await c.newPage();p.errs=[];
  p.on('pageerror',e=>p.errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/could not access/.test(m.text()))p.errs.push(m.text())});
  if(script)await p.addInitScript(script);await p.goto(URL_);return p;}

// ---- ids + expiry (2,3) ----
let p=await page(fake(kit,'granted'));
await p.click('#openExistingBtn');await p.waitForTimeout(400);
const its=await p.evaluate(()=>items.map(i=>[i.id,i.name,i.expiry]));
console.log(its);
ok(new Set(its.map(i=>i[0])).size===4 && its.every(i=>/^item_\d+$/.test(i[0])),'unique ids for all items');
ok(its.find(i=>i[1]==='בית')[2]==='2026-12' && its.find(i=>i[1]==='גימל')[2]==='2026-12' && its.find(i=>i[1]==='דלת')[2]===null,'expiry normalized');
ok(!(await p.textContent('#tableBody')).match(/undefined|NaN/),'no undefined/NaN on screen');
// edit row of "בית"
await p.evaluate(()=>openModal(items.find(i=>i.name==='בית').id));ok(await p.inputValue('#modalName')==='בית','edit opens the right item');
await p.click('#modalCancel');
// delete one item without original id
await p.evaluate(()=>{window.__sd=showDialog;window.showDialog=async()=>true;});await p.evaluate(()=>deleteItem(items.find(i=>i.name==='אלף').id));await p.waitForTimeout(300);
ok(await p.evaluate(()=>items.length)===3,'delete removes exactly one item');

// ---- queue (4): many quick edits, final disk = final state ----
await p.evaluate(async()=>{for(let k=0;k<6;k++){items[0].quantity=k+1;autoSave();} await saveChain;});
ok(await p.evaluate(()=>JSON.parse(window.__disk).items[0].quantity)===6,'rapid saves end with the latest data');

// ---- conflict (1) ----
await p.evaluate(()=>{window.showDialog=window.__sd;});
await p.evaluate(()=>{const d=JSON.parse(window.__disk);d.items.push({id:'item_900',name:'מהטלפון',expiry:null});window.__disk=JSON.stringify(d,null,2);});
await p.evaluate(()=>{items[0].quantity=99;autoSave();});await p.waitForTimeout(1800);
const dlg=await p.textContent('#dialogTitle');ok(/השתנה ממכשיר אחר/.test(dlg)&&await p.isVisible('#dialogOverlay'),'conflict dialog shown');
ok(await p.evaluate(()=>JSON.parse(window.__disk).items.some(i=>i.name==='מהטלפון')),'phone change not overwritten while asking');
await p.click('#dialogActions button.primary');await p.waitForTimeout(400);
ok(await p.evaluate(()=>items.some(i=>i.name==='מהטלפון')),'reload brings the phone change');
await p.click('#dialogActions button');// close info message
// overwrite path
await p.evaluate(()=>{const d=JSON.parse(window.__disk);d.title='other';window.__disk=JSON.stringify(d);});
await p.evaluate(()=>{items[0].quantity=7;autoSave();});await p.waitForTimeout(1800);
await p.click('#dialogActions button.danger-fill');await p.waitForTimeout(400);
ok(await p.evaluate(()=>JSON.parse(window.__disk).items[0].quantity===7),'overwrite writes screen data');
// ---- visibility reload ----
await p.evaluate(()=>{const d=JSON.parse(window.__disk);d.items.push({id:'item_901',name:'עוד מהטלפון',expiry:null});window.__disk=JSON.stringify(d,null,2);});
await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await p.waitForTimeout(300);
ok(await p.evaluate(()=>items.some(i=>i.name==='עוד מהטלפון')),'returning to tab loads newer file');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));

// ---- (5) bad file not remembered ----
p=await page(fake('%PDF nope','prompt'));
await p.click('#openExistingBtn');await p.waitForTimeout(400);
ok(/פגום/.test(await p.textContent('#dialogTitle')),'bad file → corrupt message');
const stored=await p.evaluate(()=>getHandleFromDB().then(h=>!!h));ok(!stored,'bad file not remembered as last file');

// ---- (6) Esc on permission window ----
p=await page(fake(kit,'prompt'));
await p.click('#openExistingBtn');await p.waitForTimeout(300);
ok(await p.isVisible('#permInfoModalOverlay'),'permission explanation shown');
await p.keyboard.press('Escape');await p.waitForTimeout(200);
ok(!(await p.isVisible('#permInfoModalOverlay'))&&!(await p.isVisible('#permDeniedModalOverlay'))&&!(await p.isVisible('#dialogOverlay')),'Esc closes quietly');
await p.click('#openExistingBtn');await p.waitForTimeout(300);await p.click('#permInfoContinue');await p.waitForTimeout(300);
ok(await p.isVisible('#appContent'),'can open again after Esc');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));

// ---- (7) iPhone new kit ----
p=await page('delete window.showOpenFilePicker;delete window.showSaveFilePicker;','iPhone 13');
await p.click('#createNewBtn');await p.waitForTimeout(300);
ok(await p.isVisible('#appContent'),'iPhone: new kit opens');
ok(/תיק חדש/.test(await p.textContent('#fileStatus')),'iPhone: unsaved notice shown');
await p.click('#addItemBtn');await p.fill('#modalName','בדיקה');await p.click('#modalSave');await p.waitForTimeout(200);
ok(await p.evaluate(()=>items.length===1&&items[0].id==='item_001'),'iPhone: item added');
ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=390,'iPhone: no horizontal scroll');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));

// ---- desktop smoke ----
p=await page(null);ok(p.errs.length===0,'desktop load no errors');
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
