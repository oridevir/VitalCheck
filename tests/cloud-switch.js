// Switching between Dropbox and Google Drive inside the "my kits" window
const { chromium, devices } = require('playwright');
const { makeServer, install, SITE } = require('./cloudmock.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };

(async () => {
  const b = await chromium.launch();
  for (const dev of ['Pixel 7', null]) {
    const tag = (dev || 'desktop') + ': ';
    const S = makeServer();
    const ctx = await b.newContext(dev ? devices[dev] : {});
    await install(ctx, S);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (409|401|400|404)/.test(m.text())) errs.push(m.text()); });
    await p.goto(SITE);
    const openMenu = async () => { if (!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle'); await p.click('#fileMenuBtn'); };
    const kits = () => p.$$eval('#cloudList .t1', els => els.map(e => e.textContent));

    // Dropbox only: no switch link
    await p.click('#cloudDropboxBtn'); await p.waitForURL(SITE + '**');
    ok(await until(() => p.isVisible('#cloudModalOverlay')), tag + 'Dropbox chooser opens');
    ok(!(await p.isVisible('#cloudOtherBtn')), tag + 'only Dropbox connected: no switch link');
    if (await p.isVisible('#cloudNewToggle')) await p.click('#cloudNewToggle');
    await p.fill('#cloudNewName', 'תיק דרופבוקס'); await p.click('#cloudCreateBtn');
    ok(await until(() => p.isVisible('#appContent')), tag + 'Dropbox kit opens');
    await p.evaluate(() => { items.push({ id: 'item_1', name: 'סליין', category: 'כללי', expiry: '2028-06' }); autoSave(); });
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // back to welcome, connect Drive
    await openMenu(); await p.click('#startOverBtn'); await p.click('#dialogActions button.primary');
    await until(() => p.isVisible('#cloudGdriveBtn'));
    await p.click('#cloudGdriveBtn'); await wait(500);
    if (!(await p.isVisible('#cloudModalOverlay'))) await p.click('#cloudGdriveBtn');
    ok(await until(() => p.isVisible('#cloudModalOverlay')), tag + 'Drive chooser opens');
    ok(await p.isVisible('#cloudOtherBtn') && (await p.textContent('#cloudOtherBtn')).includes('התיקים שלי בדרופבוקס'), tag + 'Drive chooser: link to Dropbox kits');
    if (await p.isVisible('#cloudNewToggle')) await p.click('#cloudNewToggle');
    await p.fill('#cloudNewName', 'תיק דרייב'); await p.click('#cloudCreateBtn');
    ok(await until(async () => (await p.isVisible('#appContent')) && await p.evaluate(() => cloudDoc && cloudDoc.provider === 'gdrive')), tag + 'Drive kit opens');
    await p.evaluate(() => { items.push({ id: 'item_1', name: 'פלסטר', category: 'כללי', expiry: '2027-01' }); autoSave(); });
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // File menu → my kits (Drive) → switch to Dropbox → open Dropbox kit
    await openMenu(); await p.click('#cloudMenuBtn');
    ok(await until(async () => (await p.textContent('#cloudTitle')).includes('גוגל דרייב')), tag + 'menu opens the Drive list (open kit is in Drive)');
    await p.click('#cloudOtherBtn');
    ok(await until(async () => (await p.textContent('#cloudTitle')).includes('דרופבוקס') && JSON.stringify(await kits()) === JSON.stringify(['תיק דרופבוקס'])), tag + 'switch: Dropbox kits listed');
    ok((await p.textContent('#cloudOtherBtn')).includes('גוגל דרייב') && !(await p.isVisible('#cloudPickBtn')), tag + 'in Dropbox list: link back to Drive, no Drive picker');
    await p.click('#cloudList .cloud-kit');
    ok(await until(() => p.evaluate(() => cloudDoc && cloudDoc.provider === 'dropbox' && items.some(i => i.name === 'סליין'))), tag + 'Dropbox kit opened from the switched list');

    // and back to Drive
    await openMenu(); await p.click('#cloudMenuBtn');
    await until(async () => (await p.textContent('#cloudTitle')).includes('דרופבוקס'));
    await p.click('#cloudOtherBtn');
    ok(await until(async () => JSON.stringify(await kits()) === JSON.stringify(['תיק דרייב'])), tag + 'switch back: Drive kits listed');
    await p.click('#cloudList .cloud-kit');
    ok(await until(() => p.evaluate(() => cloudDoc && cloudDoc.provider === 'gdrive' && items.some(i => i.name === 'פלסטר'))), tag + 'Drive kit opened, its data intact');

    // quick double switch: the list matches the title (no stale list)
    await openMenu(); await p.click('#cloudMenuBtn');
    await until(async () => (await p.textContent('#cloudTitle')).includes('גוגל דרייב'));
    await p.click('#cloudOtherBtn'); await p.click('#cloudOtherBtn');
    await wait(1500);
    ok((await p.textContent('#cloudTitle')).includes('גוגל דרייב') && JSON.stringify(await kits()) === JSON.stringify(['תיק דרייב']), tag + 'fast double switch: list matches title');
    if (dev) await p.screenshot({ path: process.argv[2] + '/switch.png' });
    await p.click('#cloudClose');

    // files in the cloud untouched by switching
    const byName = n => JSON.parse(Object.values(S.files).find(f => f.name === n).text);
    ok(byName('תיק דרופבוקס.json').items.map(i => i.name).join() === 'סליין' && byName('תיק דרייב.json').items.map(i => i.name).join() === 'פלסטר', tag + 'both cloud files hold their own items');
    ok(!errs.length, tag + 'no page errors: ' + errs.join(' | '));
    await ctx.close();
  }
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
