/* BOARD for iPhone.
   The same boards as the Mac app, read and written straight from the BOARD folder in Dropbox.
   Nothing passes through any other server: this page is static, and it talks to Dropbox only.

   How it keeps in step with the Mac:
   - first open: every board comes down in one zip (they're small); pictures come later, one at a time, as thumbnails
   - after that: Dropbox's change feed says which boards changed; only those come down
   - a change made here goes up as the whole board file, tied to the version it was made on;
     if the Mac changed the same board meanwhile, the two are merged card by card (merge3, same rule as the Mac)
   - anything made while offline waits on the phone and goes up when the connection is back */
(() => {
  'use strict';

  // ------------------------------------------------------------------ settings
  const APP_KEY = '44iohoedl3b6t4h';
  const ROOT = '/BOARD';
  const VERSION = 'phone-0.1';
  // tests run against a pretend Dropbox on this computer; that switch only works on a local address
  const mockBase = (() => { const m = /[?&]mock=([^&]+)/.exec(location.search); return m && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? decodeURIComponent(m[1]) : ''; })();
  const HOST = mockBase ? { api: mockBase, content: mockBase, notify: mockBase, www: mockBase } : { api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com', notify: 'https://notify.dropboxapi.com', www: 'https://www.dropbox.com' };
  const REDIRECT = location.origin + location.pathname + (mockBase ? '?mock=' + encodeURIComponent(mockBase) : '');

  // ------------------------------------------------------------------ small helpers
  const $ = (s, r) => (r || document).querySelector(s);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = (p) => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* fine */ } } };
  const toastEl = $('#toast'); let toastT = 0;
  function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 2600); }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const isAsset = (s) => typeof s === 'string' && /^\/?assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(s);
  const assetPath = (s) => ROOT + '/' + s.replace(/^\//, '');
  const ytThumb = (vid) => 'https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/hqdefault.jpg';

  // ------------------------------------------------------------------ the phone's own copy (IndexedDB)
  const DB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('board-phone', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['boards', 'meta', 'blobs', 'outbox']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (storeName, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(storeName, mode); const s = t.objectStore(storeName); let out; Promise.resolve(fn(s)).then((v) => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      get: (s, k) => tx(s, 'readonly', (st) => req(st.get(k))),
      put: (s, k, v) => tx(s, 'readwrite', (st) => { st.put(v, k); }),
      del: (s, k) => tx(s, 'readwrite', (st) => { st.delete(k); }),
      all: (s) => tx(s, 'readonly', async (st) => { const keys = await req(st.getAllKeys()); const vals = await req(st.getAll()); const o = {}; keys.forEach((k, i) => { o[k] = vals[i]; }); return o; }),
      putMany: (s, entries) => tx(s, 'readwrite', (st) => { for (const [k, v] of entries) st.put(v, k); }),
      clear: (s) => tx(s, 'readwrite', (st) => { st.clear(); }),
    };
  })();

  // ------------------------------------------------------------------ signing in to Dropbox (no password ever reaches this page)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  async function startSignIn(byCode) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('board.pkce', { verifier, byCode: !!byCode });
    const q = new URLSearchParams({ client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
    if (!byCode) q.set('redirect_uri', REDIRECT);
    const url = HOST.www + '/oauth2/authorize?' + q;
    if (byCode) { window.open(url, '_blank'); showCodeBox(); } else location.href = url;
  }
  async function finishSignIn(code) {
    const p = store.get('board.pkce'); if (!p) throw new Error('Start the sign-in again.');
    const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: p.verifier });
    if (!p.byCode) body.set('redirect_uri', REDIRECT);
    const r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body });
    if (!r.ok) throw new Error('Dropbox did not accept that code. Start the sign-in again.');
    const j = await r.json();
    store.set('board.auth', { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 14400) * 1000 - 60000, account: j.account_id || '' });
    store.del('board.pkce');
  }
  let refreshing = null;
  async function token() {
    const a = store.get('board.auth'); if (!a) throw Object.assign(new Error('signed out'), { signedOut: true });
    if (a.exp > Date.now()) return a.access;
    if (!refreshing) refreshing = (async () => {
      const r = await fetch(HOST.api + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: APP_KEY }) });
      if (r.status === 400 || r.status === 401) { store.del('board.auth'); throw Object.assign(new Error('signed out'), { signedOut: true }); }
      if (!r.ok) throw new Error('offline');
      const j = await r.json(); a.access = j.access_token; a.exp = Date.now() + (j.expires_in || 14400) * 1000 - 60000; store.set('board.auth', a); return a.access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ------------------------------------------------------------------ talking to Dropbox
  // Dropbox wants the file details in a header, and headers must be plain ASCII
  const argHeader = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
  async function call(url, opts, retried) {
    const t = await token();
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers })); } catch (e) { throw Object.assign(new Error('offline'), { offline: true }); }
    if (r.status === 401 && !retried) { const a = store.get('board.auth'); if (a) { a.exp = 0; store.set('board.auth', a); } return call(url, opts, true); }
    if (r.status === 429 || r.status >= 500) { await sleep(1500); if (!retried) return call(url, opts, true); }
    return r;
  }
  async function rpc(path, args) {
    const r = await call(HOST.api + '/2/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((j && j.error_summary) || ('Dropbox said ' + r.status)), { status: r.status, body: j });
    return j;
  }
  async function download(path) {
    const r = await call(HOST.content + '/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path }) } });
    if (!r.ok) throw Object.assign(new Error('download ' + r.status), { status: r.status });
    let meta = {}; try { meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}'); } catch (e) { meta = {}; }
    return { blob: await r.blob(), rev: meta.rev || '' };
  }
  async function upload(path, data, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await call(HOST.content + '/2/files/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode, autorename: false, mute: true, strict_conflict: !!rev }) }, body: data });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) throw Object.assign(new Error('conflict'), { conflict: true, body: j });
    if (!r.ok) throw Object.assign(new Error('upload ' + r.status), { status: r.status });
    return j;
  }

  // ------------------------------------------------------------------ the boards
  const S = { boards: {}, revs: {}, bases: {}, dirty: new Set(), cur: 'home', stack: [], ready: false, cursor: null, view: store.get('board.views') || {}, unseen: new Set(store.get('board.unseen') || []) };
  const B = () => S.boards[S.cur];
  const titleOf = (b) => (!b ? 'Missing' : b.id === 'home' ? 'Home' : b.title || 'Untitled');
  const inCol = (c, b) => !!(c && c.col && b.cards[c.col] && b.cards[c.col].type === 'column');
  const isTray = (c) => !!c && c.type === 'column' && c.tray === true;
  const colKids = (b, colId) => Object.values(b.cards).filter((c) => c.col === colId).sort((a, z) => (a.ord || 0) - (z.ord || 0));
  const trayOf = (b) => Object.values(b.cards).find(isTray) || null;
  const boardCount = (b) => Object.values(b.cards).filter((c) => !isTray(c)).length;
  function ensureTray(b) { let t = trayOf(b); if (!t) { t = { id: uid('c'), type: 'column', tray: true, title: 'Unsorted', x: 0, y: 0, w: 304, z: 0, m: Date.now() }; b.cards[t.id] = t; } return t; }

  // ---- merging: the same rule the Mac uses (merge3 in app/server.py)
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x));
  const same = (a, b) => canon(a === undefined ? null : a) === canon(b === undefined ? null : b);
  function pick(b, c, d) { if (same(c, b)) return d; if (same(d, b)) return c; if (c == null) return d; if (d == null) return c; if (typeof c === 'object' && typeof d === 'object' && (d.m || 0) > (c.m || 0)) return d; return c; }
  function mergeMap(b, c, d) { b = b || {}; c = c || {}; d = d || {}; const out = {}; for (const k of new Set([...Object.keys(c), ...Object.keys(d), ...Object.keys(b)])) { const v = pick(b[k], c[k], d[k]); if (v != null) out[k] = v; } return out; }
  function merge3(base, mine, disk) { base = base || { cards: {}, lines: {} }; const out = {}; for (const k of new Set([...Object.keys(mine), ...Object.keys(disk), ...Object.keys(base)])) { if (k === 'cards' || k === 'lines' || k === 'cellar') out[k] = mergeMap(base[k], mine[k], disk[k]); else { const v = pick(base[k], mine[k], disk[k]); if (v != null) out[k] = v; } } return out; }

  // ---- loading what the phone already has
  async function loadLocal() {
    const all = await DB.all('boards');
    for (const [id, rec] of Object.entries(all)) { S.boards[id] = rec.board; S.revs[id] = rec.rev || ''; S.bases[id] = rec.base || null; if (rec.dirty) S.dirty.add(id); }
    S.cursor = (await DB.get('meta', 'cursor')) || null;
    return Object.keys(all).length;
  }
  const keep = (id) => DB.put('boards', id, { board: S.boards[id], rev: S.revs[id] || '', base: S.bases[id] || null, dirty: S.dirty.has(id) });

  // ---- first time on this phone: every board in one go
  async function firstSync(progress) {
    progress('Finding your boards…');
    const revs = {}; let res = await rpc('files/list_folder', { path: ROOT + '/boards', limit: 2000 });
    const take = (r) => { for (const e of r.entries) if (e['.tag'] === 'file' && /\.json$/.test(e.name)) revs[e.name.replace(/\.json$/, '')] = e.rev; };
    take(res); while (res.has_more) { res = await rpc('files/list_folder/continue', { cursor: res.cursor }); take(res); }
    progress('Bringing ' + Object.keys(revs).length + ' boards to this phone…');
    const r = await call(HOST.content + '/2/files/download_zip', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ path: ROOT + '/boards' }) } });
    if (!r.ok) throw new Error('Dropbox would not send the boards (' + r.status + ')');
    const files = window.fflate.unzipSync(new Uint8Array(await r.arrayBuffer()));
    const dec = new TextDecoder(); const entries = [];
    for (const [name, bytes] of Object.entries(files)) {
      const m = /([A-Za-z0-9_-]+)\.json$/.exec(name); if (!m || !revs[m[1]]) continue;
      try { const b = JSON.parse(dec.decode(bytes)); if (!b || typeof b.cards !== 'object') continue; b.id = m[1]; S.boards[m[1]] = b; S.revs[m[1]] = revs[m[1]]; S.bases[m[1]] = JSON.parse(JSON.stringify(b)); entries.push([m[1], { board: b, rev: revs[m[1]], base: S.bases[m[1]], dirty: false }]); } catch (e) { /* a broken file: skip it */ }
    }
    await DB.putMany('boards', entries);
    S.cursor = res.cursor; await DB.put('meta', 'cursor', S.cursor);
    return entries.length;
  }

  // ---- after that: only what changed
  let syncing = null;
  function sync() { if (!syncing) syncing = doSync().finally(() => { syncing = null; }); return syncing; }
  async function doSync() {
    if (!store.get('board.auth')) return;
    setStatus('syncing');
    try {
      await pushAll();
      if (S.cursor) await pullChanges();
      await pushAll();
      setStatus(S.dirty.size || outboxCount ? 'waiting' : 'synced');
    } catch (e) {
      if (e.signedOut) { setStatus('signedout'); showSignIn(); return; }
      setStatus(e.offline ? 'offline' : 'error'); if (!e.offline) console.warn(e);
    }
  }
  async function pullChanges() {
    let res; const upd = new Map(), gone = new Set();
    try { res = await rpc('files/list_folder/continue', { cursor: S.cursor }); }
    catch (e) { if (e.status === 409) { await firstSync(() => {}); render(); return; } throw e; } // the change feed was reset: start over
    const take = (r) => { for (const e of r.entries) { const m = /^([A-Za-z0-9_-]+)\.json$/.exec(e.name || ''); if (!m || !/\/boards\//i.test(e.path_lower || '')) continue; if (e['.tag'] === 'deleted') { gone.add(m[1]); upd.delete(m[1]); } else if (e['.tag'] === 'file') { upd.set(m[1], e.rev); gone.delete(m[1]); } } };
    take(res); while (res.has_more) { res = await rpc('files/list_folder/continue', { cursor: res.cursor }); take(res); }
    let touchedCur = false;
    for (const [id, rev] of upd) {
      if (S.revs[id] === rev) continue; // our own save coming back
      const { blob, rev: got } = await download(ROOT + '/boards/' + id + '.json');
      let disk; try { disk = JSON.parse(await blob.text()); } catch (e) { continue; }
      disk.id = id;
      if (S.dirty.has(id) && S.boards[id]) { S.boards[id] = merge3(S.bases[id], S.boards[id], disk); S.boards[id].id = id; }
      else S.boards[id] = disk;
      S.revs[id] = got || rev; S.bases[id] = JSON.parse(JSON.stringify(disk));
      if (id !== S.cur) { S.unseen.add(id); } else touchedCur = true;
      await keep(id);
    }
    for (const id of gone) { if (S.dirty.has(id)) continue; delete S.boards[id]; delete S.revs[id]; delete S.bases[id]; S.unseen.delete(id); await DB.del('boards', id); }
    S.cursor = res.cursor; await DB.put('meta', 'cursor', S.cursor);
    store.set('board.unseen', [...S.unseen]);
    if (upd.size || gone.size) { if (!S.boards[S.cur]) goHome(); else if (!editing) render(); else pendingRender = true; if (touchedCur && !editing) toast('Updated from your Mac'); }
  }
  async function pushAll() {
    await flushOutbox();
    for (const id of [...S.dirty]) await pushBoard(id);
  }
  async function pushBoard(id) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const b = S.boards[id]; if (!b) { S.dirty.delete(id); return; }
      if (Object.values(b.cards).some((c) => c._local)) return; // a picture is still waiting to go up
      const text = JSON.stringify(b, (k, v) => (k.charAt(0) === '_' ? undefined : v), 1);
      try {
        const meta = await upload(ROOT + '/boards/' + id + '.json', new Blob([text], { type: 'application/json' }), S.revs[id] || null);
        S.revs[id] = meta.rev; S.bases[id] = JSON.parse(text); S.dirty.delete(id); await keep(id); return;
      } catch (e) {
        if (!e.conflict) throw e;
        const { blob, rev } = await download(ROOT + '/boards/' + id + '.json'); // the Mac changed it meanwhile: merge, then try again
        const disk = JSON.parse(await blob.text()); disk.id = id;
        S.boards[id] = merge3(S.bases[id], b, disk); S.boards[id].id = id; S.revs[id] = rev; S.bases[id] = disk; await keep(id);
        if (id === S.cur && !editing) render();
      }
    }
  }
  // ---- pictures taken on the phone wait here until they're up
  let outboxCount = 0;
  async function flushOutbox() {
    const all = await DB.all('outbox'); outboxCount = Object.keys(all).length;
    for (const [name, item] of Object.entries(all)) {
      try { await upload(ROOT + '/assets/' + name, item.blob, null); }
      catch (e) { if (!(e.conflict)) throw e; } // already there from an earlier try
      await DB.put('blobs', 'w640:' + 'assets/' + name, item.blob);
      await DB.del('outbox', name); outboxCount--;
      for (const [bid, b] of Object.entries(S.boards)) { let hit = false; for (const c of Object.values(b.cards)) if (c._local === name) { delete c._local; hit = true; } if (hit) { S.dirty.add(bid); await keep(bid); } }
    }
  }
  let saveT = 0;
  function changed(id) { id = id || S.cur; const b = S.boards[id]; if (!b) return; S.dirty.add(id); keep(id); setStatus('waiting'); clearTimeout(saveT); saveT = setTimeout(sync, 1200); }
  const stamp = (c) => { c.m = Date.now(); return c; };

  // ---- staying live while the app is open: Dropbox tells us the moment something changes
  let polling = false;
  async function longpoll() {
    if (polling) return; polling = true;
    while (!document.hidden && store.get('board.auth')) {
      if (!S.cursor) { await sleep(3000); continue; }
      try {
        const r = await fetch(HOST.notify + '/2/files/list_folder/longpoll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: S.cursor, timeout: 60 }) });
        const j = await r.json().catch(() => ({}));
        if (j.changes) await sync();
        if (j.backoff) await sleep(j.backoff * 1000);
        if (!r.ok) await sleep(8000);
      } catch (e) { setStatus('offline'); await sleep(8000); }
    }
    polling = false;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) { sync(); longpoll(); } });
  window.addEventListener('online', () => { if (S.ready) sync(); });

  // ------------------------------------------------------------------ pictures: thumbnails from Dropbox, kept on the phone
  const blobUrls = new Map(); let thumbQ = []; let thumbBusy = 0;
  function pic(img, src, size) {
    size = size || 'w640h480';
    if (!src) return;
    if (!isAsset(src)) { img.src = src; return; }
    const key = (size === 'w640h480' ? 'w640:' : size + ':') + src.replace(/^\//, '');
    if (blobUrls.has(key)) { img.src = blobUrls.get(key); return; }
    img.dataset.wait = '1';
    thumbQ.push({ img, src, size, key }); setTimeout(pumpThumbs, 0); // the picture is put on screen just after this
  }
  async function pumpThumbs() {
    while (thumbBusy < 4 && thumbQ.length) {
      const job = thumbQ.shift(); if (!job.img.isConnected) continue;
      thumbBusy++;
      (async () => {
        try {
          if (blobUrls.has(job.key)) { job.img.src = blobUrls.get(job.key); return; }
          let blob = await DB.get('blobs', job.key);
          if (!blob) {
            const ext = (job.src.split('.').pop() || '').toLowerCase();
            const thumbable = /^(jpe?g|png|gif|webp|tiff?|bmp|heic|pdf|mp4|mov|m4v)$/.test(ext);
            const r = thumbable ? await call(HOST.content + '/2/files/get_thumbnail_v2', { method: 'POST', headers: { 'Dropbox-API-Arg': argHeader({ resource: { '.tag': 'path', path: assetPath(job.src) }, format: 'jpeg', size: job.size, mode: 'bestfit' }) } }) : null;
            if (r && r.ok) blob = await r.blob();
            else { const d = await download(assetPath(job.src)); blob = d.blob; }
            await DB.put('blobs', job.key, blob);
          }
          const u = URL.createObjectURL(blob); blobUrls.set(job.key, u); job.img.src = u;
        } catch (e) { job.img.classList.add('broken'); }
        finally { delete job.img.dataset.wait; thumbBusy--; pumpThumbs(); }
      })();
    }
  }
  async function tempLink(src) { const j = await rpc('files/get_temporary_link', { path: assetPath(src) }); return j.link; }

  // ------------------------------------------------------------------ note text: keep it to simple formatting (same list as the Mac)
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'SPAN', 'A']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'TEMPLATE', 'META', 'LINK']);
  function cleanNode(node) {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 1) {
        if (DROP.has(ch.tagName)) { ch.remove(); continue; }
        cleanNode(ch);
        if (!ALLOWED.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
        for (const a of [...ch.attributes]) if (!(ch.tagName === 'A' && a.name === 'href' && /^https?:/i.test(a.value))) ch.removeAttribute(a.name);
        if (ch.tagName === 'A') { ch.setAttribute('target', '_blank'); ch.setAttribute('rel', 'noopener noreferrer'); }
      } else if (ch.nodeType !== 3) ch.remove();
    }
  }
  const sanitize = (html) => { const t = document.createElement('template'); t.innerHTML = html || ''; cleanNode(t.content); return t.innerHTML; };
  const textOf = (html) => { const t = document.createElement('template'); t.innerHTML = html || ''; return (t.content.textContent || '').trim(); };

  // ------------------------------------------------------------------ drawing a card (the same card shapes as the Mac, sized for a phone)
  const INKS = { ink: '#1b1f25', red: '#e5484d', blue: '#3b82f6', green: '#30a46c', yellow: '#f5b400' };
  function cardEl(c, b, where) {
    const el = h('div', 'card t-' + (c.type || 'note')); el.dataset.id = c.id;
    const add = (...x) => el.append(...x);
    if (c.type === 'note') { const body = h('div', 'nbody'); body.innerHTML = sanitize(c.html); if (!textOf(c.html)) body.classList.add('empty'); add(body); }
    else if (c.type === 'image') {
      const fr = h('div', 'media'); fr.style.aspectRatio = String(clamp(c.ar || 1.5, 0.2, 5)); const img = h('img'); img.alt = ''; img.loading = 'lazy';
      if (c._local) localPic(img, c._local); else pic(img, c.src); fr.append(img); add(fr);
      if (c.caption) add(h('div', 'cap', c.caption));
    } else if (c.type === 'video') {
      const fr = h('div', 'media vid'); fr.style.aspectRatio = String(clamp(c.ar || 16 / 9, 0.3, 4)); const img = h('img'); img.alt = ''; img.loading = 'lazy';
      const th = c.thumb || (c.provider === 'youtube' ? ytThumb(c.vid) : ''); if (th) pic(img, th); else if (c.provider === 'file' && c.src) pic(img, c.src);
      fr.append(img, h('span', 'play', '▶')); add(fr);
      if (c.title || c.name) add(h('div', 'ltitle', c.title || c.name));
      if (c.summary && c.summary.state === 'done' && c.summary.short) add(h('div', 'vsum', c.summary.short));
    } else if (c.type === 'link') {
      if (c.image) { const fr = h('div', 'media'); fr.style.aspectRatio = String(clamp(c.coverAr || 1.91, 0.4, 3)); const img = h('img'); img.alt = ''; img.loading = 'lazy'; pic(img, c.image); fr.append(img); add(fr); }
      else if (c.file && /\.pdf$/i.test(c.url || '')) { const fr = h('div', 'media doc'); fr.style.aspectRatio = '0.77'; const img = h('img'); img.alt = ''; img.loading = 'lazy'; pic(img, c.url); fr.append(img); add(fr); }
      const body = h('div', 'lbody'); body.append(h('div', 'ltitle', c.title || c.url || 'Link'));
      if (c.desc && where !== 'canvas') body.append(h('div', 'ldesc', c.desc));
      body.append(h('div', 'lsite', c.site || hostOf(c.url || ''))); add(body);
    } else if (c.type === 'board') {
      const sb = S.boards[c.boardId]; el.classList.toggle('shortcut', !!c.shortcut);
      const tile = h('div', 'tile'); const ico = h('div', 'ico'); if (sb && /^#[0-9a-f]{6}$/i.test(sb.color || '')) ico.style.background = sb.color; if (sb && sb.icon) ico.textContent = [...sb.icon].slice(0, 2).join('');
      tile.append(ico); if (unseenAll().has(c.boardId)) tile.append(h('span', 'udot'));
      add(tile, h('div', 'btitle', sb ? sb.title || 'Untitled' : 'Missing board'));
      if (sb) { const n = boardCount(sb); add(h('div', 'bcount', n ? n + (n === 1 ? ' card' : ' cards') : 'Empty')); }
    } else if (c.type === 'todo') {
      if (c.title) add(h('div', 'ttitle', c.title));
      (c.items || []).forEach((it) => { const row = h('label', 'titem' + (it.done ? ' done' : '')); row.dataset.item = it.id; const box = h('span', 'tbox'); row.append(box, h('span', 'ttext', it.text || '')); add(row); });
    } else if (c.type === 'column') {
      add(h('div', 'ctitle', c.title || 'Untitled column'));
      const body = h('div', 'cbody'); for (const k of colKids(b, c.id)) body.append(cardEl(k, b, where)); add(body);
    } else if (c.type === 'table') {
      const tb = h('table', 'tgrid'); (c.rows || []).forEach((row, r) => { const tr = h('tr'); (row || []).forEach((v) => tr.append(h(r === 0 ? 'th' : 'td', '', v))); tb.append(tr); }); const wrap = h('div', 'twrap'); wrap.append(tb); add(wrap);
    } else if (c.type === 'palette') {
      const row = h('div', 'prow'); for (const k of c.colors || []) { const sw = h('div', 'psw'); const col = h('div', 'pcol'); col.style.background = k.hex; sw.append(col, h('div', 'phex', (k.hex || '').toUpperCase())); if (k.name) sw.append(h('div', 'pname', k.name)); row.append(sw); } add(row);
    } else if (c.type === 'draw') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 ' + (c.cw || 480) + ' ' + (c.ch || 320)); svg.setAttribute('class', 'sheet');
      for (const st of c.strokes || []) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', strokePath(st.p)); p.setAttribute('stroke', INKS[st.c] || INKS.ink); p.setAttribute('stroke-width', st.w || 3); svg.append(p); }
      add(svg);
    } else add(h('div', 'nbody', '(' + (c.type || 'card') + ')'));
    return el;
  }
  function strokePath(p) {
    if (!p || p.length < 2) return '';
    if (p.length < 4) return 'M' + p[0] + ' ' + p[1] + 'l0.01 0';
    let d = 'M' + p[0] + ' ' + p[1];
    for (let i = 2; i < p.length - 2; i += 2) d += 'Q' + p[i] + ' ' + p[i + 1] + ' ' + ((p[i] + p[i + 2]) / 2).toFixed(1) + ' ' + ((p[i + 1] + p[i + 3]) / 2).toFixed(1);
    return d + 'L' + p[p.length - 2] + ' ' + p[p.length - 1];
  }
  function localPic(img, name) { DB.get('outbox', name).then((it) => { if (it) img.src = URL.createObjectURL(it.blob); }); }

  // ------------------------------------------------------------------ the red dot: boards changed on the Mac since you last opened them here
  function unseenAll() { const out = new Set(); for (const id of S.unseen) { let cur = id, n = 0; while (cur && S.boards[cur] && !out.has(cur) && n++ < 60) { out.add(cur); cur = S.boards[cur].parent; } } return out; }
  function markSeen(id) { if (S.unseen.delete(id)) store.set('board.unseen', [...S.unseen]); }

  // ------------------------------------------------------------------ the screen
  const screen = $('#screen'), titleEl = $('#title'), backBtn = $('#back'), viewBtn = $('#viewBtn'), statusEl = $('#status');
  let editing = null, pendingRender = false;
  const modeOf = (id) => S.view[id] || (id === 'home' ? 'grid' : 'list');
  function setStatus(s) { statusEl.dataset.s = s; statusEl.title = { syncing: 'Syncing', synced: 'Up to date', waiting: 'Changes waiting to go up', offline: 'Offline: changes are kept on this phone', error: 'Could not sync', signedout: 'Signed out' }[s] || ''; }
  function goHome() { S.stack = []; open('home', true); }
  function open(id, root) {
    if (!S.boards[id]) { toast('That board is not on this phone yet.'); return; }
    if (!root && S.cur !== id) S.stack.push(S.cur);
    S.cur = id; markSeen(id); render(); window.scrollTo(0, 0);
    store.set('board.last', id);
    history.replaceState(null, '', '#' + id);
  }
  function back() { const prev = S.stack.pop(); if (prev && S.boards[prev]) { S.cur = prev; render(); } else if (S.cur !== 'home') { const p = B() && B().parent; S.cur = p && S.boards[p] ? p : 'home'; render(); } history.replaceState(null, '', '#' + S.cur); }
  function render() {
    pendingRender = false;
    const b = B(); if (!b) { goHome(); return; }
    titleEl.textContent = titleOf(b);
    backBtn.hidden = S.cur === 'home';
    const mode = modeOf(S.cur); viewBtn.dataset.mode = mode; viewBtn.textContent = mode === 'board' ? 'List' : 'Board';
    const tray = trayOf(b); const tn = tray ? colKids(b, tray.id).length : 0;
    $('#trayBtn').hidden = !tn; $('#trayBtn').textContent = 'Unsorted · ' + tn;
    screen.textContent = ''; screen.className = 'mode-' + mode;
    if (mode === 'board') renderCanvas(b); else renderList(b, mode === 'grid');
  }
  // ---- list: the board read top to bottom, columns as sections
  function readingOrder(b) {
    const top = Object.values(b.cards).filter((c) => !inCol(c, b) && !isTray(c));
    top.sort((a, z) => (Math.abs((a.y || 0) - (z.y || 0)) < 40 ? (a.x || 0) - (z.x || 0) : (a.y || 0) - (z.y || 0)));
    return top;
  }
  function renderList(b, grid) {
    const list = h('div', grid ? 'grid' : 'list');
    const top = readingOrder(b);
    if (grid) { // Home: notebooks first, as tiles; everything else after
      const nbs = top.filter((c) => c.type === 'board'), rest = top.filter((c) => c.type !== 'board');
      const tiles = h('div', 'tiles'); for (const c of nbs) tiles.append(cardEl(c, b, 'list')); list.append(tiles);
      if (rest.length) { const more = h('div', 'list'); for (const c of rest) more.append(cardEl(c, b, 'list')); list.append(more); }
    } else for (const c of top) list.append(cardEl(c, b, 'list'));
    if (!top.length) list.append(h('div', 'empty', 'Nothing on this board yet. Tap + to add something.'));
    screen.append(list);
  }
  // ---- board: the real layout, pinch to zoom, drag to look around
  let cam = null;
  function renderCanvas(b) {
    const stage = h('div', 'stage'), world = h('div', 'world'); stage.append(world);
    const top = Object.values(b.cards).filter((c) => !inCol(c, b) && !isTray(c));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of top) {
      const el = cardEl(c, b, 'canvas'); el.style.left = (c.x || 0) + 'px'; el.style.top = (c.y || 0) + 'px'; el.style.width = (c.type === 'board' ? 128 : c.w || 240) + 'px'; el.style.zIndex = c.z || 0;
      world.append(el);
      minX = Math.min(minX, c.x || 0); minY = Math.min(minY, c.y || 0); maxX = Math.max(maxX, (c.x || 0) + (c.w || 240)); maxY = Math.max(maxY, (c.y || 0) + 200);
    }
    screen.append(stage);
    if (!top.length) { stage.append(h('div', 'empty', 'Nothing on this board yet. Tap + to add something.')); return; }
    // lines and pen marks, once the cards have their real sizes
    requestAnimationFrame(() => {
      for (const el of world.children) { const c = b.cards[el.dataset.id]; if (c) { maxY = Math.max(maxY, (c.y || 0) + el.offsetHeight); } }
      drawOverlay(b, world);
      const saved = S.view['cam:' + S.cur];
      const W = stage.clientWidth, H = stage.clientHeight; const pad = 16;
      const z = clamp((W - pad * 2) / Math.max(200, maxX - minX), 0.12, 1.2);
      cam = saved && saved.z ? Object.assign({}, saved) : { z, x: pad - minX * z, y: pad - minY * z };
      applyCam(world);
    });
    gestures(stage, world);
  }
  function applyCam(world) { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; }
  function saveCam() { S.view['cam:' + S.cur] = cam; store.set('board.views', S.view); }
  function gestures(stage, world) {
    const pts = new Map(); let start = null, moved = false;
    stage.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { stage.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, cam: Object.assign({}, cam), t: performance.now(), target: e.target }; moved = false; }
      if (pts.size === 2) { const [a, c] = [...pts.values()]; start = { pinch: true, d: Math.hypot(a.x - c.x, a.y - c.y), mx: (a.x + c.x) / 2, my: (a.y + c.y) / 2, cam: Object.assign({}, cam) }; moved = true; }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !start || !cam) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (start.pinch && pts.size >= 2) {
        const [a, c] = [...pts.values()]; const d = Math.hypot(a.x - c.x, a.y - c.y); const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
        const r = stage.getBoundingClientRect(); const z = clamp(start.cam.z * d / start.d, 0.08, 3);
        const wx = (start.mx - r.left - start.cam.x) / start.cam.z, wy = (start.my - r.top - start.cam.y) / start.cam.z;
        cam = { z, x: mx - r.left - wx * z, y: my - r.top - wy * z }; applyCam(world);
      } else if (!start.pinch) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y; if (!moved && Math.hypot(dx, dy) > 6) moved = true;
        if (moved) { cam = { z: start.cam.z, x: start.cam.x + dx, y: start.cam.y + dy }; applyCam(world); }
      }
    });
    const end = (e) => {
      const wasTap = start && !start.pinch && !moved && performance.now() - start.t < 500; const target = start && start.target;
      pts.delete(e.pointerId);
      if (pts.size === 1 && start && start.pinch) { const [p] = [...pts.values()]; start = { x: p.x, y: p.y, cam: Object.assign({}, cam), t: 0 }; moved = true; return; }
      if (!pts.size) { if (cam) saveCam(); if (wasTap && target) tapAt(target); start = null; }
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); const z = clamp(cam.z * Math.exp(-e.deltaY * 0.004), 0.08, 3); const wx = (e.clientX - r.left - cam.x) / cam.z, wy = (e.clientY - r.top - cam.y) / cam.z; cam = { z, x: e.clientX - r.left - wx * z, y: e.clientY - r.top - wy * z }; applyCam(world); saveCam(); }, { passive: false });
  }
  function drawOverlay(b, world) {
    const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'overlay');
    const rect = (id) => { const el = world.querySelector('.card[data-id="' + CSS.escape(id) + '"]'); if (!el) return null; const c = b.cards[id]; return { x: c.x || 0, y: c.y || 0, w: el.offsetWidth, h: el.offsetHeight }; };
    const endR = (e) => (e && e.card ? rect(e.card) : e ? { x: e.x, y: e.y, w: 0, h: 0 } : null);
    const edge = (r, t) => { const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = t.x - cx, dy = t.y - cy; if (!dx && !dy) return { x: cx, y: cy }; const k = Math.min(Math.abs(dx) > 0.001 ? (r.w / 2 + 7) / Math.abs(dx) : Infinity, Math.abs(dy) > 0.001 ? (r.h / 2 + 7) / Math.abs(dy) : Infinity, 1); return { x: cx + dx * k, y: cy + dy * k }; };
    for (const ln of Object.values(b.lines || {})) {
      const ra = endR(ln.a), rb = endR(ln.b); if (!ra || !rb) continue;
      const p = edge(ra, { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 }), q = edge(rb, { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 });
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy); if (len < 2) continue;
      const k = ln.curve ? { x: (p.x + q.x) / 2 - dy * 0.16, y: (p.y + q.y) / 2 + dx * 0.16 } : null;
      const col = INKS[ln.color] || '#56606d', lw = ln.width || 2;
      const path = document.createElementNS(NS, 'path'); path.setAttribute('d', k ? `M${p.x} ${p.y}Q${k.x} ${k.y} ${q.x} ${q.y}` : `M${p.x} ${p.y}L${q.x} ${q.y}`); path.setAttribute('stroke', col); path.setAttribute('stroke-width', lw); path.setAttribute('fill', 'none'); if (ln.dash) path.setAttribute('stroke-dasharray', lw * 3.5 + ' ' + lw * 2.6); svg.append(path);
      const head = (tip, from) => { const a = Math.atan2(tip.y - from.y, tip.x - from.x), s = 7 + lw * 2.2; const pt = (an) => (tip.x - s * Math.cos(an)) + ',' + (tip.y - s * Math.sin(an)); const pg = document.createElementNS(NS, 'polygon'); pg.setAttribute('points', tip.x + ',' + tip.y + ' ' + pt(a - 0.42) + ' ' + pt(a + 0.42)); pg.setAttribute('fill', col); svg.append(pg); };
      if (ln.arrow !== 'none') head(q, k || p); if (ln.arrow === 'both') head(p, k || q);
    }
    for (const st of b.ink || []) { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', strokePath(st.p)); path.setAttribute('stroke', INKS[st.c] || INKS.ink); path.setAttribute('stroke-width', st.w || 4); path.setAttribute('fill', 'none'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path); }
    world.append(svg);
  }

  // ------------------------------------------------------------------ tapping things
  screen.addEventListener('click', (e) => { if (screen.className === 'mode-board') return; tapAt(e.target); });
  function tapAt(t) {
    const row = t.closest && t.closest('.titem'); const el = t.closest && t.closest('.card'); if (!el) return;
    const b = B(); const c = b.cards[el.dataset.id]; if (!c) return;
    if (row && c.type === 'todo') { const it = (c.items || []).find((x) => x.id === row.dataset.item); if (it) { it.done = !it.done; stamp(c); changed(); row.classList.toggle('done', it.done); } return; }
    if (t.closest('a[href]')) return;
    if (c.type === 'board') { if (S.boards[c.boardId]) open(c.boardId); else toast('That board is not on this phone.'); return; }
    if (c.type === 'note') { editNote(c); return; }
    if (c.type === 'image') { viewPicture(c); return; }
    if (c.type === 'video') { if (c.provider === 'file' && isAsset(c.src)) tempLink(c.src).then((u) => window.open(u, '_blank')).catch(() => toast('Could not open the video.')); else if (c.url) window.open(c.url, '_blank'); return; }
    if (c.type === 'link') { if (isAsset(c.url)) { const w = window.open('', '_blank'); tempLink(c.url).then((u) => { if (w) w.location = u; else location.href = u; }).catch(() => { if (w) w.close(); toast('Could not open the file.'); }); } else if (c.url) window.open(c.url, '_blank'); return; }
    if (c.type === 'todo') { editTodo(c); }
  }
  // long press: what you can do with a card
  let pressT = 0;
  screen.addEventListener('pointerdown', (e) => { const el = e.target.closest('.card'); if (!el) return; const x = e.clientX, y = e.clientY; clearTimeout(pressT); pressT = setTimeout(() => { if (navigator.vibrate) navigator.vibrate(10); cardSheet(el.dataset.id); }, 550); const cancel = (ev) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x, ev.clientY - y) > 8) { clearTimeout(pressT); window.removeEventListener('pointermove', cancel); window.removeEventListener('pointerup', cancel); } }; window.addEventListener('pointermove', cancel); window.addEventListener('pointerup', cancel); });
  screen.addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });

  // ------------------------------------------------------------------ sheets (the panels that slide up)
  const sheet = $('#sheet'), sheetBody = $('#sheetBody'), shade = $('#shade');
  function openSheet(build, opts) { sheetBody.textContent = ''; build(sheetBody); sheet.hidden = false; shade.hidden = false; sheet.classList.toggle('tall', !!(opts && opts.tall)); requestAnimationFrame(() => sheet.classList.add('up')); }
  function closeSheet() { sheet.classList.remove('up'); shade.hidden = true; setTimeout(() => { sheet.hidden = true; sheetBody.textContent = ''; }, 200); if (editing) { const fin = editing; editing = null; fin(); } if (pendingRender) render(); }
  shade.addEventListener('click', closeSheet);
  const btn = (label, cls, fn) => { const b = h('button', 'sbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };

  function editNote(c) {
    openSheet((body) => {
      const ed = h('div', 'editor'); ed.contentEditable = 'true'; ed.innerHTML = sanitize(c.html); body.append(ed);
      const bar = h('div', 'sbar'); bar.append(btn('Done', 'primary', closeSheet)); body.prepend(bar);
      const before = c.html || '';
      editing = () => { const html = sanitize(ed.innerHTML); const b = B(); const cc = b && b.cards[c.id]; if (!cc) return; if (!textOf(html) && !textOf(before) && c._new) { delete b.cards[c.id]; changed(); render(); return; } delete cc._new; if (html !== before) { cc.html = html; stamp(cc); changed(); } render(); };
      setTimeout(() => { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, 60);
    }, { tall: true });
  }
  function editTodo(c) {
    openSheet((body) => {
      const bar = h('div', 'sbar'); bar.append(h('span', 'stitle', c.title || 'To-do'), btn('Done', 'primary', closeSheet)); body.append(bar);
      const list = h('div', 'tlist'); body.append(list);
      const draw = () => { list.textContent = ''; for (const it of c.items || []) { const row = h('label', 'titem' + (it.done ? ' done' : '')); const box = h('span', 'tbox'); box.addEventListener('click', () => { it.done = !it.done; stamp(c); changed(); draw(); }); const inp = h('input', 'tin'); inp.value = it.text || ''; inp.addEventListener('change', () => { it.text = inp.value; stamp(c); changed(); }); row.append(box, inp); list.append(row); } const add = h('input', 'tin new'); add.placeholder = 'Add an item'; add.addEventListener('keydown', (e) => { if (e.key === 'Enter' && add.value.trim()) { (c.items = c.items || []).push({ id: 'i' + Date.now().toString(36), text: add.value.trim(), done: false }); stamp(c); changed(); draw(); list.querySelector('.new').focus(); } }); list.append(add); };
      draw(); editing = () => render();
    }, { tall: true });
  }
  function cardSheet(id) {
    const b = B(); const c = b.cards[id]; if (!c) return;
    openSheet((body) => {
      body.append(h('div', 'stitle', { note: 'Note', image: 'Picture', video: 'Video', link: 'Link', board: 'Notebook', todo: 'To-do', column: 'Column', table: 'Table', palette: 'Palette', draw: 'Drawing' }[c.type] || 'Card'));
      if (c.type === 'note') body.append(btn('Edit', '', () => { closeSheet(); setTimeout(() => editNote(c), 220); }));
      if (c.type === 'link' || c.type === 'video') body.append(btn('Copy the address', '', () => { navigator.clipboard && navigator.clipboard.writeText(c.url || ''); toast('Copied'); closeSheet(); }));
      body.append(btn('Send to the cellar', 'danger', () => { sendToCellar(c.id); closeSheet(); }));
      body.append(btn('Cancel', 'quiet', closeSheet));
    });
  }
  // the cellar, like the Mac: out of the way, never gone
  function sendToCellar(id) {
    const b = B(); const c = b.cards[id]; if (!c) return;
    b.cellar = b.cellar || {}; const now = Date.now();
    const move = (x) => { b.cellar[x.id] = Object.assign(x, { m: now }); delete b.cards[x.id]; };
    if (c.type === 'column') for (const k of colKids(b, c.id)) move(k);
    if (inCol(c, b)) { delete c.col; delete c.ord; }
    c.cellaredAt = now; move(c); changed(); render(); toast('Moved to the cellar. It is still there on the Mac.');
  }
  // a picture big, swiping through the board's pictures
  function viewPicture(c) {
    const b = B(); const pics = []; const walk = (list) => { for (const x of list) { if (x.type === 'image') pics.push(x); if (x.type === 'column') walk(colKids(b, x.id)); } };
    walk(readingOrder(b)); let i = Math.max(0, pics.findIndex((p) => p.id === c.id));
    const v = $('#viewer'); const img = $('#viewerImg'); const cap = $('#viewerCap');
    const show = () => { const p = pics[i]; img.removeAttribute('src'); if (p._local) localPic(img, p._local); else pic(img, p.src, 'w2048h1536'); cap.textContent = (p.caption || '') + (pics.length > 1 ? '  ·  ' + (i + 1) + ' of ' + pics.length : ''); };
    v.hidden = false; show();
    let sx = 0;
    v.onpointerdown = (e) => { sx = e.clientX; };
    v.onpointerup = (e) => { const dx = e.clientX - sx; if (Math.abs(dx) > 50) { i = (i + (dx < 0 ? 1 : -1) + pics.length) % pics.length; show(); } else if (e.target === v || e.target === img) { v.hidden = true; } };
  }

  // ------------------------------------------------------------------ adding things (they land in the board's Unsorted, like a drop on the Mac)
  function addCard(card) {
    const b = B(); const tray = ensureTray(b); const kids = colKids(b, tray.id);
    for (const k of kids) k.ord = (k.ord || 0) + 1; // newest first
    Object.assign(card, { id: uid('c'), col: tray.id, ord: 0, x: 0, y: 0, z: 1, m: Date.now() });
    b.cards[card.id] = card; changed(); render(); return card;
  }
  $('#addBtn').addEventListener('click', () => openSheet((body) => {
    body.append(h('div', 'stitle', 'Add to ' + titleOf(B())));
    const grid = h('div', 'addgrid');
    grid.append(btn('Note', 'big', () => { closeSheet(); setTimeout(() => { const c = addCard({ type: 'note', w: 240, html: '' }); c._new = true; editNote(c); }, 220); }));
    grid.append(btn('Photo', 'big', () => { closeSheet(); $('#photoInput').click(); }));
    grid.append(btn('Link', 'big', () => { closeSheet(); setTimeout(addLink, 220); }));
    grid.append(btn('To-do', 'big', () => { closeSheet(); setTimeout(() => { const c = addCard({ type: 'todo', w: 260, title: '', items: [] }); editTodo(c); }, 220); }));
    body.append(grid, btn('Cancel', 'quiet', closeSheet));
  }));
  function addLink() {
    openSheet((body) => {
      body.append(h('div', 'stitle', 'Paste a link'));
      const inp = h('input', 'urlin'); inp.type = 'url'; inp.placeholder = 'https://'; inp.autocapitalize = 'off'; body.append(inp);
      body.append(btn('Add', 'primary', () => {
        let u = inp.value.trim(); if (!u) return; if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        let ok = false; try { ok = !!new URL(u).hostname.includes('.'); } catch (e) { ok = false; } if (!ok) { toast('That does not look like a web address.'); return; }
        const v = parseVideo(u);
        // "pending": the Mac fills in the title and picture next time it's open
        addCard(v ? Object.assign({ type: 'video', url: u, w: 420, title: '', pending: true }, v) : { type: 'link', url: u, w: 280, title: '', site: hostOf(u), pending: true });
        closeSheet(); toast('Added. The Mac fills in its title and picture.');
      }), btn('Cancel', 'quiet', closeSheet));
      setTimeout(() => inp.focus(), 60);
    });
  }
  function parseVideo(url) {
    let u; try { u = new URL(url); } catch (e) { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') { const id = u.pathname.split('/')[1]; if (id) return { provider: 'youtube', vid: id, ar: 16 / 9 }; }
    if (host === 'youtube.com') { if (u.searchParams.get('v')) return { provider: 'youtube', vid: u.searchParams.get('v'), ar: 16 / 9 }; const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/); if (m) return { provider: 'youtube', vid: m[2], ar: m[1] === 'shorts' ? 9 / 16 : 16 / 9 }; }
    if (host === 'vimeo.com') { const m = u.pathname.match(/(\d{5,})/); if (m) return { provider: 'vimeo', vid: m[1], ar: 16 / 9 }; }
    return null;
  }
  // photos: shrunk to a sensible size on the phone, kept here until they're up, then sent to the BOARD folder
  $('#photoInput').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
    for (const f of files) {
      try {
        const { blob, w, hh } = await shrink(f);
        const name = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg';
        await DB.put('outbox', name, { blob, at: Date.now() }); outboxCount++;
        addCard({ type: 'image', src: 'assets/' + name, ar: +(w / hh).toFixed(4), w: 320, caption: '', _local: name });
      } catch (err) { toast('Could not read that photo.'); }
    }
    sync();
  });
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, 2560 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), hh = Math.round(img.naturalHeight * k);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = hh; cv.getContext('2d').drawImage(img, 0, 0, w, hh);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.86));
      return { blob, w, hh };
    } finally { URL.revokeObjectURL(url); }
  }

  // ------------------------------------------------------------------ top bar
  backBtn.addEventListener('click', back);
  viewBtn.addEventListener('click', () => { const m = modeOf(S.cur); S.view[S.cur] = m === 'board' ? (S.cur === 'home' ? 'grid' : 'list') : 'board'; store.set('board.views', S.view); render(); });
  $('#trayBtn').addEventListener('click', () => { const b = B(); const t = trayOf(b); if (!t) return; openSheet((body) => { body.append(h('div', 'stitle', 'Unsorted')); const list = h('div', 'list'); for (const k of colKids(b, t.id)) list.append(cardEl(k, b, 'list')); list.addEventListener('click', (e) => { const el = e.target.closest('.card'); if (el) { closeSheet(); setTimeout(() => tapAt(e.target), 220); } }); body.append(list); }, { tall: true }); });
  $('#menuBtn').addEventListener('click', () => openSheet((body) => {
    const a = store.get('board.auth');
    body.append(h('div', 'stitle', 'BOARD'));
    body.append(h('div', 'snote', a ? 'Signed in to Dropbox. ' + Object.keys(S.boards).length + ' boards on this phone.' : 'Not signed in.'));
    body.append(btn('Sync now', '', () => { closeSheet(); sync(); }));
    body.append(btn('Search', '', () => { closeSheet(); setTimeout(searchSheet, 220); }));
    if (a) body.append(btn('Sign out of Dropbox', 'danger', async () => { store.del('board.auth'); await DB.clear('boards'); await DB.clear('blobs'); await DB.del('meta', 'cursor'); location.reload(); }));
    body.append(h('div', 'snote small', VERSION), btn('Close', 'quiet', closeSheet));
  }));
  function searchSheet() {
    openSheet((body) => {
      const inp = h('input', 'urlin'); inp.type = 'search'; inp.placeholder = 'Search every board'; body.append(inp);
      const out = h('div', 'results'); body.append(out);
      const run = () => {
        const q = inp.value.trim().toLowerCase(); out.textContent = ''; if (q.length < 2) return; let n = 0;
        for (const b of Object.values(S.boards)) {
          if (n > 60) break;
          if (titleOf(b).toLowerCase().includes(q)) { out.append(result(b.id, '▦ ' + titleOf(b), '')); n++; }
          for (const c of Object.values(b.cards)) {
            const t = (c.type === 'note' ? textOf(c.html) : [c.title, c.caption, c.desc, c.url, ...(c.items || []).map((i) => i.text)].filter(Boolean).join(' '));
            const at = t.toLowerCase().indexOf(q); if (at < 0) continue;
            out.append(result(b.id, t.slice(Math.max(0, at - 30), at + 70), titleOf(b))); if (++n > 60) break;
          }
        }
        if (!n) out.append(h('div', 'snote', 'Nothing found.'));
      };
      const result = (bid, text, where) => { const r = h('button', 'result'); r.type = 'button'; r.append(h('div', 'rt', text), h('div', 'rw', where)); r.addEventListener('click', () => { closeSheet(); setTimeout(() => open(bid), 220); }); return r; };
      inp.addEventListener('input', run); setTimeout(() => inp.focus(), 60);
    }, { tall: true });
  }

  // ------------------------------------------------------------------ signing in screens
  const gate = $('#gate');
  function showSignIn() {
    gate.hidden = false; gate.textContent = '';
    gate.append(h('div', 'gtitle', 'BOARD'), h('div', 'gnote', 'Your boards from the Mac, on your phone. Sign in to the Dropbox that holds your BOARD folder.'));
    const go = btn('Sign in with Dropbox', 'primary big', () => startSignIn(standalone()));
    gate.append(go);
    if (!standalone()) gate.append(h('div', 'gnote small', 'Tip: once you are in, use Share → Add to Home Screen to keep BOARD as an app.'));
  }
  function showCodeBox() {
    gate.hidden = false; gate.textContent = '';
    gate.append(h('div', 'gtitle', 'Almost there'), h('div', 'gnote', 'Dropbox opened in a new window. Tap Allow, copy the code it shows, then come back here and paste it.'));
    const inp = h('input', 'urlin'); inp.placeholder = 'Paste the code'; inp.autocapitalize = 'off'; inp.autocomplete = 'off';
    const ok = btn('Continue', 'primary big', async () => { try { await finishSignIn(inp.value); gate.hidden = true; boot(); } catch (e) { toast(e.message); } });
    gate.append(inp, ok, btn('Start again', 'quiet', () => startSignIn(true)));
  }
  function showLoading(msg) { gate.hidden = false; gate.textContent = ''; gate.append(h('div', 'gtitle', 'BOARD'), h('div', 'spinner'), h('div', 'gnote', msg)); }

  // ------------------------------------------------------------------ start
  async function boot() {
    const q = new URLSearchParams(location.search);
    if (q.get('code')) { try { await finishSignIn(q.get('code')); } catch (e) { toast(e.message); } history.replaceState(null, '', REDIRECT); }
    if (q.get('error')) { history.replaceState(null, '', location.pathname); }
    if (!store.get('board.auth')) { showSignIn(); return; }
    const have = await loadLocal();
    try {
      if (!have || !S.cursor) { showLoading('Getting ready…'); await firstSync(showLoading.bind(null)); }
    } catch (e) { if (e.signedOut) { showSignIn(); return; } showLoading(e.offline ? 'No connection. Your boards come down the first time you are online.' : 'Something went wrong: ' + e.message); return; }
    gate.hidden = true; S.ready = true;
    const want = (location.hash || '').slice(1) || store.get('board.last');
    S.cur = want && S.boards[want] ? want : 'home'; if (!S.boards[S.cur]) S.cur = Object.keys(S.boards)[0];
    render(); sync().then(() => longpoll());
  }
  window.BOARDPHONE = { S, sync, render, merge3, open, back, DB };
  if ('serviceWorker' in navigator && !mockBase && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* works without it, just not offline */ });
  boot();
})();
