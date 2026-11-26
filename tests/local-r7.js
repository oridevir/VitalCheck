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
const kit=JSON.stringify({title:'t',categories:['כללי'],items:[
  {id:'item_001',name:'א',category:'כללי',expiry:'2027-01'},{id:'item_002',name:'ב',category:'כללי',expiry:'2027-02'}]},null,2);
// Fussy phone provider: refuses a write that starts < BUSY ms after the last close;
// a writable that was neither closed nor aborted keeps the file locked.
const fake=`window.__disk=${JSON.stringify(kit)};window.__lastClose=0;window.__locked=false;window.__busy=1000;window.__alwaysFail=false;window.__writes=0;
  const err=n=>{const e=new Error('The object can not be modified in this way.');e.name=n;return e;};
  const h={name:'kit.json',kind:'file',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    getFile:async()=>new File([window.__disk],'kit.json'),isSameEntry:async o=>o===h,
    createWritable:async()=>{
      if(window.__locked)throw err('InvalidModificationError');
      window.__locked=true;let buf='';const start=Date.now();
      return {write:async t=>{ if(window.__alwaysFail||start-window.__lastClose<window.__busy) throw err('InvalidModificationError'); buf=t;},
        close:async()=>{window.__disk=buf;window.__locked=false;window.__lastClose=Date.now();window.__writes++;},
        abort:async()=>{window.__locked=false;}};}};
  window.showOpenFilePicker=async()=>[h];`;
(async()=>{const b=await chromium.launch();
const c=await b.newContext(devices['Pixel 7']);await serve(c);const p=await c.newPage();const errs=[];
p.on('pageerror',e=>errs.push(e.message));
await p.addInitScript(fake);await p.goto(URL_);await p.click('#openExistingBtn');await p.waitForTimeout(300);
const disk=()=>p.evaluate(()=>JSON.parse(window.__disk));

// ב: delete asks first
await p.click('#tableBody tr:first-child .delete-btn');await p.waitForTimeout(150);
ok(/מחיקת פריט/.test(await p.textContent('#dialogTitle')),'delete asks for confirmation');
await p.click('#dialogActions button:not(.danger-fill)');await p.waitForTimeout(150);
ok(await p.evaluate(()=>items.length)===2,'"ביטול" keeps the item');
// delete + immediate undo on the fussy phone
await p.click('#tableBody tr:first-child .delete-btn');await p.click('#dialogActions button.danger-fill');
await p.waitForTimeout(100);await p.click('#toastUndo');
ok(await p.evaluate(()=>hasUnsavedData()),'while saves are pending, leaving the page warns');
await p.waitForTimeout(5000);
ok(!(await p.isVisible('#dialogOverlay')),'no "changed elsewhere" window');
ok((await disk()).items.length===2 && !(await p.evaluate(()=>window.__locked)),'file ends with both items, not locked');
ok(/נשמר אוטומטית/.test(await p.textContent('#fileStatus')) && await p.evaluate(()=>fileStatus.className)==='file-status connected','green "saved" box');
ok(!(await p.evaluate(()=>hasUnsavedData())),'nothing unsaved after');
// persistent failure → clear Hebrew message + retry button; retry works once the phone recovers
await p.evaluate(()=>{window.__alwaysFail=true;items[0].quantity=4;autoSave();});
await p.waitForTimeout(8500);
const st=await p.textContent('#fileStatus');
ok(/לא נשמרו בקובץ/.test(st) && /InvalidModificationError @ write/.test(st) && await p.isVisible('#fileStatus button'),'persistent failure: Hebrew message, error detail, retry button');
ok(await p.evaluate(()=>hasUnsavedData()) && !(await p.evaluate(()=>window.__locked)),'unsaved flagged, file not left locked');
await p.evaluate(()=>{window.__alwaysFail=false;});await p.click('#fileStatus button');await p.waitForTimeout(3000);
ok((await disk()).items[0].quantity===4 && /נשמר אוטומטית/.test(await p.textContent('#fileStatus')),'"נסה לשמור שוב" saves');
await p.screenshot({path:D+'/status-green.png',clip:{x:0,y:300,width:412,height:300}});
await p.evaluate(()=>{window.__alwaysFail=true;items[0].quantity=5;autoSave();});await p.waitForTimeout(8500);
await (await p.$('#fileStatus')).screenshot({path:D+'/status-red.png'});
ok(errs.length===0,'no page errors: '+errs.join(';'));
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
