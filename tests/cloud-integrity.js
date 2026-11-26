// Data-integrity tests (simulated Dropbox/Drive): every way the user's work could be lost or changed
const { chromium, devices } = require('playwright');
const { makeServer, install, SITE } = require('./cloudmock.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await wait(100); } return false; };
const IGNORE = /Failed to load resource|net::ERR_/;

// Awkward content: Hebrew, quotes, backslashes, HTML, emoji, RTL marks, newlines, very long text
const NASTY = [
  'סליין 0.9% "רגיל" 500 מ\'ל', 'C:\\path\\x', '<script>alert(1)</script>', '</textarea><b>bold</b>',
  'מזרק 💉 + 🩹', '\u200fטקסט\u200f עם סימני כיוון', 'שורה1\nשורה2', 'א'.repeat(300), '{"json":"inside"}', '&amp; &lt;'
];
const kitText = (title, n) => JSON.stringify({
  title, categories: ['כללי', 'עירויים', 'קטגוריה "מיוחדת"'],
  items: Array.from({ length: n }, (_, i) => ({ id: 'item_' + String(i + 1).padStart(3, '0'), name: NASTY[i % NASTY.length] + ' #' + i,
    category: i % 3 === 0 ? 'עירויים' : i % 3 === 1 ? 'כללי' : 'קטגוריה "מיוחדת"', expiry: i % 4 ? `202${7 + i % 3}-0${1 + i % 9}` : null,
    quantity: i % 5 ? i : null, ...(i % 7 === 0 ? { renewedAt: '2026-11-20' } : {}), ...(i % 11 === 0 ? { futureField: { nested: [1, 'x'] } } : {}) })),
  trash: [{ id: 'item_900', name: 'נמחק "בבדיקה"', category: 'כללי', expiry: null, quantity: null, deletedAt: new Date().toISOString() }],
  log: [{ at: new Date().toISOString(), text: 'נוסף "x" ← y' }]
}, null, 2);

async function setup(b, dev, files) {
  const S = makeServer();
  const ids = {};
  for (const [prov, name, text] of files) ids[name] = S.addFile(prov, name, text);
  const ctx = await b.newContext(dev ? devices[dev] : {});
  await install(ctx, S);
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('vc_cloud_dbx')) localStorage.setItem('vc_cloud_dbx', JSON.stringify({ refresh: 'RT1', access: 'AT1', exp: Date.now() + 3600e3 }));
    document.addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.blockedURI + ' ' + e.violatedDirective));
  });
  return { S, ids, ctx };
}
async function newPage(ctx, errs) {
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text()); });
  await p.goto(SITE);
  return p;
}
const openKit = async (p, id) => { await p.evaluate(id => openCloudDoc('dropbox', id), id); await until(() => p.isVisible('#appContent')); };
const settled = p => until(async () => !(await p.evaluate(() => hasUnsavedData())), 15000);

(async () => {
  const b = await chromium.launch();
  const dev = process.argv[3] || 'Pixel 7';
  const errs = [];

  // ---------- 1. Round trip: the file is not changed by opening and saving ----------
  {
    const orig = kitText('תיק "בדיקה" <מיוחד>', 120);
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'nasty.json', orig]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['nasty.json']);
    const shown = await p.evaluate(() => items.length);
    ok(shown === 120, 'opens all 120 items with awkward names');
    ok(await p.evaluate(() => !document.querySelector('#tableBody script') && !document.querySelector('#tableBody b')), 'names with HTML/script are shown as text, not run');
    ok(S.uploads === 0, 'opening a kit does not write to the cloud');
    // a small change, then compare everything else
    await p.evaluate(() => { items.find(i => i.id === 'item_002').quantity = 999; autoSave(); });
    await until(() => S.uploads > 0); await settled(p);
    const a = JSON.parse(orig), c = JSON.parse(S.files[ids['nasty.json']].text);
    a.items.find(i => i.id === 'item_002').quantity = 999;
    const strip = o => JSON.stringify({ title: o.title, items: o.items, trash: o.trash });
    ok(strip(a) === strip(c), 'after a change: every other item, field, trash entry and extra field is identical');
    ok(c.log.length === a.log.length + 0 || c.log.length >= a.log.length, 'change log kept');
    ok(JSON.stringify(c.categories.slice().sort()) === JSON.stringify(a.categories.slice().sort()), 'categories kept');
    await ctx.close();
  }

  // ---------- 2. Editing while a slow save is in flight ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 5)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    S.delay = 2500;
    await p.evaluate(() => { items[0].quantity = 1; autoSave(); });
    await wait(2300);                                   // the save is now on its way (slow)
    await p.evaluate(() => { items[1].quantity = 2; autoSave(); });
    await wait(400);
    await p.evaluate(() => { items[2].quantity = 3; autoSave(); });
    S.delay = 0;
    ok(await until(() => { const c = JSON.parse(S.files[ids['k.json']].text); return c.items[0].quantity === 1 && c.items[1].quantity === 2 && c.items[2].quantity === 3; }, 15000),
      'changes made while a slow save was in flight all reach the cloud');
    ok(await settled(p), 'and nothing is left waiting');
    ok(!(await p.isVisible('#dialogOverlay')), 'no false "changed on another device" window');
    await ctx.close();
  }

  // ---------- 3. Server errors: 500, 429, full storage, answer lost ----------
  for (const kind of ['500', '429', 'space', 'lost']) {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 3)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    S.failNext = { kind, count: kind === 'lost' ? 1 : 2 };
    await p.evaluate(() => { items[0].quantity = 77; autoSave(); });
    if (kind === 'space') {
      ok(await until(async () => /אין מקום פנוי/.test(await p.textContent('#fileStatus'))), 'full storage: clear message, change kept');
      await p.click('#fileStatus button'); await wait(300); await p.click('#fileStatus button');
    } else if (kind !== 'lost') {
      ok(await until(async () => /השינויים שמורים במכשיר/.test(await p.textContent('#fileStatus'))), `server ${kind}: message says changes are kept`);
      await until(async () => (await p.$('#fileStatus button')) !== null);
      await p.click('#fileStatus button');
      await wait(500);
      if (S.failNext.count === 0 && JSON.parse(S.files[ids['k.json']].text).items[0].quantity !== 77) await p.click('#fileStatus button').catch(() => {});
    } else {
      await wait(1500);
      await p.evaluate(() => cloudSaveNow());
    }
    ok(await until(() => JSON.parse(S.files[ids['k.json']].text).items[0].quantity === 77, 25000), `server ${kind}: the change reaches the cloud in the end`);
    ok(await settled(p), `server ${kind}: nothing left waiting`);
    ok(!(await p.isVisible('#dialogOverlay')), `server ${kind}: no false conflict window`);
    await ctx.close();
  }

  // ---------- 4. Unsent changes in kit A survive working in kit B ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'A.json', kitText('A', 3)], ['dropbox', 'B.json', kitText('B', 3)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['A.json']);
    S.offline = true;
    await p.evaluate(() => { items[0].quantity = 111; autoSave(); });
    await until(async () => /אין חיבור/.test(await p.textContent('#fileStatus')));
    // switch to B while offline: asked, then continue
    const sw = p.evaluate(id => cloudOpenFromChooser('dropbox', id), ids['B.json']);
    await until(() => p.isVisible('#dialogOverlay'));
    ok(/עוד לא הגיעו לענן/.test(await p.textContent('#dialogTitle')), 'switching kits with unsent changes: asks first');
    S.offline = false;
    await p.click('#dialogActions button.primary');
    await sw; await until(() => p.evaluate(() => customTitleText === 'B'));
    await p.evaluate(() => { items[0].quantity = 222; autoSave(); });
    ok(await until(() => JSON.parse(S.files[ids['B.json']].text).items[0].quantity === 222), 'kit B change saved');
    ok(JSON.parse(S.files[ids['A.json']].text).items[0].quantity !== 111, '(kit A change not sent yet — it was offline)');
    await openKit(p, ids['A.json']);
    ok(await until(() => JSON.parse(S.files[ids['A.json']].text).items[0].quantity === 111), 'reopening kit A: its unsent change is applied and saved (not lost)');
    await ctx.close();
  }

  // ---------- 5. Two tabs on the same kit ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 3)]]);
    const t1 = await newPage(ctx, errs); await openKit(t1, ids['k.json']);
    const t2 = await newPage(ctx, errs); await until(() => t2.isVisible('#appContent'));
    await t1.evaluate(() => { items[0].quantity = 10; autoSave(); });
    await until(() => JSON.parse(S.files[ids['k.json']].text).items[0].quantity === 10); await settled(t1);
    await t2.evaluate(() => { items[1].quantity = 20; autoSave(); });
    ok(await until(async () => /השתנה ממכשיר אחר/.test(await t2.textContent('#dialogTitle')) && await t2.isVisible('#dialogOverlay')), 'two tabs: the second tab is warned, not silently overwriting');
    ok(JSON.parse(S.files[ids['k.json']].text).items[0].quantity === 10, 'two tabs: first tab\'s change still in the cloud');
    await t2.click('#dialogActions button.primary');                     // load latest
    ok(await until(() => t2.evaluate(() => items[0].quantity === 10)), 'two tabs: "load latest" shows the first tab\'s change');
    await ctx.close();
  }

  // ---------- 6. Broken file in the cloud is never overwritten ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'bad.json', '{ "items": [ broken'], ['dropbox', 'empty.json', ''], ['dropbox', 'k.json', kitText('k', 3)]]);
    const p = await newPage(ctx, errs);
    await p.evaluate(id => openCloudDoc('dropbox', id), ids['bad.json']);
    ok(await until(async () => /פגום/.test(await p.textContent('#dialogTitle'))), 'broken file: "file is damaged" message');
    ok(S.files[ids['bad.json']].text === '{ "items": [ broken' && S.uploads === 0, 'broken file: left untouched');
    await p.click('#dialogActions button');
    await p.evaluate(id => openCloudDoc('dropbox', id), ids['empty.json']);
    await wait(800);
    ok(S.files[ids['empty.json']].text === '' && S.uploads === 0, 'empty file: not written over by just opening it');
    if (await p.isVisible('#dialogOverlay')) await p.click('#dialogActions button');
    await openKit(p, ids['k.json']);
    S.externalEdit(ids['k.json'], 'not json at all');      // someone breaks it while open
    await p.evaluate(() => { items[0].quantity = 5; autoSave(); });
    await until(() => p.isVisible('#dialogOverlay'));
    await p.click('#dialogActions button.primary').catch(() => {});   // "load latest"
    await wait(500);
    ok(await p.evaluate(() => items.length === 3), 'damaged by someone while open: the screen keeps the data (not replaced by garbage)');
    ok(await p.evaluate(() => getBackups().some(b => b.count === 3)), 'and the data is in the local backups');
    await ctx.close();
  }

  // ---------- 7. Leaving the page / start over / disconnect with unsent changes ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 3)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    S.offline = true;
    await p.evaluate(() => { items[0].quantity = 31; autoSave(); });
    await until(async () => /אין חיבור/.test(await p.textContent('#fileStatus')));
    ok(await p.evaluate(() => hasUnsavedData()), 'offline change: leaving the page warns');
    // "start over" → asks; continue → change still kept on device
    if (!(await p.isVisible('#fileMenuBtn'))) await p.click('#mobileToolbarToggle');
    await p.click('#fileMenuBtn'); await p.click('#startOverBtn');
    ok(await until(() => p.isVisible('#dialogOverlay')), 'start over with unsent changes: asks first');
    await p.click('#dialogActions button.danger-fill');
    await p.waitForLoadState(); await wait(500);
    S.offline = false;
    await openKit(p, ids['k.json']);
    ok(await until(() => JSON.parse(S.files[ids['k.json']].text).items[0].quantity === 31), 'after start over: reopening the kit still sends the kept change');
    await ctx.close();
  }

  // ---------- 8. Reports and export still work (security policy) ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('כללית ברוכין', 30)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    const pdf = await p.evaluate(async () => { const f = await buildReportFile(); return f.size; });
    ok(pdf > 5000, 'PDF report builds in cloud mode (fonts and libraries load under the security policy): ' + pdf + ' bytes');
    const xl = await p.evaluate(() => buildExcel(items).size);
    ok(xl > 1000, 'Excel export builds');
    ok((await p.evaluate(() => window.__csp || [])).length === 0, 'no security-policy blocks');
    await ctx.close();
  }

  // ---------- 9. Google Drive: unsent change survives the one-hour sign-in running out + reload ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['gdrive', 'g.json', kitText('g', 3)]]);
    await ctx.addInitScript(() => { if (!localStorage.getItem('vc_cloud_gd')) localStorage.setItem('vc_cloud_gd', JSON.stringify({ connected: true, access: 'gd-token-1', exp: Date.now() + 3000e3 })); });
    const p = await newPage(ctx, errs);
    await p.evaluate(id => openCloudDoc('gdrive', id), ids['g.json']); await until(() => p.isVisible('#appContent'));
    await p.evaluate(() => { const g = JSON.parse(localStorage.getItem('vc_cloud_gd')); g.exp = Date.now() - 1; localStorage.setItem('vc_cloud_gd', JSON.stringify(g)); });
    await p.evaluate(() => { items[0].quantity = 64; autoSave(); });
    await until(async () => /מבקש לאשר שוב/.test(await p.textContent('#fileStatus')));
    await p.evaluate(() => { allowUnload = true; });
    await p.reload();
    ok(await until(() => p.isVisible('#cloudResume')), 'Drive, sign-in expired, page reloaded: "continue to kit" button');
    await p.click('#cloudResume button'); await wait(400);
    if (!(await p.isVisible('#appContent'))) await p.click('#cloudResume button');
    ok(await until(() => JSON.parse(S.files[ids['g.json']].text).items[0].quantity === 64), 'Drive: the change made before the reload is saved after one click');
    await ctx.close();
  }

  // ---------- 10. File deleted + no internet when pressing "save as a new kit" ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 3)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    delete S.files[ids['k.json']];
    await p.evaluate(() => { items[0].quantity = 12; autoSave(); });
    await until(async () => /לא נמצא בענן/.test(await p.textContent('#fileStatus')));
    S.offline = true;
    await p.click('#fileStatus button');
    await until(() => p.isVisible('#dialogOverlay'));
    ok(/לא נוצר/.test(await p.textContent('#dialogTitle')), 'save-as-new while offline: says it was not created');
    await p.click('#dialogActions button');
    ok(await p.evaluate(() => cloudHasPending() && items[0].quantity === 12), 'save-as-new while offline: changes still waiting, nothing cleared');
    S.offline = false;
    await p.click('#fileStatus button');
    ok(await until(() => Object.values(S.files).some(f => f.provider === 'dropbox' && JSON.parse(f.text).items[0].quantity === 12)), 'back online: the work is saved in the new kit');
    await ctx.close();
  }

  // ---------- 11. Choosing "the cloud version" keeps this device's changes in the backups ----------
  {
    const { S, ids, ctx } = await setup(b, dev, [['dropbox', 'k.json', kitText('k', 3)]]);
    const p = await newPage(ctx, errs);
    await openKit(p, ids['k.json']);
    S.offline = true;
    await p.evaluate(() => { items[0].quantity = 41; autoSave(); });
    await until(async () => /אין חיבור/.test(await p.textContent('#fileStatus')));
    const d = JSON.parse(S.files[ids['k.json']].text); d.title = 'שונה במקום אחר'; S.externalEdit(ids['k.json'], JSON.stringify(d, null, 2));
    S.offline = false;
    await p.evaluate(() => { allowUnload = true; cloudDoc = null; });   // as if the tab was closed
    await p.reload();
    ok(await until(async () => /נשארו שינויים/.test(await p.textContent('#dialogTitle'))), 'reopen with unsent changes + cloud changed elsewhere: asks which version');
    await p.click('#dialogActions button.primary');                   // the cloud version
    ok(await until(() => p.evaluate(() => customTitleText === 'שונה במקום אחר')), 'chose the cloud version');
    ok(await p.evaluate(() => getBackups().some(b => /לא נשלחו/.test(b.title) && b.data.includes('"quantity": 41'))), 'this device\'s changes were kept in "שחזור מגיבוי"');
    ok(JSON.parse(S.files[ids['k.json']].text).title === 'שונה במקום אחר', 'the other device\'s change is intact in the cloud');
    await ctx.close();
  }

  ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})();
