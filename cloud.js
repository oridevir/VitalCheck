/* VitalCheck — direct cloud storage (Dropbox app folder, Google Drive drive.file).
   The browser talks straight to Dropbox / Google; nothing passes through a server of ours.
   Each provider offers the same small interface, used by index.html:
     isConnected(), connect(), disconnect(),
     list() → [{ id, name, modified }]
     read(id) → { id, name, text, version }
     create(name, text) → { id, name, version }
     write(id, text, version) → { version }          (throws CloudError 'conflict' if the file changed)
     writeOnExit(id, text, version)                    (best effort while the page is closing)
   Errors are CloudError with code: 'auth' | 'conflict' | 'network' | 'notfound' | 'other'.
   Plan: docs/plan-dropbox-direct.md */
(function () {
  const REDIRECT_URI = location.origin + '/';
  const DROPBOX_APP_KEY = '5jehzc3nkdyem5n';
  const GOOGLE_CLIENT_ID = '321012117943-an178c51mdr3krvrq854o8krajf47182.apps.googleusercontent.com';
  const GOOGLE_API_KEY = 'AIzaSyA2cbeoemYHnige-QXptkH--iiPxrQIJvk';   // restricted to this site + Picker/Drive
  const GOOGLE_APP_ID = '321012117943';
  const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  class CloudError extends Error {
    constructor(message, code, extra) { super(message); this.name = 'CloudError'; this.code = code; Object.assign(this, extra || {}); }
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('vc_cloud_' + k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem('vc_cloud_' + k); else localStorage.setItem('vc_cloud_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  const randomString = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join(''); };
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function request(url, opts) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { throw new CloudError('אין חיבור לאינטרנט, או שהשרת לא זמין', 'network'); }
    return res;
  }
  async function errorFrom(res, where) {
    let body = '';
    try { body = await res.text(); } catch (e) {}
    const code = res.status === 401 ? 'auth' : res.status === 404 ? 'notfound' : res.status === 409 && /conflict/.test(body) ? 'conflict'
      : res.status === 409 && /not_found/.test(body) ? 'notfound' : res.status === 429 || res.status >= 500 ? 'network' : 'other';
    return new CloudError(`${where}: ${res.status} ${body.slice(0, 200)}`, code, { status: res.status });
  }

  /* ================= Dropbox (app folder) ================= */
  // Dropbox-API-Arg is an HTTP header: non-ASCII characters (Hebrew names) must be \u-escaped
  const headerJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const dropbox = {
    id: 'dropbox',
    label: 'דרופבוקס',
    isConnected() { return !!(store.get('dbx') || {}).refresh; },

    // Leaves the page to Dropbox's sign-in; finishRedirect() completes it when the page comes back
    async connect() {
      const verifier = randomString(64);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = randomString(16);
      store.set('dbx_pkce', { verifier, state });
      const p = new URLSearchParams({
        client_id: DROPBOX_APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI, token_access_type: 'offline', state
      });
      location.href = 'https://www.dropbox.com/oauth2/authorize?' + p;
      return new Promise(() => {});   // the page is leaving
    },

    // Called on page load. Returns true if a Dropbox sign-in was just completed.
    async finishRedirect() {
      const q = new URLSearchParams(location.search);
      const pk = store.get('dbx_pkce');
      if (!pk || !q.get('state') || q.get('state') !== pk.state) return false;
      store.set('dbx_pkce', null);
      history.replaceState(null, '', location.pathname);
      if (q.get('error')) throw new CloudError('ההתחברות לדרופבוקס בוטלה', 'auth');
      const res = await request('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({ code: q.get('code'), grant_type: 'authorization_code', code_verifier: pk.verifier, client_id: DROPBOX_APP_KEY, redirect_uri: REDIRECT_URI })
      });
      if (!res.ok) throw await errorFrom(res, 'dropbox token');
      const t = await res.json();
      store.set('dbx', { refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in || 14400) * 1000 });
      return true;
    },

    async token(force) {
      const t = store.get('dbx');
      if (!t || !t.refresh) throw new CloudError('לא מחובר לדרופבוקס', 'auth');
      if (!force && t.access && Date.now() < t.exp - 60000) return t.access;
      const res = await request('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: DROPBOX_APP_KEY })
      });
      if (!res.ok) {
        const err = await errorFrom(res, 'dropbox refresh');
        if (res.status === 400 || res.status === 401) { store.set('dbx', null); err.code = 'auth'; }
        throw err;
      }
      const n = await res.json();
      store.set('dbx', { ...t, access: n.access_token, exp: Date.now() + (n.expires_in || 14400) * 1000 });
      return n.access_token;
    },
    cachedToken() { const t = store.get('dbx'); return t && t.access && Date.now() < t.exp - 60000 ? t.access : null; },

    async call(url, headers, body, where) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + await this.token(attempt > 0), ...headers }, body });
        if (res.status === 401 && attempt === 0) continue;   // expired token: refresh once
        if (!res.ok) throw await errorFrom(res, where);
        return res;
      }
    },

    async list() {
      let res = await this.call('https://api.dropboxapi.com/2/files/list_folder', { 'Content-Type': 'application/json' },
        JSON.stringify({ path: '', recursive: false }), 'list');
      let data = await res.json();
      const all = [...data.entries];
      while (data.has_more) {
        res = await this.call('https://api.dropboxapi.com/2/files/list_folder/continue', { 'Content-Type': 'application/json' },
          JSON.stringify({ cursor: data.cursor }), 'list');
        data = await res.json();
        all.push(...data.entries);
      }
      return all.filter(e => e['.tag'] === 'file' && /\.json$/i.test(e.name))
        .map(e => ({ id: e.id, name: e.name, modified: e.server_modified }))
        .sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    },

    async read(id) {
      const res = await this.call('https://content.dropboxapi.com/2/files/download', { 'Dropbox-API-Arg': headerJson({ path: id }) }, null, 'read');
      const meta = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}');
      const text = await res.text();
      return { id: meta.id || id, name: meta.name, text, version: meta.rev, path: meta.path_display };
    },

    // Current version (rev) only — cheap check when coming back to the tab
    async version(id) {
      const res = await this.call('https://api.dropboxapi.com/2/files/get_metadata', { 'Content-Type': 'application/json' },
        JSON.stringify({ path: id }), 'version');
      return (await res.json()).rev;
    },

    async create(name, text) {
      const res = await this.call('https://content.dropboxapi.com/2/files/upload', {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerJson({ path: '/' + name, mode: 'add', autorename: true, mute: true })
      }, text, 'create');
      const meta = await res.json();
      return { id: meta.id, name: meta.name, version: meta.rev };
    },

    // Writes only if the file is still at `version` (rev); otherwise Dropbox answers "conflict"
    async write(id, text, version) {
      const res = await this.call('https://content.dropboxapi.com/2/files/upload', {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerJson({ path: id, mode: { '.tag': 'update', update: version }, autorename: false, mute: true, strict_conflict: true })
      }, text, 'write');
      const meta = await res.json();
      return { version: meta.rev };
    },

    // The page is closing: send what is not saved yet, without waiting for the answer
    writeOnExit(id, text, version) {
      const tok = this.cachedToken();
      if (!tok || new Blob([text]).size > 60000) return false;
      try {
        fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST', keepalive: true,
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': headerJson({ path: id, mode: { '.tag': 'update', update: version }, autorename: false, mute: true, strict_conflict: true }) },
          body: text
        }).catch(() => {});
        return true;
      } catch (e) { return false; }
    },

    async disconnect() {
      const tok = this.cachedToken();
      store.set('dbx', null);
      if (tok) { try { await fetch('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }); } catch (e) {} }
    }
  };

  /* ================= Google Drive (drive.file) =================
     Without a server Google gives a one-hour token and no refresh token. A new token is
     requested inside a click (Google opens and closes its window by itself once access was
     given before); see keepAlive(). */
  const loaded = {};
  const loadScript = src => loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new CloudError('לא הצלחתי לטעון את הרכיב של גוגל', 'network')); };
    document.head.appendChild(s);
  }));

  let tokenClient = null, tokenWaiter = null;
  function initTokenClient() {
    if (tokenClient) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: GOOGLE_SCOPE,
      callback: r => {
        const w = tokenWaiter; tokenWaiter = null;
        if (r && r.access_token) {
          store.set('gd', { connected: true, access: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
          if (w) w.resolve(r.access_token);
        } else if (w) w.reject(new CloudError('גוגל לא אישר את הגישה', 'auth'));
      },
      error_callback: e => { const w = tokenWaiter; tokenWaiter = null; if (w) w.reject(new CloudError('חלון ההתחברות של גוגל נסגר או נחסם', 'auth', { detail: e && e.type })); }
    });
  }

  const gdrive = {
    id: 'gdrive',
    label: 'גוגל דרייב',
    isConnected() { return !!(store.get('gd') || {}).connected; },
    ready() { return !!(window.google && google.accounts && google.accounts.oauth2); },
    preload() { return loadScript('https://accounts.google.com/gsi/client').then(initTokenClient); },

    // Must be called from a click. If Google's script is not loaded yet, rejects with 'notready'
    // (the caller loads it and asks for one more click — browsers block windows opened later).
    connect(prompt = 'consent') {
      if (!this.ready()) return Promise.reject(new CloudError('notready', 'notready'));
      initTokenClient();
      return new Promise((resolve, reject) => {
        tokenWaiter = { resolve, reject };
        tokenClient.requestAccessToken({ prompt });
      });
    },
    cachedToken() { const t = store.get('gd'); return t && t.access && Date.now() < t.exp - 60000 ? t.access : null; },
    expiresSoon() { const t = store.get('gd'); return !t || !t.access || Date.now() > t.exp - 10 * 60000; },
    // Called on every click while working with Drive: renew the token before it expires
    keepAlive() {
      if (!this.isConnected() || !this.ready() || !this.expiresSoon() || tokenWaiter) return;
      this.connect('').catch(() => {});
    },
    async token() {
      const t = this.cachedToken();
      if (t) return t;
      throw new CloudError('צריך לאשר מחדש את החיבור לגוגל דרייב', 'auth', { reauth: true });
    },

    async call(url, opts, where) {
      const res = await request(url, { ...opts, headers: { Authorization: 'Bearer ' + await this.token(), ...(opts.headers || {}) } });
      if (res.status === 401) { const g = store.get('gd'); if (g) store.set('gd', { ...g, access: null }); throw new CloudError('צריך לאשר מחדש את החיבור לגוגל דרייב', 'auth', { reauth: true }); }
      if (!res.ok) throw await errorFrom(res, where);
      return res;
    },
    async meta(id) {
      const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,version,trashed`, {}, 'meta');
      return res.json();
    },

    async list() {
      const q = encodeURIComponent("trashed=false and (mimeType='application/json' or name contains '.json')");
      const res = await this.call(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=100&spaces=drive`, {}, 'list');
      const data = await res.json();
      return (data.files || []).map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime }));
    },

    // Google's own file window: choosing a file there gives this site access to that file only
    async pick() {
      await this.token();
      await loadScript('https://apis.google.com/js/api.js');
      await new Promise(res => gapi.load('picker', res));
      return new Promise(resolve => {
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes('application/json,text/plain,application/octet-stream').setMode(google.picker.DocsViewMode.LIST);
        new google.picker.PickerBuilder()
          .addView(view).setOAuthToken(this.cachedToken()).setDeveloperKey(GOOGLE_API_KEY).setAppId(GOOGLE_APP_ID)
          .setLocale('iw').setTitle('בחר את קובץ התיק')
          .setCallback(d => {
            if (d.action === google.picker.Action.PICKED) resolve({ id: d.docs[0].id, name: d.docs[0].name });
            else if (d.action === google.picker.Action.CANCEL) resolve(null);
          })
          .build().setVisible(true);
      });
    },

    async read(id) {
      const m = await this.meta(id);
      if (m.trashed) throw new CloudError('הקובץ נמצא בפח של גוגל דרייב', 'notfound');
      const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {}, 'read');
      return { id: m.id, name: m.name, text: await res.text(), version: String(m.version) };
    },

    async create(name, text) {
      const boundary = 'vc' + randomString(12);
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, mimeType: 'application/json' }) +
        `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
      const res = await this.call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,version', {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body
      }, 'create');
      const f = await res.json();
      return { id: f.id, name: f.name, version: String(f.version) };
    },

    async version(id) { return String((await this.meta(id)).version); },

    // Drive does not check versions itself: check right before writing
    async write(id, text, version) {
      const m = await this.meta(id);
      if (m.trashed) throw new CloudError('הקובץ נמצא בפח של גוגל דרייב', 'notfound');
      if (version != null && String(m.version) !== String(version)) throw new CloudError('הקובץ השתנה', 'conflict');
      const res = await this.call(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=version`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: text
      }, 'write');
      return { version: String((await res.json()).version) };
    },

    // Drive cannot write "only if unchanged" in one request, so nothing is sent blindly while
    // the page closes; the changes stay on the device and are sent the next time the kit opens.
    writeOnExit() { return false; },

    async disconnect() {
      const tok = this.cachedToken();
      store.set('gd', null);
      if (tok && this.ready()) { try { google.accounts.oauth2.revoke(tok, () => {}); } catch (e) {} }
    }
  };

  window.VCCloud = { providers: { dropbox, gdrive }, CloudError, store };
})();
