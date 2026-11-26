const {chromium,devices}=require('playwright');
const path=require('path'),fsx=require('fs');
const URL_='http://vitalcheck.test/index.html';
const serve=async c=>c.route('http://vitalcheck.test/**',route=>{
  const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/,'');
  const f=path.join(process.cwd(),rel);
  if(!f.startsWith(process.cwd())||!fsx.existsSync(f))return route.fulfill({status:404,body:''});
  const type={'.html':'text/html','.js':'text/javascript','.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[path.extname(f)]||'application/octet-stream';
  return route.fulfill({status:200,body:fsx.readFileSync(f),contentType:type});
});
const settle=(p,ms)=>p.waitForTimeout(ms).then(()=>p.evaluate(()=>Promise.race([saveChain,new Promise(r=>setTimeout(r,9000))])).catch(()=>{}));
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const kit=JSON.stringify({title:'t',categories:['כללי'],items:[
  {id:'item_001',name:'סליין 10 מ"ל',category:'כללי',quantity:10,expiry:'2021-10'},
  {id:'item_002',name:'פלסטר',category:'כללי',expiry:null}]},null,2);
const fake=`window.__disk=${JSON.stringify(kit)};
  const h={name:'kit.json',kind:'file',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    getFile:async()=>new File([window.__disk],'kit.json'),isSameEntry:async o=>o===h,
    createWritable:async()=>{let buf='';return {write:async t=>{buf=t},close:async()=>{window.__disk=buf;}}}};
  window.showOpenFilePicker=async()=>[h];`;
(async()=>{const b=await chromium.launch();
for (const dev of [null,'Pixel 7']){
  const c=await b.newContext(dev?devices[dev]:{});await serve(c);const p=await c.newPage();const errs=[];
  p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await p.addInitScript(fake);await p.goto(URL_);await p.click('#openExistingBtn');await settle(p,300);
  const tag=dev||'desktop';const disk=()=>p.evaluate(()=>JSON.parse(window.__disk));
  const row=p.locator('#tableBody tr',{hasText:'סליין'});
  await row.locator('.renew-btn').click();await settle(p,150);
  ok(await p.isVisible('#renewModalOverlay') && /תוקף נוכחי: אוקטובר 2021/.test(await p.textContent('#renewInfo')),tag+': renew window with current expiry');
  ok(await p.evaluate(()=>document.activeElement.id)==='renewExpiry' && await p.inputValue('#renewQuantity')==='10','focus on expiry, quantity prefilled');
  await p.press('#renewExpiry','Enter');await settle(p,100);
  ok(/יש להזין/.test(await p.textContent('#renewModalOverlay')),'empty expiry rejected');
  await p.fill('#renewExpiry','0124');await p.press('#renewExpiry','Enter');await settle(p,100);
  ok(/כבר עבר/.test(await p.textContent('#dialogTitle')) && await p.isVisible('#dialogOverlay'),'past expiry: asks, does not block');
  await p.click('#dialogActions button:not(.primary)');await p.waitForTimeout(150);
  ok(await p.isVisible('#renewModalOverlay') && (await disk()).items[0].expiry==='2021-10','"חזרה לעריכה": nothing saved, window stays');
  await p.press('#renewExpiry','Enter');await p.waitForTimeout(150);await p.click('#dialogActions button.primary');await settle(p,300);
  ok((await disk()).items[0].expiry==='2024-01','"שמור בכל זאת": past expiry saved');
  await p.click('#toastUndo');await settle(p,300);
  ok((await disk()).items[0].expiry==='2021-10','undo of past-expiry renewal');
  await row.locator('.renew-btn').click();await p.waitForTimeout(150);
  await p.fill('#renewExpiry','');await p.type('#renewExpiry','0629');ok(await p.inputValue('#renewExpiry')==='06/29','auto slash');
  await p.fill('#renewQuantity','12');await p.press('#renewQuantity','Enter');await settle(p,300);
  let it=(await disk()).items[0];
  ok(it.expiry==='2029-06'&&it.quantity===12&&/^\d{4}-\d{2}-\d{2}$/.test(it.renewedAt),'saved to file with renewedAt');
  ok(await p.isVisible('#toast') && /חודש/.test(await p.textContent('#toastText')),'toast shown');
  ok(!(await p.isVisible('#renewModalOverlay')),'window closed');
  await p.click('#toastUndo');await settle(p,300);
  it=(await disk()).items[0];
  ok(it.expiry==='2021-10'&&it.quantity===10&&!('renewedAt' in it),'undo restores previous values');
  // renew again then reopen shows "last renewed"
  await row.locator('.renew-btn').click();await p.fill('#renewExpiry','06/29');await p.click('#renewSave');await settle(p,300);
  await p.locator('#tableBody tr',{hasText:'סליין'}).locator('.renew-btn').click();await settle(p,100);
  ok(/חודש לאחרונה/.test(await p.textContent('#renewInfo')),'shows last renewal date');
  await p.keyboard.press('Escape');await settle(p,100);
  ok(!(await p.isVisible('#renewModalOverlay')) && await p.evaluate(()=>document.activeElement.classList.contains('renew-btn')),'Esc closes, focus back on button');
  // renew item without expiry
  await p.locator('#tableBody tr',{hasText:'פלסטר'}).locator('.renew-btn').click();
  ok(/ללא תוקף/.test(await p.textContent('#renewInfo')),'item without expiry shows "ללא תוקף"');
  await p.click('#renewCancel');
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll');
  if(dev){await p.screenshot({path:process.argv[2]+'/renew-row.png'});
    await p.locator('#tableBody tr',{hasText:'סליין'}).locator('.renew-btn').click();await settle(p,150);await p.screenshot({path:process.argv[2]+'/renew-modal.png'});}
  ok(errs.length===0,tag+' no errors: '+errs.join(';'));
}
await b.close();console.log(fails?`${fails} FAILED`:'ALL PASSED');})();
