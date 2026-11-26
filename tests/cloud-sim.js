// Cloud tests against the simulated servers
const { chromium, devices } = require('playwright');
const { makeServer, install, SITE } = require('./cloudmock.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(100); } return false; };
const kit = (title, items) => JSON.stringify({ title, categories: ['כללי'], items }, null, 2);

(async () => {
  const b = await chromium.launch();
  for (const dev of ['Pixel 7', null]) {
    const tag = dev || 'desktop';
    const S = makeServer();
    const ctx = await b.newContext(dev ? devices[dev] : {});
    await install(ctx, S);
    const p = await ctx.newPage();
    const errs = [], csp = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (409|401|400|404)|net::ERR_INTERNET_DISCONNECTED/.test(m.text())) errs.push(m.text()); });
    await p.addInitScript(() => document.addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.blockedURI + ' ' + e.violatedDirective)));
    await p.goto(SITE);
    const disk = id => JSON.parse(S.files[id].text);

    // ---- Dropbox: connect → chooser → create ----
    ok((await p.textContent('#cloudDropboxBtn')).includes('התחבר לדרופבוקס'), tag + ': welcome shows "התחבר לדרופבוקס"');
    await p.click('#cloudDropboxBtn');
    await p.waitForURL(SITE + '**');
    ok(await until(() => p.isVisible('#cloudModalOverlay')), 'after Dropbox sign-in: chooser opens');
    ok(S.calls.some(c => c[1] === 'authorize' && c[2] === 'S256' && c[3] === SITE), 'sign-in uses PKCE (S256) and the registered address');
    ok(!p.url().includes('code='), 'sign-in code removed from the address bar');
    ok(await p.evaluate(() => localStorage.getItem('vc_cloud_dbx_pkce') === null), 'one-time sign-in secret removed');
    if (await p.isVisible('#cloudNewToggle')) await p.click('#cloudNewToggle'); await p.fill('#cloudNewName', 'תיק בדיקה');
    await p.click('#cloudCreateBtn');
    ok(await until(() => p.isVisible('#appContent')), 'new kit opens');
    const id = Object.keys(S.files)[0];
    ok(S.files[id].name === 'תיק בדיקה.json' && disk(id).title === 'תיק בדיקה', 'file created in the cloud with a Hebrew name');
    ok(/מחובר לדרופבוקס/.test(await p.textContent('#fileStatus')), 'status: connected to Dropbox');

    // ---- save: add an item ----
    await p.click('#addItemBtn'); await p.fill('#modalName', 'סליין'); await p.fill('#modalExpiry', '0628'); await p.press('#modalExpiry', 'Enter');
    ok(/שומר בענן/.test(await p.textContent('#fileStatus')), 'status: saving…');
    ok(await p.evaluate(() => hasUnsavedData()), 'unsaved while waiting (warns on leaving)');
    ok(await until(() => disk(id).items.some(i => i.name === 'סליין' && i.expiry === '2028-06')), 'item reached the cloud');
    ok(await until(async () => /נשמר בדרופבוקס/.test(await p.textContent('#fileStatus'))), 'status: saved in Dropbox');
    ok(!(await p.evaluate(() => hasUnsavedData())) && await p.evaluate(() => localStorage.getItem('vc_cloud_pendings') === null), 'nothing pending after save');

    // ---- 10 quick changes → few uploads, final content right ----
    const before = S.uploads;
    for (let k = 1; k <= 10; k++) await p.evaluate(k => { items[0].quantity = k; autoSave(); }, k);
    ok(await until(() => disk(id).items[0].quantity === 10), '10 quick changes: final value in the cloud');
    ok(S.uploads - before <= 2, `10 quick changes sent as ${S.uploads - before} upload(s)`);

    // ---- change on another device while open → back to tab reloads ----
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));
    const d1 = disk(id); d1.items.push({ id: 'item_900', name: 'מהמחשב', category: 'כללי', expiry: null }); S.externalEdit(id, JSON.stringify(d1));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    ok(await until(() => p.evaluate(() => items.some(i => i.name === 'מהמחשב'))), 'back to tab: change from another device loaded');

    // ---- conflict while editing ----
    const d2 = disk(id); d2.title = 'שונה במחשב'; S.externalEdit(id, JSON.stringify(d2));
    await p.evaluate(() => { items[0].quantity = 77; autoSave(); });
    ok(await until(async () => /השתנה ממכשיר אחר/.test(await p.textContent('#dialogTitle')) && await p.isVisible('#dialogOverlay')), 'conflict: "changed on another device" window');
    ok(disk(id).title === 'שונה במחשב', 'conflict: the other device\'s change was not overwritten');
    await p.click('#dialogActions button.primary');
    ok(await until(() => p.evaluate(() => customTitleText === 'שונה במחשב')), 'conflict → "load latest" loads it');
    await p.click('#dialogActions button'); // close info message
    const d3 = disk(id); d3.title = 'שוב שונה'; S.externalEdit(id, JSON.stringify(d3));
    await p.evaluate(() => { items[0].quantity = 55; autoSave(); });
    await until(() => p.isVisible('#dialogOverlay'));
    await p.click('#dialogActions button.danger-fill');
    ok(await until(() => disk(id).items[0].quantity === 55), 'conflict → "save anyway" saves the screen');

    // ---- offline → pending → back online ----
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));
    S.offline = true;
    await p.evaluate(() => { items[0].quantity = 33; autoSave(); });
    ok(await until(async () => /אין חיבור לענן/.test(await p.textContent('#fileStatus'))), 'offline: clear message, changes kept on device');
    ok(await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('vc_cloud_pendings'))).some(p => p.text.includes('"quantity": 33'))), 'offline: change kept on the device');
    S.offline = false;
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    ok(await until(() => disk(id).items[0].quantity === 33), 'back online: sent by itself');

    // ---- expired access token → refreshed silently ----
    S.tokenValid = false;
    await p.evaluate(() => { localStorage.setItem('vc_cloud_dbx', JSON.stringify({ ...JSON.parse(localStorage.getItem('vc_cloud_dbx')), exp: Date.now() + 3600e3 })); items[0].quantity = 44; autoSave(); });
    ok(await until(() => disk(id).items[0].quantity === 44), 'expired sign-in token: renewed and saved without asking');

    // ---- reload the page → kit opens by itself ----
    await p.reload();
    ok(await until(() => p.isVisible('#appContent')) && await p.evaluate(() => items[0].quantity === 44), 'reopening the site: last kit opens by itself');

    // ---- closed tab with a change not sent → applied on next open ----
    S.offline = true;
    await p.evaluate(() => { items[0].quantity = 66; autoSave(); });
    await wait(300);
    S.offline = false;
    await p.evaluate(() => { allowUnload = true; });
    await p.reload();
    ok(await until(() => disk(id).items[0].quantity === 66), 'change left on the device (tab closed offline) is sent on next open');

    // ---- sign-in revoked → reconnect button, change kept ----
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));
    S.tokenValid = false; S.refreshValid = false;
    await p.evaluate(() => { localStorage.setItem('vc_cloud_dbx', JSON.stringify({ ...JSON.parse(localStorage.getItem('vc_cloud_dbx')), exp: 0 })); items[0].quantity = 88; autoSave(); });
    ok(await until(async () => /החיבור לדרופבוקס נותק/.test(await p.textContent('#fileStatus'))), 'sign-in revoked: clear message + reconnect button');
    S.refreshValid = true;
    await p.click('#fileStatus button');
    await p.waitForURL(SITE + '**');
    ok(await until(() => disk(id).items[0].quantity === 88), 'after reconnecting: the waiting change is saved');

    // ---- file deleted in the cloud ----
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));
    const saved = S.files[id]; delete S.files[id];
    await p.evaluate(() => { items[0].quantity = 99; autoSave(); });
    ok(await until(async () => /לא נמצא בענן/.test(await p.textContent('#fileStatus'))), 'file deleted in the cloud: clear message');
    await p.click('#fileStatus button');
    const id2 = Object.keys(S.files).find(k => S.files[k].provider === 'dropbox');
    const got = await until(() => { const k = Object.keys(S.files).find(k => S.files[k].provider === 'dropbox'); return k && JSON.parse(S.files[k].text).items[0] && JSON.parse(S.files[k].text).items[0].quantity === 99; });
    console.log('DEBUG saveasnew', Object.values(S.files).map(f => f.name + ':' + f.text.length), await p.textContent('#fileStatus'));
    ok(got, '"save as a new kit" keeps the work');
    S.files[id] = saved;

    // ---- import a local file into the cloud ----
    if (!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');
    await p.click('#fileMenuBtn'); await p.click('#cloudMenuBtn');
    const vis = await until(() => p.isVisible('#cloudModalOverlay'));
    await until(async () => (await p.textContent('#cloudList')).length > 0, 4000);
    console.log('DEBUG menu', vis, JSON.stringify(await p.textContent('#cloudList')), JSON.stringify(await p.textContent('#cloudListStatus')), await p.isVisible('#cloudMenuBtn'));
    ok(vis && (await p.textContent('#cloudList')).includes('תיק בדיקה'), 'menu → my cloud kits lists the kits');
    const fs = require('fs'); const tmp = process.argv[2] + '/import.json';
    fs.writeFileSync(tmp, kit('כללית ברוכין', [{ id: 'item_001', name: 'אדרנלין', category: 'כללי', expiry: '2027-08' }]));
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#cloudImportBtn')]);
    await fc.setFiles(tmp);
    ok(await until(() => Object.values(S.files).some(f => f.name === 'כללית ברוכין.json')) && await until(() => p.evaluate(() => customTitleText === 'כללית ברוכין')), 'import: local file became a cloud kit and opened');

    // ---- local file still works, and switching back ----
    ok(await p.evaluate(() => document.getElementById('saveAsBtn').textContent.includes('הורדת עותק')), 'in the cloud, "save as" downloads a copy');
    ok((await p.evaluate(() => (window.__csp || []))).length === 0, 'no security-policy blocks: ' + JSON.stringify(await p.evaluate(() => window.__csp || [])));

    // ---- disconnect ----
    if (!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');
    await p.click('#fileMenuBtn'); await p.click('#cloudMenuBtn'); await until(() => p.isVisible('#cloudModalOverlay'));
    await p.click('#cloudDisconnectBtn'); await p.click('#dialogActions button.danger-fill');
    await p.waitForLoadState();
    ok(await until(async () => (await p.textContent('#cloudDropboxBtn')).includes('התחבר לדרופבוקס')), 'disconnect: back to welcome, signed out');
    ok(await p.evaluate(() => !localStorage.getItem('vc_cloud_dbx')) && S.calls.some(c => c[1] === 'revoke'), 'disconnect: sign-in removed and revoked at Dropbox');
    if (dev) await p.screenshot({ path: process.argv[2] + '/welcome-cloud.png', fullPage: true });

    // ---- Google Drive ----
    await p.click('#cloudGdriveBtn');                 // first click: loads Google's script
    await wait(500);
    if (!(await p.isVisible('#cloudModalOverlay'))) await p.click('#cloudGdriveBtn');
    ok(await until(() => p.isVisible('#cloudModalOverlay')), 'Drive: connect → chooser');
    if (await p.isVisible('#cloudNewToggle')) await p.click('#cloudNewToggle'); await p.fill('#cloudNewName', 'תיק דרייב'); await p.click('#cloudCreateBtn');
    ok(await until(() => p.isVisible('#appContent')), 'Drive: new kit opens');
    const gid = Object.keys(S.files).find(k => S.files[k].provider === 'gdrive');
    await p.click('#addItemBtn'); await p.fill('#modalName', 'פלסטר'); await p.press('#modalName', 'Enter');
    ok(await until(() => JSON.parse(S.files[gid].text).items.some(i => i.name === 'פלסטר')), 'Drive: item reached the cloud');
    await until(async () => !(await p.evaluate(() => hasUnsavedData())));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await wait(1200);
    ok(!/עודכן במכשיר אחר/.test(await p.textContent('#fileStatus')), 'Drive: back to the tab when only Google\'s version number moved — no "updated on another device" message');
    const g = JSON.parse(S.files[gid].text); g.title = 'בדרייב ממחשב'; S.externalEdit(gid, JSON.stringify(g));
    await p.evaluate(() => { items[0].quantity = 5; autoSave(); });
    ok(await until(async () => /השתנה ממכשיר אחר/.test(await p.textContent('#dialogTitle'))) && JSON.parse(S.files[gid].text).title === 'בדרייב ממחשב', 'Drive: conflict detected, nothing overwritten');
    await p.click('#dialogActions button.primary'); await p.click('#dialogActions button');
    // one-hour sign-in ran out
    await p.evaluate(() => { const g = JSON.parse(localStorage.getItem('vc_cloud_gd')); g.exp = Date.now() - 1; localStorage.setItem('vc_cloud_gd', JSON.stringify(g)); window.__gdRequests = 0; });
    await p.evaluate(() => { items[0].quantity = 6; autoSave(); });
    ok(await until(async () => /מבקש לאשר שוב/.test(await p.textContent('#fileStatus'))), 'Drive: sign-in ran out → clear message, change kept');
    await p.click('#fileStatus button');
    ok(await until(() => JSON.parse(S.files[gid].text).items[0].quantity === 6), 'Drive: one click renews and saves');
    await p.evaluate(() => { const g = JSON.parse(localStorage.getItem('vc_cloud_gd')); g.exp = Date.now() + 5 * 60e3; localStorage.setItem('vc_cloud_gd', JSON.stringify(g)); window.__gdRequests = 0; });
    await p.click('#summary');
    ok(await until(() => p.evaluate(() => window.__gdRequests > 0)), 'Drive: sign-in renewed on a click before it runs out');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
    ok(errs.length === 0, tag + ' no page errors: ' + errs.join(' | '));
    ok((await p.evaluate(() => (window.__csp || []))).length === 0, 'no security-policy blocks');
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})();
