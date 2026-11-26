const {chromium,devices}=require('playwright');
// Serve the project files under a fake http origin (like the real site), so fonts and modules load
const URL_='http://vitalcheck.test/index.html';
const path=require('path'),fsx=require('fs');
const serve=async c=>c.route('http://vitalcheck.test/**',route=>{
  const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/,'');
  const f=path.join(process.cwd(),rel);
  if(!f.startsWith(process.cwd())||!fsx.existsSync(f))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[path.extname(f)]||'application/octet-stream';
  return route.fulfill({status:200,body:fsx.readFileSync(f),contentType:type});
});
const settle=(p,ms)=>p.waitForTimeout(ms).then(()=>p.evaluate(()=>Promise.race([saveChain,new Promise(r=>setTimeout(r,9000))])).catch(()=>{}));
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const fake = (initial, perm) => `
  window.__disk=${JSON.stringify(initial)};window.__failWrite=false;
  const h={name:'kit.json',kind:'file',
    queryPermission:async()=>window.__perm||'${perm}',
    requestPermission:async()=>{window.__perm='granted';return 'granted';},
    getFile:async()=>new File([window.__disk],'kit.json'),
    isSameEntry:async(o)=>o===h,
    createWritable:async()=>{if(window.__failWrite)throw new Error('NotFoundError');let buf='';return {write:async t=>{buf=t},close:async()=>{window.__disk=buf;}}}};
  window.showOpenFilePicker=async()=>[h];`;
const kit=JSON.stringify({title:'t',categories:['כללי','עירויים'],items:[
  {id:'item_001',name:'סליין',category:'עירויים',expiry:'2027-01'},
  {id:'item_002',name:'פלסטר',category:'כללי',expiry:null},
  {id:'item_003',name:'ונפלון',category:'עירויים',expiry:'2026-12'}]},null,2);

(async()=>{const b=await chromium.launch();
async function page(script, ctx){const c=await b.newContext(ctx||{});await serve(c);const p=await c.newPage();p.errs=[];
  p.on('pageerror',e=>p.errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/could not access/.test(m.text()))p.errs.push(m.text())});
  if(script)await p.addInitScript(script);await p.goto(URL_);return p;}
const disk=p=>p.evaluate(()=>JSON.parse(window.__disk));

let p=await page(fake(kit,'granted'));
await p.click('#openExistingBtn');await settle(p,300);
// 8 search by category
await p.fill('#searchInput','עירוי');await settle(p,100);
ok((await p.$$('#tableBody tr')).length===2,'search finds by category');
await p.fill('#searchInput','');
// 5 delete + undo
await p.click('#tableBody tr:first-child .delete-btn');await p.click('#dialogActions button.danger-fill');await settle(p,200);
ok(await p.isVisible('#toast') && (await disk(p)).items.length===2,'delete is immediate, toast shown, saved');
await p.click('#toastUndo');await settle(p,300);
ok((await disk(p)).items.length===3 && await p.evaluate(()=>items.length)===3,'undo restores and saves');
// 6 Enter saves item
await p.click('#addItemBtn');await p.fill('#modalName','מזרק');await p.fill('#modalExpiry','0628');await p.press('#modalExpiry','Enter');await settle(p,300);
ok(!(await p.isVisible('#modalOverlay')) && (await disk(p)).items.some(i=>i.name==='מזרק'&&i.expiry==='2028-06'),'Enter saves new item');
// 7 duplicate name
await p.click('#addItemBtn');await p.fill('#modalName','סליין ');await p.press('#modalName','Enter');await settle(p,200);
ok(/כבר יש פריט/.test(await p.textContent('#dialogTitle'))&&await p.isVisible('#dialogOverlay'),'duplicate name warning');
await p.click('#dialogActions button:not(.primary)');await settle(p,200);
ok(await p.isVisible('#modalOverlay') && (await disk(p)).items.length===4,'"back" keeps window open, nothing added');
await p.click('#modalSave');await settle(p,200);await p.click('#dialogActions button.primary');await settle(p,300);
ok((await disk(p)).items.filter(i=>i.name.trim()==='סליין').length===2,'"save anyway" adds duplicate');
// editing an item and keeping its own name: no warning
await p.evaluate(()=>openModal('item_002'));await p.press('#modalName','Enter');await settle(p,200);
ok(!(await p.isVisible('#dialogOverlay')) && !(await p.isVisible('#modalOverlay')),'editing own name: no warning');
// title Enter
await p.click('#customTitle');await p.fill('#titleInput','תיק בדיקה');await p.press('#titleInput','Enter');await settle(p,300);
ok((await disk(p)).title==='תיק בדיקה','Enter saves title');
// title via keyboard
await p.focus('#customTitle');await p.keyboard.press('Enter');await settle(p,100);
ok(await p.isVisible('#titleModalOverlay'),'title opens from keyboard');
await p.keyboard.press('Escape');await settle(p,100);
// 1 save failure → warning on leave
await p.evaluate(()=>{window.__failWrite=true;items[0].quantity=5;autoSave();});await settle(p,8500);
ok(/לא נשמרו בקובץ/.test(await p.textContent('#fileStatus')) && await p.$('#fileStatus button'),'save error shown with save-as button');
ok(await p.evaluate(()=>hasUnsavedData()),'save failure counts as unsaved (warns on leave)');
await p.evaluate(()=>{window.__failWrite=false;items[0].quantity=6;autoSave();});await settle(p,2500);
ok(!(await p.evaluate(()=>hasUnsavedData())) && /נשמר אוטומטית/.test(await p.textContent('#fileStatus')),'successful save clears it');
// a11y: dialogs
const roles=await p.evaluate(()=>[...document.querySelectorAll('.modal-overlay')].map(o=>{const b=o.querySelector('[role=dialog]');return b&&b.getAttribute('aria-modal')==='true'&&!!document.getElementById(b.getAttribute('aria-labelledby'))}));
ok(roles.every(Boolean),'every window is a labelled dialog ('+roles.length+')');
// focus trap + return
await p.focus('#addItemBtn');await p.keyboard.press('Enter');await settle(p,150);
for(let k=0;k<12;k++)await p.keyboard.press('Tab');
ok(await p.evaluate(()=>modalOverlay.contains(document.activeElement)),'Tab stays inside window');
await p.keyboard.press('Shift+Tab');ok(await p.evaluate(()=>modalOverlay.contains(document.activeElement)),'Shift+Tab stays inside');
await p.click('#modalCancel');await settle(p,100);
ok(await p.evaluate(()=>document.activeElement.id)==='addItemBtn','focus returns to opener');
// sort by keyboard + aria-sort
await p.focus('th[data-key=name]');await p.keyboard.press('Enter');await settle(p,100);
ok(await p.getAttribute('th[data-key=name]','aria-sort')==='ascending' && await p.getAttribute('th[data-key=expiry]','aria-sort')==='none','keyboard sort + aria-sort');
ok(await p.getAttribute('#tableBody .edit-btn','aria-label')!==null,'row buttons labelled');
// conflict still works
await p.evaluate(()=>{const d=JSON.parse(window.__disk);d.title='מהטלפון';window.__disk=JSON.stringify(d);items[0].quantity=9;autoSave();});await settle(p,1800);
ok(/השתנה ממכשיר אחר/.test(await p.textContent('#dialogTitle')),'conflict check still works');
await p.keyboard.press('Escape');await settle(p,300);
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));

// 3 iPhone: download marks saved
p=await page('delete window.showOpenFilePicker;delete window.showSaveFilePicker;',devices['iPhone 13']);
await p.click('#createNewBtn');await settle(p,200);
ok(!(await p.evaluate(()=>hasUnsavedData())),'iPhone new kit: nothing unsaved');
await p.click('#addItemBtn');await p.fill('#modalName','א');await p.click('#modalSave');await settle(p,200);
ok(await p.evaluate(()=>hasUnsavedData()) && /שעוד לא הורדו/.test(await p.textContent('#fileStatus')),'iPhone change: unsaved + red notice');
const [dl]=await Promise.all([p.waitForEvent('download'),p.click('#fileStatus button')]);
ok(!!dl && !(await p.evaluate(()=>hasUnsavedData())) && /הורד קובץ/.test(await p.textContent('#fileStatus')),'iPhone download: marked saved');
await p.click('#addItemBtn');await p.fill('#modalName','ב');await p.click('#modalSave');await settle(p,200);
ok(await p.evaluate(()=>hasUnsavedData()),'iPhone: change after download is unsaved again');
// 4 send window on phone
await p.evaluate(()=>{navigator.canShare=()=>true;});
await p.click('#mobileToolbarToggle').catch(()=>{});
await p.evaluate(()=>document.getElementById('sendReportBtn').click());await settle(p,200);
ok(!(await p.isVisible('#sendGmail')) && await p.isVisible('#sendShare'),'phone: Gmail hidden, share shown');
ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=390,'iPhone: no horizontal scroll');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));

// desktop send window keeps Gmail
p=await page(fake(kit,'granted'));await p.click('#openExistingBtn');await settle(p,300);
await p.evaluate(()=>document.getElementById('sendReportBtn').click());await settle(p,200);
ok(await p.isVisible('#sendGmail'),'desktop: Gmail shown');
ok(p.errs.length===0,'no errors: '+p.errs.join(';'));
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
