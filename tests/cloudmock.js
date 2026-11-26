// Simulated Dropbox + Google Drive servers for Playwright tests, and the site served at its real address.
const path = require('path'), fs = require('fs');
const ROOT = process.cwd();
const SITE = 'https://vitalcheck.drdevir.com/';

function makeServer() {
  const S = {
    files: {},            // id -> { name, text, rev (dropbox) / version (drive), provider }
    seq: 1,
    tokenValid: true,     // dropbox access token accepted
    refreshValid: true,   // dropbox refresh token accepted
    offline: false,       // every API call fails at network level
    calls: [],            // log of [provider, op]
    uploads: 0,
    gdToken: 'gd-token-1',
    gdTokenValid: true,
  };
  S.addFile = (provider, name, text) => {
    const id = provider === 'dropbox' ? 'id:F' + (S.seq++) : 'g' + (S.seq++);
    S.files[id] = { name, text, rev: 'r' + (S.seq++), version: 1, provider };
    return id;
  };
  S.externalEdit = (id, text) => { const f = S.files[id]; f.text = text; f.rev = 'r' + (S.seq++); f.version++; };
  return S;
}

async function install(context, S) {
  // the site itself, from disk
  await context.route(SITE + '**', route => {
    const u = new URL(route.request().url());
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(f)] || 'application/octet-stream';
    return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: type });
  });

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Expose-Headers': 'Dropbox-API-Result' };
  const json = (route, status, obj, extra) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(obj) });

  // Dropbox sign-in page: approve at once and go back to the site
  await context.route('https://www.dropbox.com/oauth2/authorize**', route => {
    const u = new URL(route.request().url());
    S.calls.push(['dropbox', 'authorize', u.searchParams.get('code_challenge_method'), u.searchParams.get('redirect_uri')]);
    const back = SITE + '?code=CODE123&state=' + u.searchParams.get('state');
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>Dropbox sign-in (simulated)<script>location.replace(${JSON.stringify(back)})</script></body></html>` });
  });

  await context.route('https://api.dropboxapi.com/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    if (S.offline) return route.abort('internetdisconnected');
    const u = new URL(req.url());
    const auth = req.headers()['authorization'] || '';
    if (u.pathname === '/oauth2/token') {
      const p = new URLSearchParams(req.postData());
      S.calls.push(['dropbox', 'token', p.get('grant_type')]);
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'CODE123' || !p.get('code_verifier')) return json(route, 400, { error: 'invalid_grant' });
        return json(route, 200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 14400 });
      }
      if (!S.refreshValid) return json(route, 400, { error: 'invalid_grant' });
      S.tokenValid = true;
      return json(route, 200, { access_token: 'AT2', expires_in: 14400 });
    }
    if (u.pathname === '/2/auth/token/revoke') { S.calls.push(['dropbox', 'revoke']); return json(route, 200, null); }
    if (!S.tokenValid) return json(route, 401, { error_summary: 'expired_access_token/' });
    const body = JSON.parse(req.postData() || '{}');
    if (u.pathname === '/2/files/list_folder') {
      S.calls.push(['dropbox', 'list']);
      const entries = Object.entries(S.files).filter(([, f]) => f.provider === 'dropbox')
        .map(([id, f]) => ({ '.tag': 'file', id, name: f.name, server_modified: '2026-11-26T10:00:00Z', rev: f.rev }));
      return json(route, 200, { entries, has_more: false, cursor: 'c' });
    }
    if (u.pathname === '/2/files/get_metadata') {
      S.calls.push(['dropbox', 'meta']);
      const f = S.files[body.path];
      if (!f) return json(route, 409, { error_summary: 'path/not_found/' });
      return json(route, 200, { id: body.path, name: f.name, rev: f.rev });
    }
    return json(route, 400, { error_summary: 'unknown' });
  });

  await context.route('https://content.dropboxapi.com/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    if (S.offline) return route.abort('internetdisconnected');
    if (!S.tokenValid) return json(route, 401, { error_summary: 'expired_access_token/' });
    const u = new URL(req.url());
    const argRaw = req.headers()['dropbox-api-arg'];
    if (/[^\x00-\x7f]/.test(argRaw)) return json(route, 400, { error_summary: 'non-ascii header' });
    const arg = JSON.parse(argRaw);
    if (u.pathname === '/2/files/download') {
      S.calls.push(['dropbox', 'download']);
      const f = S.files[arg.path];
      if (!f) return json(route, 409, { error_summary: 'path/not_found/' });
      return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Result': JSON.stringify({ id: arg.path, name: f.name, rev: f.rev }).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) }, body: f.text });
    }
    if (u.pathname === '/2/files/upload') {
      const text = req.postData() || '';
      if (S.delay) await new Promise(r => setTimeout(r, S.delay));
      // injected failures: { kind: '500' | '429' | 'space' | 'lost', count }
      if (S.failNext && S.failNext.count > 0 && arg.mode !== 'add') {
        S.failNext.count--;
        const k = S.failNext.kind;
        S.calls.push(['dropbox', 'fail-' + k]);
        if (k === '500') return json(route, 500, { error_summary: 'internal' });
        if (k === '429') return json(route, 429, { error_summary: 'too_many_requests/' });
        if (k === 'space') return json(route, 409, { error_summary: 'path/insufficient_space/' });
        if (k === 'lost') {   // the write happens, but the answer never arrives
          const f = S.files[arg.path];
          if (f && (arg.mode['.tag'] !== 'update' || arg.mode.update === f.rev)) { f.text = text; f.rev = 'r' + (S.seq++); S.uploads++; }
          return route.abort('connectionreset');
        }
      }
      if (arg.mode === 'add') {
        const id = S.addFile('dropbox', arg.path.replace(/^\//, ''), text);
        S.calls.push(['dropbox', 'create', S.files[id].name]);
        return json(route, 200, { id, name: S.files[id].name, rev: S.files[id].rev });
      }
      const f = S.files[arg.path];
      // like real Dropbox: updating a deleted file answers "conflict" (reading it then says not_found)
      if (!f) return json(route, 409, { error_summary: 'path/conflict/file/' });
      if (arg.mode['.tag'] === 'update' && arg.mode.update !== f.rev) { S.calls.push(['dropbox', 'conflict']); return json(route, 409, { error_summary: 'path/conflict/file/' }); }
      f.text = text; f.rev = 'r' + (S.seq++); S.uploads++;
      S.calls.push(['dropbox', 'upload']);
      return json(route, 200, { id: arg.path, name: f.name, rev: f.rev });
    }
    return json(route, 400, {});
  });

  // Google sign-in script: a fake token client that approves at once
  await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: `
      window.google = window.google || {};
      google.accounts = { oauth2: {
        initTokenClient(cfg) { return { requestAccessToken(o) { window.__gdRequests = (window.__gdRequests||0)+1;
          setTimeout(() => window.__gdDeny ? cfg.error_callback({type:'popup_closed'}) : cfg.callback({ access_token: window.__gdNextToken || 'gd-token-1', expires_in: 3600 }), 10); } }; },
        revoke(t, cb) { window.__gdRevoked = t; cb && cb(); } } };` }));

  await context.route('https://www.googleapis.com/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    if (S.offline) return route.abort('internetdisconnected');
    const auth = req.headers()['authorization'] || '';
    if (!S.gdTokenValid || !auth.startsWith('Bearer gd-token')) return json(route, 401, { error: { code: 401 } });
    const u = new URL(req.url());
    let m;
    if (u.pathname === '/drive/v3/files' && req.method() === 'GET') {
      S.calls.push(['gdrive', 'list']);
      return json(route, 200, { files: Object.entries(S.files).filter(([, f]) => f.provider === 'gdrive').map(([id, f]) => ({ id, name: f.name, modifiedTime: '2026-11-26T10:00:00Z' })) });
    }
    if ((m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)) && req.method() === 'GET') {
      const f = S.files[decodeURIComponent(m[1])];
      if (!f) return json(route, 404, { error: { code: 404 } });
      if (u.searchParams.get('alt') === 'media') { S.calls.push(['gdrive', 'download']); return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: f.text }); }
      S.calls.push(['gdrive', 'meta']);
      return json(route, 200, { id: m[1], name: f.name, version: String(f.version), trashed: false });
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
      const raw = req.postData();
      const parts = raw.split(/--vc[A-Za-z0-9]+/);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const text = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const id = S.addFile('gdrive', meta.name, text);
      S.calls.push(['gdrive', 'create', meta.name]);
      return json(route, 200, { id, name: meta.name, version: String(S.files[id].version) });
    }
    if ((m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && req.method() === 'PATCH') {
      const f = S.files[decodeURIComponent(m[1])];
      if (!f) return json(route, 404, {});
      f.text = req.postData(); f.version++; S.uploads++;
      S.calls.push(['gdrive', 'upload']);
      const answered = f.version;
      f.version++;   // like real Drive: the version number also moves on by itself, without a content change
      return json(route, 200, { version: String(answered) });
    }
    return json(route, 400, {});
  });
}

module.exports = { makeServer, install, SITE };
