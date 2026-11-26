// Real Dropbox (app folder of "VitalCheck Medical") — the site runs from disk at its real address,
// API calls go to the real Dropbox servers; the test key is added by the environment's proxy.
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path'), fs = require('fs');
const ROOT = process.cwd(), SITE = 'https://vitalcheck.drdevir.com/', D = process.argv[2];
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await wait(250); } return false; };
const esc = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function dbx(host, ep, arg, body) {
  const args = ['-s', '--max-time', '30', '-X', 'POST', `https://${host}.dropboxapi.com/2/${ep}`, '-H', 'Authorization: Bearer proxy-injected'];
  if (host === 'content') args.push('-H', 'Dropbox-API-Arg: ' + esc(arg), '-H', 'Content-Type: application/octet-stream', '--data-binary', body == null ? '' : body);
  else args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(arg));
  return execFileSync('curl', args, { encoding: 'utf8' });
}
const cloudText = id => dbx('content', 'files/download', { path: id });
const cloudJson = id => JSON.parse(cloudText(id));
const allFiles = () => JSON.parse(dbx('api', 'files/list_folder', { path: '' })).entries.map(e => ({ name: e.name, id: e.id, rev: e.rev }));
const listNames = () => allFiles().filter(e => e.name.startsWith('VCTEST'));   // the test's own files only

(async () => {
  // start clean: remove earlier test files from the app folder
  for (const f of listNames()) dbx('api', 'files/delete_v2', { path: f.id });
  ok(listNames().length === 0, 'no leftover test files at start');
  // the user's own kits in the folder: remembered, and checked untouched at the end
  const userFiles = allFiles().filter(e => !e.name.startsWith('VCTEST'));
  console.log('user files in the app folder (never touched):', userFiles.map(f => f.name).join(', ') || 'none');
  const b = await chromium.launch();
  for (const dev of ['Pixel 7', null]) {
    const tag = dev || 'desktop';
    const ctx = await b.newContext(dev ? devices[dev] : {});
    await ctx.route(SITE + '**', route => {
      const u = new URL(route.request().url());
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.join(ROOT, rel);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(f)] || 'application/octet-stream';
      return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: type });
    });
    // signed in (the real key is added by the proxy)
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('vc_cloud_dbx')) localStorage.setItem('vc_cloud_dbx', JSON.stringify({ refresh: 'proxy', access: 'proxy-injected', exp: Date.now() + 3 * 3600e3 }));
      document.addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.blockedURI + ' ' + e.violatedDirective));
    });
    let p = await ctx.newPage();
    const errs = [];
    const watch = pg => { pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: (the server responded with a status of 409|net::ERR_INTERNET_DISCONNECTED)/.test(m.text())) errs.push(m.text()); }); };
    watch(p);
    await p.goto(SITE);
    ok((await p.textContent('#cloudDropboxBtn')).includes('התיקים שלי'), tag + ': signed in → "התיקים שלי בדרופבוקס"');

    // create a kit with a Hebrew name
    await p.click('#cloudDropboxBtn');
    ok(await until(() => p.isVisible('#cloudModalOverlay')), 'chooser opens (real list from Dropbox)');
    const kitName = `VCTEST בדיקה ${tag} ${Date.now() % 10000}`;
    if (await p.isVisible('#cloudNewToggle')) await p.click('#cloudNewToggle'); await p.fill('#cloudNewName', kitName); await p.click('#cloudCreateBtn');
    ok(await until(() => p.isVisible('#appContent')), 'kit created and opened');
    const entry = () => listNames().find(e => e.name === kitName + '.json');
    ok(await until(() => !!entry()), 'file exists in Dropbox with the Hebrew name: ' + kitName + '.json');
    const id = entry().id;
    ok(await until(async () => /מחובר לדרופבוקס/.test(await p.textContent('#fileStatus'))), 'status: connected (read back from Dropbox incl. version)');

    // add item → in the cloud
    await p.click('#addItemBtn'); await p.fill('#modalName', 'סליין 10 מ"ל'); await p.fill('#modalExpiry', '0229'); await p.fill('#modalQuantity', '10'); await p.press('#modalQuantity', 'Enter');
    ok(await until(() => cloudJson(id).items.some(i => i.name === 'סליין 10 מ"ל' && i.expiry === '2029-02' && i.quantity === 10)), 'item reached real Dropbox');
    ok(await until(async () => /נשמר בדרופבוקס/.test(await p.textContent('#fileStatus'))), 'status: saved in Dropbox');

    // 15 quick changes
    for (let k = 1; k <= 15; k++) { await p.evaluate(k => { items[0].quantity = k; autoSave(); }, k); await wait(80); }
    ok(await until(() => cloudJson(id).items[0].quantity === 15), '15 quick changes: final value in Dropbox');
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // another device changes the file → back to the tab loads it
    const d1 = cloudJson(id); d1.items.push({ id: 'item_900', name: 'מהמחשב', category: 'כללי', expiry: null });
    dbx('content', 'files/upload', { path: id, mode: 'overwrite', mute: true }, JSON.stringify(d1, null, 2));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    ok(await until(() => p.evaluate(() => items.some(i => i.name === 'מהמחשב'))), 'change made on another device loads when returning to the tab');

    // conflict while editing
    const d2 = cloudJson(id); d2.title = 'VCTEST שונה במכשיר אחר';
    dbx('content', 'files/upload', { path: id, mode: 'overwrite', mute: true }, JSON.stringify(d2, null, 2));
    await p.evaluate(() => { items[0].quantity = 70; autoSave(); });
    ok(await until(async () => /השתנה ממכשיר אחר/.test(await p.textContent('#dialogTitle')) && await p.isVisible('#dialogOverlay')), 'conflict detected by Dropbox (rev)');
    ok(cloudJson(id).title === 'VCTEST שונה במכשיר אחר', 'conflict: the other device\'s change was not overwritten');
    await p.click('#dialogActions button.danger-fill');
    ok(await until(() => cloudJson(id).items[0].quantity === 70), 'conflict → "save anyway" writes the screen');
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // no internet → kept on device → sent when back
    await ctx.setOffline(true);
    await p.evaluate(() => { items[0].quantity = 31; autoSave(); });
    ok(await until(async () => /אין חיבור לענן/.test(await p.textContent('#fileStatus'))), 'offline: clear message');
    await ctx.setOffline(false);
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    ok(await until(() => cloudJson(id).items[0].quantity === 31), 'back online: sent by itself');
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // close the tab 0.3s after a change (before the 2s delay) → still reaches Dropbox
    await p.evaluate(() => { items[0].quantity = 42; autoSave(); allowUnload = true; });
    await wait(300);
    await p.close({ runBeforeUnload: true });
    const sentOnClose = await until(() => cloudJson(id).items[0].quantity === 42, 8000);
    p = await ctx.newPage(); watch(p);
    await p.goto(SITE);
    ok(await until(() => p.isVisible('#appContent')), 'reopening the site opens the last kit by itself');
    ok(await until(() => cloudJson(id).items[0].quantity === 42) && await p.evaluate(() => items[0].quantity === 42),
      'change made right before closing the tab is saved' + (sentOnClose ? ' (sent while closing)' : ' (sent on reopen)'));

    // big kit (200 items + full log) still saves
    await p.evaluate(() => { for (let k = 0; k < 200; k++) { items.push({ id: 'item_' + (1000 + k), name: 'פריט ארוך מאוד לבדיקת גודל מספר ' + k, category: 'כללי', expiry: '2027-0' + (1 + k % 9), quantity: k + 1 }); logChange('בדיקת גודל ' + k); } autoSave(); });
    ok(await until(() => cloudJson(id).items.length >= 200), 'big kit (200 items, full log) saved');
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));

    // file deleted in Dropbox → message + save as new
    dbx('api', 'files/delete_v2', { path: id });
    await p.evaluate(() => { items[0].quantity = 9; autoSave(); });
    ok(await until(async () => /לא נמצא בענן/.test(await p.textContent('#fileStatus'))), 'deleted in Dropbox: clear message');
    await p.click('#fileStatus button');
    ok(await until(() => p.evaluate(i => cloudDoc && cloudDoc.id !== i && items[0].quantity === 9, id)) && await until(() => listNames().some(f => f.id !== id && cloudJson(f.id).items[0].quantity === 9)), '"save as a new kit" keeps the work in a new file');

    // import a device file
    if (!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');
    await p.click('#fileMenuBtn'); await p.click('#cloudMenuBtn');
    await until(() => p.isVisible('#cloudModalOverlay'));
    const tmp = D + '/real-import.json';
    fs.writeFileSync(tmp, JSON.stringify({ title: `VCTEST ייבוא ${tag}`, categories: ['כללי'], items: [{ id: 'item_001', name: 'אדרנלין', category: 'כללי', expiry: '2027-08' }] }));
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#cloudImportBtn')]);
    await fc.setFiles(tmp);
    ok(await until(() => listNames().some(e => e.name === `VCTEST ייבוא ${tag}.json`)) && await until(() => p.evaluate(t => customTitleText === t, `VCTEST ייבוא ${tag}`)), 'import: device file became a Dropbox kit');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
    ok((await p.evaluate(() => window.__csp || [])).length === 0, 'no security-policy blocks with the real servers');
    ok(errs.length === 0, tag + ' no page errors: ' + errs.join(' | '));
    await ctx.close();
  }
  await b.close();
  for (const f of listNames()) dbx('api', 'files/delete_v2', { path: f.id });
  console.log('cleanup: test files left:', listNames().length);
  const after = allFiles().filter(e => !e.name.startsWith('VCTEST'));
  ok(after.length === userFiles.length && userFiles.every(u => after.some(a => a.id === u.id && a.rev === u.rev)), 'the user\'s own kits are untouched (same files, same versions)');
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})();
