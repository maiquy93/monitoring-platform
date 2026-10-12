'use strict';
// Core: state, API, shell, realtime, routing, helpers. Views register themselves on M.views.
const M = window.M = {
  S: { user: null, settings: null, snap: null, groups: [], maps: [], sound: localStorage.getItem('sound') === '1', tv: false, rotate: false, dual: localStorage.getItem('dual_screen') === '1', lastSnapAt: 0 },
  views: {},
};
let dualChannel = null;
try {
  dualChannel = new window.BroadcastChannel('monitoring_sync');
  dualChannel.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.type === 'theme' && e.data.theme) M.applyTheme(e.data.theme, false);
    else if (e.data.type === 'dual' && typeof e.data.dual === 'boolean') M.toggleDual(e.data.dual, false);
  };
} catch {}
const $ = (s, el = document) => el.querySelector(s);
M.$ = $;

M.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esc = M.esc;

M.ICON = { server: '🖥️', vm: '☁️', router: '🌐', switch: '🔀', firewall: '🛡️', ap: '📶', printer: '🖨️', ups: '🔋', pc: '💻', other: '📦' };
M.TYPE_NAME = { server: 'Máy chủ', vm: 'Máy ảo (VM)', router: 'Router', switch: 'Switch', firewall: 'Firewall', ap: 'Access Point', printer: 'Máy in', ups: 'UPS', pc: 'Máy trạm', other: 'Khác' };
M.SEV_NAME = { critical: 'Nghiêm trọng', high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
M.STATE_NAME = { up: 'Hoạt động', warning: 'Cảnh báo', down: 'Mất kết nối', unknown: 'Chưa rõ', maint: 'Bảo trì' };

// ---------- helpers ----------
M.statusClass = (d) => (d.status === 'down' ? `down sev-${d.severity}${d.acked ? ' acked' : ''}` : d.status === 'unknown' ? '' : d.status);
M.fmtDur = (sec) => {
  if (sec == null) return '—';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} ngày ${h} giờ`;
  if (h) return `${h} giờ ${m} phút`;
  return m ? `${m} phút ${sec % 60} giây` : `${sec} giây`;
};
M.fmtBytes = (b) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
M.fmtRate = (b) => {
  if (b == null) return '—';
  if (!Number.isFinite(b) || b <= 0) return '0 B/s';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 0 && b < 10 ? 1 : 0)} ${u[i]}`;
};
M.fmtTime = (ts) => new Date(ts).toLocaleString('vi-VN');
M.pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

M.summarize = (devs) => {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  const s = { total: 0, alive: 0, down: 0, warning: 0, unknown: 0, maintenance: 0, level: 'ok', unacked: 0 };
  let worst = 0;
  for (const d of devs) {
    if (d.status === 'maint') { s.maintenance++; continue; }
    s.total++;
    if (d.status === 'up' || d.status === 'warning') s.alive++;
    if (d.status === 'down') s.down++;
    if (d.status === 'warning') s.warning++;
    if (d.status === 'unknown') s.unknown++;
    if (d.status === 'down' || d.status === 'warning') {
      worst = Math.max(worst, rank[d.status === 'down' ? d.severity : (d.severity === 'low' ? 'low' : 'medium')]);
      if (!d.acked) s.unacked++;
    }
  }
  s.level = ['ok', 'low', 'medium', 'high', 'critical'][worst];
  return s;
};

M.api = async (method, url, body) => {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opt.headers['X-Requested-With'] = 'monitor';
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && M.S.user) { M.S.user = null; M.showLogin(); }
    if (r.status === 403 && /đổi mật khẩu/.test((data && data.error) || '')) M.forcePasswordChange();
    const e = new Error((data && data.error) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
};

M.toast = (msg) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4000);
};

M.applyTheme = (t, broadcast = true) => {
  if (!['dark', 'light', 'neon'].includes(t)) t = 'neon';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  const sel = $('#theme-sel');
  if (sel) sel.value = t;
  if (broadcast && dualChannel) {
    try { dualChannel.postMessage({ type: 'theme', theme: t }); } catch {}
  }
};

// Modal with a form. onSubmit(formEl) may throw an Error to show a message and keep the dialog open.
M.modal = (title, bodyHtml, onSubmit, opts = {}) => {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><form class="modal" autocomplete="off"><h3>${esc(title)}</h3>${bodyHtml}
    <div class="err" id="m-err"></div><div class="actions">
    ${opts.noCancel ? '' : '<button type="button" class="btn" data-close>Hủy</button>'}
    <button class="btn primary" type="submit">${esc(opts.submit || 'Lưu')}</button></div></form></div>`;
  const form = $('form', root);
  const close = () => { root.innerHTML = ''; };
  form.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  if (!opts.noCancel) root.firstElementChild.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await onSubmit(form); close(); } catch (err) { $('#m-err').textContent = err.message; }
  });
  const first = $('input:not([type=checkbox]), select', form);
  if (first) first.focus();
  return { form, close };
};

M.confirm = (msg, onYes) => M.modal('Xác nhận', `<p>${esc(msg)}</p>`, onYes, { submit: 'Đồng ý' });

// ---------- sound ----------
let audioCtx;
M.beep = () => {
  if (!M.S.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    [0, 0.25, 0.5].forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.15);
    });
  } catch { /* audio unavailable */ }
};

// ---------- login / password ----------
M.showLogin = () => {
  M.es && M.es.close();
  document.body.dataset.level = 'ok';
  $('#modal-root').innerHTML = '';
  $('#app').innerHTML = `<div class="login-wrap"><form class="panel login" id="login-form">
    <h1>◉ Monitoring</h1>
    <div class="field"><label>Tên đăng nhập</label><input class="inp" name="username" autocomplete="username" required autofocus></div>
    <div class="field"><label>Mật khẩu</label><input class="inp" type="password" name="password" autocomplete="current-password" required></div>
    <div class="err" id="login-err"></div>
    <button class="btn primary" style="width:100%">Đăng nhập</button></form></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await M.api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      M.S.user = r.user;
      M.boot();
    } catch (err) { $('#login-err').textContent = err.message; }
  });
};

M.forcePasswordChange = () => {
  if ($('#pw-form')) return;
  M.changePassword(true);
};

M.changePassword = (forced) => {
  const { form } = M.modal(forced ? 'Bạn cần đổi mật khẩu trước khi sử dụng' : 'Đổi mật khẩu', `
    <div class="field"><label>Mật khẩu hiện tại</label><input class="inp" type="password" name="current" autocomplete="current-password" required></div>
    <div class="field"><label>Mật khẩu mới (tối thiểu 8 ký tự)</label><input class="inp" type="password" name="password" autocomplete="new-password" minlength="8" required></div>
    <div class="field"><label>Nhập lại mật khẩu mới</label><input class="inp" type="password" name="again" autocomplete="new-password" required></div>`,
  async (f) => {
    const v = Object.fromEntries(new FormData(f));
    if (v.password !== v.again) throw new Error('Mật khẩu nhập lại không khớp');
    await M.api('POST', '/api/auth/password', { current: v.current, password: v.password });
    M.S.user.must_change = false;
    M.toast('Đã đổi mật khẩu');
    if (forced) M.boot();
  }, { noCancel: !!forced, submit: 'Đổi mật khẩu' });
  form.id = 'pw-form';
};

M.logout = async () => {
  try { await M.api('POST', '/api/auth/logout', {}); } catch { /* ignore */ }
  M.S.user = null;
  M.showLogin();
};

M.versionText = () => {
  const v = M.S.settings && M.S.settings.version;
  return v ? `v${v.version} · build ${v.build} · mã ${v.code}` : '';
};

// ---------- shell ----------
const NAV = [['#/', 'Tổng quan'], ['#/groups', 'Nhóm'], ['#/maps', 'Sơ đồ'], ['#/events', 'Sự kiện'], ['#/devices', 'Thiết bị'], ['#/settings', 'Cài đặt', 'admin']];

M.renderShell = () => {
  const u = M.S.user;
  $('#app').innerHTML = `
  <header class="top">
    <div class="brand" id="brand">◉ ${esc(M.S.settings.org_name)}</div>
    <nav class="main">${NAV.filter((n) => !n[2] || n[2] === u.role).map((n) => `<a href="${n[0]}" data-nav="${n[0]}">${n[1]}</a>`).join('')}</nav>
    <span class="chip" id="chip">–/–</span>
    <div class="tools">
      <button class="icon-btn ${M.S.sound ? 'on' : ''}" id="btn-sound" title="Âm thanh cảnh báo">🔔</button>
      <button class="icon-btn" id="btn-rotate" title="Tự động luân phiên màn hình (chế độ TV)">🔁</button>
      <button class="icon-btn ${M.S.dual ? 'on' : ''}" id="btn-dual" title="Chế độ màn hình đôi (Phím D): Chia 2 màn hình hoặc mở cửa sổ phụ">🖥️🖥️</button>
      <button class="icon-btn" id="btn-tv" title="Chế độ màn hình lớn (phím F)">📺</button>
      <select class="sel hide-tv" id="theme-sel" title="Giao diện">
        <option value="neon">Neon</option><option value="dark">Tối</option><option value="light">Sáng</option></select>
      <button class="icon-btn hide-tv" id="btn-user" title="Đổi mật khẩu">👤 ${esc(u.username)}</button>
      <button class="icon-btn hide-tv" id="btn-logout" title="Đăng xuất">⎋</button>
    </div>
  </header>
  <div id="banner"></div>
  <main id="view"></main>
  <footer class="ver muted" id="ver">${esc(M.versionText())}</footer>`;
  $('#theme-sel').value = document.documentElement.dataset.theme;
  $('#theme-sel').addEventListener('change', async (e) => {
    M.applyTheme(e.target.value);
    try { await M.api('PUT', '/api/auth/theme', { theme: e.target.value }); } catch { /* non-critical */ }
  });
  $('#btn-sound').addEventListener('click', (e) => {
    M.S.sound = !M.S.sound;
    localStorage.setItem('sound', M.S.sound ? '1' : '0');
    e.currentTarget.classList.toggle('on', M.S.sound);
    M.beep();
  });
  $('#btn-dual').addEventListener('click', () => M.toggleDual());
  $('#btn-tv').addEventListener('click', () => M.toggleTv());
  $('#btn-rotate').addEventListener('click', (e) => {
    M.S.rotate = !M.S.rotate;
    e.currentTarget.classList.toggle('on', M.S.rotate);
    M.toast(M.S.rotate ? 'Bật tự động luân phiên (dừng ở Tổng quan khi có cảnh báo)' : 'Tắt luân phiên');
    if (M.S.rotate && !M.S.tv) M.toggleTv();
  });
  $('#btn-user').addEventListener('click', () => M.changePassword(false));
  $('#btn-logout').addEventListener('click', M.logout);
};

M.toggleDual = (force, broadcast = true) => {
  M.S.dual = force !== undefined ? force : !M.S.dual;
  document.body.classList.toggle('dual-screen', M.S.dual);
  $('#btn-dual') && $('#btn-dual').classList.toggle('on', M.S.dual);
  localStorage.setItem('dual_screen', M.S.dual ? '1' : '0');
  M.toast(M.S.dual ? 'Bật chế độ màn hình đôi (Phím D)' : 'Tắt chế độ màn hình đôi');
  if (broadcast && dualChannel) {
    try { dualChannel.postMessage({ type: 'dual', dual: M.S.dual }); } catch {}
  }
  if ((location.hash || '#/') === '#/') {
    M.route();
  }
};

M.toggleTv = (force) => {
  M.S.tv = force !== undefined ? force : !M.S.tv;
  document.body.classList.toggle('tv', M.S.tv);
  $('#btn-tv') && $('#btn-tv').classList.toggle('on', M.S.tv);
  if (M.S.tv && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!M.S.tv && document.fullscreenElement) document.exitFullscreen?.();
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && M.S.tv) { M.S.tv = false; document.body.classList.remove('tv'); $('#btn-tv') && $('#btn-tv').classList.remove('on'); }
});
document.addEventListener('keydown', (e) => {
  if (!M.S.user || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'f' || e.key === 'F') M.toggleTv();
  if (e.key === 'd' || e.key === 'D') M.toggleDual();
});

M.updateChrome = () => {
  const snap = M.S.snap;
  if (!snap) return;
  const s = snap.summary;
  document.body.dataset.level = s.level;
  const chip = $('#chip');
  if (chip) chip.textContent = `${s.alive}/${s.total} alive`;
  document.title = `${s.down ? `(${s.down} DOWN) ` : ''}${s.alive}/${s.total} – ${M.S.settings.org_name}`;
  const banner = $('#banner');
  if (!banner) return;
  const bad = snap.devices.filter((d) => d.status === 'down' || d.status === 'warning');
  if (!bad.length) { banner.innerHTML = ''; return; }
  const down = bad.filter((d) => d.status === 'down');
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  bad.sort((a, b) => (b.status === 'down') - (a.status === 'down') || rank[b.severity] - rank[a.severity]);
  const title = down.length ? `⚠ ${down.length} thiết bị mất kết nối` : `⚠ ${bad.length} thiết bị cảnh báo`;
  const extra = down.length && bad.length > down.length ? ` · ${bad.length - down.length} cảnh báo` : '';
  banner.innerHTML = `<div class="banner ${s.unacked ? 'blink' : ''}"><span>${title}${extra}</span>
    <span class="names">${bad.slice(0, 12).map((d) => `<a href="#/device/${d.id}">${M.ICON[d.type] || ''} ${esc(d.name)}</a>`).join(' · ')}${bad.length > 12 ? ' …' : ''}</span>
    ${s.unacked && M.S.user.role !== 'viewer' ? '<button class="btn sm" id="ack-all">Đã biết</button>' : ''}</div>`;
  const ack = $('#ack-all');
  if (ack) ack.onclick = async () => {
    await Promise.all(bad.filter((d) => !d.acked).map((d) => M.api('POST', `/api/devices/${d.id}/ack`, {}).catch(() => {})));
  };
};

M.noServer = () => {
  const banner = $('#banner');
  if (banner && Date.now() - M.S.lastSnapAt > 10000) {
    banner.innerHTML = '<div class="banner blink"><span>⚠ Mất kết nối tới máy chủ giám sát – dữ liệu hiển thị có thể đã cũ</span></div>';
    document.body.dataset.level = 'critical';
  }
};

let prevDown = new Set();
M.onSnapshot = (snap) => {
  M.S.snap = snap;
  M.S.lastSnapAt = Date.now();
  const nowDown = new Set(snap.devices.filter((d) => d.status === 'down').map((d) => d.id));
  const fresh = snap.devices.filter((d) => nowDown.has(d.id) && !prevDown.has(d.id));
  if (prevDown.size || M.S.firstSnapDone) {
    if (fresh.length) { M.toast(`Mất kết nối: ${fresh.map((d) => d.name).join(', ')}`); M.beep(); }
  }
  M.S.firstSnapDone = true;
  prevDown = nowDown;
  M.updateChrome();
  const v = M.current;
  if (v && v.update) v.update(snap);
};

M.connect = () => {
  M.es && M.es.close();
  const es = new EventSource('/api/stream');
  M.es = es;
  es.addEventListener('snapshot', (e) => M.onSnapshot(JSON.parse(e.data)));
  es.onerror = async () => {
    if (es.readyState === EventSource.CLOSED) {
      try { await M.api('GET', '/api/auth/me'); setTimeout(M.connect, 2000); } catch { /* login shown by api() */ }
    }
  };
};

// ---------- router ----------
const ROUTES = [
  [/^#\/?$/, 'dashboard'], [/^#\/secondary$/, 'secondary'], [/^#\/groups$/, 'groups'], [/^#\/group\/(\d+)$/, 'group'], [/^#\/device\/(\d+)$/, 'device'],
  [/^#\/maps$/, 'maps'], [/^#\/map\/(\d+)$/, 'map'], [/^#\/events$/, 'events'], [/^#\/devices$/, 'devices'], [/^#\/settings$/, 'settings'],
];

M.route = async () => {
  if (!M.S.user || M.S.user.must_change) return;
  const hash = location.hash || '#/';
  let name = 'dashboard', args = [];
  for (const [re, n] of ROUTES) { const m = re.exec(hash); if (m) { name = n; args = m.slice(1); break; } }
  const navFor = { dashboard: '#/', groups: '#/groups', group: '#/groups', maps: '#/maps', map: '#/maps', events: '#/events', devices: '#/devices', settings: '#/settings' }[name];
  document.querySelectorAll('nav.main a').forEach((a) => a.classList.toggle('active', a.dataset.nav === navFor));
  if (M.current && M.current.destroy) M.current.destroy();
  const view = M.views[name];
  M.current = view;
  const el = $('#view');
  el.innerHTML = '';
  try { await view.render(el, ...args); } catch (e) { el.innerHTML = `<div class="panel err">${esc(e.message)}</div>`; }
  if (M.S.snap && view.update) view.update(M.S.snap);
};
window.addEventListener('hashchange', M.route);

M.loadGroups = async () => { M.S.groups = (await M.api('GET', '/api/groups')).groups; };
M.loadMaps = async () => { M.S.maps = (await M.api('GET', '/api/maps')).maps; };

setInterval(M.noServer, 3000);
setInterval(async () => {
  if (!M.S.rotate || !M.S.user || M.S.tv === false) return;
  if (M.S.snap && M.S.snap.summary.unacked > 0) { if ((location.hash || '#/') !== '#/') location.hash = '#/'; return; }
  const targets = ['#/', ...M.S.groups.map((g) => `#/group/${g.id}`), ...M.S.maps.map((m) => `#/map/${m.id}`)];
  const i = targets.indexOf(location.hash || '#/');
  location.hash = targets[(i + 1) % targets.length];
}, 20000);

M.boot = async () => {
  try {
    const me = await M.api('GET', '/api/auth/me');
    M.S.user = me.user;
  } catch { return M.showLogin(); }
  if (M.S.user.must_change) { $('#app').innerHTML = ''; return M.forcePasswordChange(); }
  M.S.settings = await M.api('GET', '/api/settings');
  M.applyTheme(M.S.user.theme || localStorage.getItem('theme') || M.S.settings.default_theme);
  await Promise.all([M.loadGroups(), M.loadMaps()]);
  if (M.S.dual) document.body.classList.add('dual-screen');
  M.renderShell();
  M.applyTheme(document.documentElement.dataset.theme);
  M.connect();
  M.route();
};

M.applyTheme(localStorage.getItem('theme') || 'neon');
window.addEventListener('DOMContentLoaded', M.boot);
