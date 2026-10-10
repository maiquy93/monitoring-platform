'use strict';
(() => {
  const { esc, $ } = M;
  const th = () => M.S.settings.thresholds;
  const devs = () => (M.S.snap ? M.S.snap.devices : []);
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const STATE_RANK = { down: 0, warning: 1, unknown: 2, up: 3, maint: 4 };

  const sortDevices = (list) => [...list].sort((a, b) =>
    STATE_RANK[a.status] - STATE_RANK[b.status] ||
    (a.status === 'down' ? SEV_RANK[b.severity] - SEV_RANK[a.severity] : 0) ||
    a.name.localeCompare(b.name));

  // ---------- shared widgets ----------
  const level = (v, key) => (v >= th()[key] ? 'crit' : v >= th()[key] - 10 ? 'hi' : '');
  const bar = (label, v, key) => `<div class="bar ${level(v, key)}">${label} ${Math.round(v)}%<i><b style="width:${Math.min(100, v)}%"></b></i></div>`;

  M.tile = (d) => {
    const ago = M.fmtDur((Date.now() - d.since) / 1000);
    let sub;
    if (d.status === 'down') sub = `${d.reasons[0] || 'Mất kết nối'} · ${ago}`;
    else if (d.status === 'warning') sub = d.reasons[0];
    else if (d.status === 'maint') sub = 'Đang bảo trì (tắt cảnh báo)';
    else if (d.status === 'unknown') sub = 'Chưa có dữ liệu';
    else sub = [d.address, d.rtt != null ? `${d.rtt} ms` : null, d.uptime != null ? `up ${M.fmtDur(d.uptime)}` : null].filter(Boolean).join(' · ');
    let bars = '';
    if (d.status === 'up' || d.status === 'warning') {
      const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram'], ['Disk', d.disk, 'disk']]
        .filter(([, value]) => value != null);
      if (metrics.length) bars = `<div class="bars">${metrics.map(([label, value, key]) => bar(label, value, key)).join('')}</div>`;
      else if (d.toner != null) bars = `<div class="bars"><div class="bar ${d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : ''}">Mực ${d.toner}%<i><b style="width:${d.toner}%"></b></i></div></div>`;
    }
    return `<a class="tile ${M.statusClass(d)}" href="#/device/${d.id}">
      <div class="t-top"><span class="t-ico">${M.ICON[d.type] || ''}</span><span class="t-name" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="t-state">${M.STATE_NAME[d.status]}</span></div><div class="t-sub" title="${esc(sub)}">${esc(sub)}</div>${bars}</a>`;
  };

  const groupDevices = (g) => devs().filter((d) => d.groups.includes(g.id));
  const groupClass = (list) => {
    const s = M.summarize(list);
    if (!s.total) return { s, cls: '' };
    const downs = list.filter((d) => d.status === 'down');
    if (downs.length) return { s, cls: `down sev-${downs.reduce((m, d) => (SEV_RANK[d.severity] > SEV_RANK[m] ? d.severity : m), 'low')}` };
    if (s.warning) return { s, cls: 'warning' };
    return { s, cls: s.unknown === s.total ? '' : 'up' };
  };
  M.groupTile = (g) => {
    const { s, cls } = groupClass(groupDevices(g));
    return `<a class="tile group ${cls}" href="#/group/${g.id}"><div class="t-top"><span class="t-ico">🗂️</span>
      <span class="t-name">${esc(g.name)}</span><span class="t-state">${s.down ? `${s.down} down` : s.warning ? `${s.warning} cảnh báo` : s.total ? 'Ổn định' : 'Trống'}</span></div>
      <div class="g-count">${s.alive}<small>/${s.total}</small></div><div class="t-sub">${esc(g.description || '')}</div></a>`;
  };

  M.gauge = (label, v, key, sub) => {
    const C = 2 * Math.PI * 52;
    const lv = level(v, key);
    const col = lv === 'crit' ? 'var(--c-critical)' : lv === 'hi' ? 'var(--c-medium)' : 'var(--c-ok)';
    return `<div class="gauge"><svg viewBox="0 0 130 130"><circle cx="65" cy="65" r="52" fill="none" stroke="var(--panel2)" stroke-width="12"/>
      <circle cx="65" cy="65" r="52" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(v / 100) * C} ${C}" transform="rotate(-90 65 65)"/>
      <text x="65" y="74" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text)">${Math.round(v)}%</text></svg>
      <div class="g-label">${label}${sub ? `<br>${sub}` : ''}</div></div>`;
  };

  M.chart = (pts, series, range, max) => {
    const W = 600, H = 170, L = 34, R = 8, T = 8, B = 20;
    if (pts.length < 2) return '<div class="muted" style="padding:30px;text-align:center">Chưa đủ dữ liệu lịch sử</div>';
    const x0 = pts[0].ts, x1 = pts[pts.length - 1].ts;
    const yMax = max || Math.max(1, ...series.flatMap((s) => pts.map((p) => p[s.key] ?? 0))) * 1.2;
    const sx = (t) => L + (W - L - R) * ((t - x0) / (x1 - x0 || 1));
    const sy = (v) => T + (H - T - B) * (1 - v / yMax);
    const paths = series.map((s) => {
      let d = '', pen = false;
      for (const p of pts) {
        if (p[s.key] == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${sx(p.ts).toFixed(1)} ${sy(p[s.key]).toFixed(1)}`;
        pen = true;
      }
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }).join('');
    const fmt = (t) => new Date(t).toLocaleString('vi-VN', range === '7d' || range === '24h' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${sy(yMax * f)}" y2="${sy(yMax * f)}"/><text x="${L - 4}" y="${sy(yMax * f) + 3}" text-anchor="end">${Math.round(yMax * f)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}
      <text x="${L}" y="${H - 4}">${fmt(x0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text></svg>
      <div class="legend">${series.map((s) => `<span style="--lc:${s.color}">${s.label}</span>`).join('')}</div>`;
  };

  M.eventsTable = (events, showDevice) => {
    if (!events.length) return '<div class="muted">Chưa có sự kiện</div>';
    const badge = (e) => (e.kind === 'audit' ? 'ok' : e.severity);
    const label = { down: 'Mất kết nối', up: 'Phục hồi', warning: 'Cảnh báo', audit: 'Hệ thống' };
    return `<table class="tbl"><thead><tr><th>Thời gian</th>${showDevice ? '<th>Thiết bị</th>' : ''}<th>Loại</th><th>Nội dung</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${M.fmtTime(e.ts)}</td>${showDevice ? `<td>${e.device_id ? `<a href="#/device/${e.device_id}">${esc(e.device_name)}</a>` : esc(e.device_name)}</td>` : ''}
      <td><span class="sev-badge ${badge(e)}">${label[e.kind] || e.kind}</span></td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table>`;
  };

  // ---------- dashboard ----------
  const F = { q: '', status: '', type: '' };
  M.views.dashboard = {
    render(el) {
      el.innerHTML = `<div class="kpis" id="kpis"></div>
        <div id="groups-sec"></div>
        <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">Thiết bị</h2><span class="spacer"></span>
          <input class="inp" id="f-q" placeholder="Tìm thiết bị…" style="width:200px" value="${esc(F.q)}">
          <select class="sel" id="f-status"><option value="">Tất cả trạng thái</option><option value="problem">Chỉ có vấn đề</option>
            <option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Hoạt động</option></select>
          <select class="sel" id="f-type"><option value="">Mọi loại</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="grid" id="grid"></div>`;
      $('#f-status').value = F.status; $('#f-type').value = F.type;
      $('#f-q').addEventListener('input', (e) => { F.q = e.target.value; this.update(M.S.snap); });
      $('#f-status').addEventListener('change', (e) => { F.status = e.target.value; this.update(M.S.snap); });
      $('#f-type').addEventListener('change', (e) => { F.type = e.target.value; this.update(M.S.snap); });
    },
    update(snap) {
      if (!snap || !$('#kpis')) return;
      const s = snap.summary;
      const k = (cls, label, v, zero) => `<div class="kpi ${cls} ${zero && !v ? 'zero' : ''}"><div class="label">${label}</div><div class="val">${v}</div></div>`;
      $('#kpis').innerHTML = `<div class="kpi big"><div class="label">Thiết bị đang hoạt động</div><div class="val">${s.alive}<small>/${s.total}</small></div></div>
        ${k('k-down', 'Mất kết nối', s.down, true)}${k('k-warn', 'Cảnh báo', s.warning, true)}${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance)}`;
      $('#groups-sec').innerHTML = M.S.groups.length
        ? `<h2>Nhóm thiết bị</h2><div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>` : '';
      let list = snap.devices;
      if (F.q) list = list.filter((d) => (d.name + d.address + d.location).toLowerCase().includes(F.q.toLowerCase()));
      if (F.type) list = list.filter((d) => d.type === F.type);
      if (F.status === 'problem') list = list.filter((d) => d.status === 'down' || d.status === 'warning');
      else if (F.status) list = list.filter((d) => d.status === F.status);
      $('#grid').innerHTML = list.length ? sortDevices(list).map(M.tile).join('')
        : `<div class="muted">${snap.devices.length ? 'Không có thiết bị phù hợp' : 'Chưa có thiết bị nào. Vào mục "Thiết bị" để thêm.'}</div>`;
    },
  };

  // ---------- groups ----------
  M.views.groups = {
    async render(el) {
      await M.loadGroups();
      el.innerHTML = `<div class="row"><h1>Nhóm / cụm thiết bị</h1><span class="spacer"></span>
        ${M.S.user.role === 'admin' ? '<button class="btn primary" id="g-add">+ Thêm nhóm</button>' : ''}</div><div class="grid" id="g-grid"></div>`;
      const add = $('#g-add');
      if (add) add.onclick = () => M.editGroup(null);
    },
    update() { $('#g-grid') && ($('#g-grid').innerHTML = M.S.groups.map(M.groupTile).join('') || '<div class="muted">Chưa có nhóm. Nhóm giúp gom các thiết bị (ví dụ: Tầng 1, Cụm DB) để theo dõi riêng.</div>'); },
  };

  M.views.group = {
    async render(el, id) {
      await M.loadGroups();
      const g = M.S.groups.find((x) => x.id === Number(id));
      if (!g) { el.innerHTML = '<div class="panel err">Không tìm thấy nhóm</div>'; return; }
      this.g = g;
      el.innerHTML = `<div id="grp-hero"></div><h2>Thiết bị trong nhóm</h2><div class="grid" id="grp-grid"></div>`;
    },
    update(snap) {
      const g = this.g;
      if (!g || !$('#grp-hero')) return;
      const list = snap.devices.filter((d) => d.groups.includes(g.id));
      const { s, cls } = groupClass(list);
      const avg = (k) => { const v = list.map((d) => d[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      $('#grp-hero').innerHTML = `<div class="hero ${cls}"><div class="h-ico">🗂️</div><div style="flex:1"><h1>${esc(g.name)}</h1>
        <div class="muted">${esc(g.description || '')}</div></div>
        <div style="text-align:right"><div class="h-state">${s.alive}/${s.total} hoạt động</div>
        <div class="muted">${s.down} mất kết nối · ${s.warning} cảnh báo</div></div>
        ${M.S.user.role === 'admin' ? '<button class="btn" id="g-edit">Sửa nhóm</button>' : ''}</div>
        <div class="gauges panel" style="margin-top:14px">${['cpu', 'ram', 'disk'].map((k) => (avg(k) != null ? M.gauge(`${k.toUpperCase()} trung bình`, avg(k), k) : '')).join('') || '<span class="muted">Nhóm chưa có thiết bị cài agent</span>'}</div>`;
      $('#grp-grid').innerHTML = sortDevices(list).map(M.tile).join('') || '<div class="muted">Nhóm chưa có thiết bị</div>';
      const e = $('#g-edit');
      if (e) e.onclick = () => M.editGroup(g);
    },
  };

  // ---------- device ----------
  M.views.device = {
    async render(el, id) {
      this.id = Number(id); this.range = this.range || '1h'; this.busy = false;
      el.innerHTML = `<div id="d-hero"></div><div class="panel" id="d-gauges" style="margin-top:14px"></div>
        <div class="cols"><div>
          <div class="panel"><div class="row"><h2 style="margin:0">Lịch sử</h2><span class="spacer"></span>
            <select class="sel" id="d-range"><option value="1h">1 giờ</option><option value="6h">6 giờ</option><option value="24h">24 giờ</option><option value="7d">7 ngày</option></select></div>
            <div id="d-charts"></div></div>
          <div class="panel" style="margin-top:14px"><h2 style="margin:0 0 10px">Sự kiện gần đây</h2><div id="d-events"></div></div>
        </div><div class="panel" id="d-info"></div></div>`;
      $('#d-range').value = this.range;
      this._infoHtml = null;
      if (!M.profiles) M.profiles = await M.api('GET', '/api/snmp/profiles').then((r) => r.profiles).catch(() => []);
      $('#d-range').onchange = (e) => { this.range = e.target.value; this.loadCharts(); };
      await this.load();
      this.loadCharts(); this.loadEvents();
      this.t1 = setInterval(() => this.loadCharts(), 30000);
      this.t2 = setInterval(() => this.loadEvents(), 10000);
    },
    destroy() { clearInterval(this.t1); clearInterval(this.t2); this.D = null; },
    update(snap) {
      const latest = snap && snap.devices.find((x) => x.id === this.id);
      if (latest) {
        this.D = { ...this.D, ...latest };
        this.paint();
      }
      this.load();
    },
    async load() {
      if (this.busy) return;
      this.busy = true;
      try { this.D = await M.api('GET', `/api/devices/${this.id}`); this.paint(); } catch (e) {
        if ($('#d-hero')) $('#d-hero').innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
      } finally { this.busy = false; }
    },
    paint() {
      const d = this.D;
      if (!d || !$('#d-hero')) return;
      const role = M.S.user.role;
      $('#d-hero').innerHTML = `<div class="hero ${M.statusClass(d)}"><div class="h-ico">${M.ICON[d.type] || ''}</div>
        <div style="flex:1;min-width:0"><h1>${esc(d.name)}</h1><div class="h-state">${M.STATE_NAME[d.status]}
        <span class="muted" style="font-size:14px;text-transform:none"> · từ ${M.fmtTime(d.since)} (${M.fmtDur((Date.now() - d.since) / 1000)})</span></div>
        ${d.reasons.map((r) => `<div class="reason">• ${esc(r)}</div>`).join('')}</div>
        <div class="row">${d.status === 'down' && !d.acked && role !== 'viewer' ? '<button class="btn" id="d-ack">Đã biết</button>' : ''}
        ${role === 'admin' ? `<button class="btn" id="d-maint">${d.maintenance ? 'Kết thúc bảo trì' : 'Bảo trì'}</button><button class="btn" id="d-edit">Sửa</button>` : ''}
        <button class="btn" id="d-back">← Quay lại</button></div></div>`;
      const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
      on('#d-back', () => history.back());
      on('#d-ack', async () => { await M.api('POST', `/api/devices/${d.id}/ack`, {}); });
      on('#d-maint', async () => { await M.api('PUT', `/api/devices/${d.id}`, { maintenance: !d.maintenance }); });
      on('#d-edit', () => M.editDevice(d.id));

      const a = d.agent;
      const gs = [];
      if (d.cpu != null) gs.push(M.gauge('CPU', d.cpu, 'cpu', a && a.cores ? `${a.cores} nhân` : ''));
      if (d.ram != null) gs.push(M.gauge('RAM', d.ram, 'ram', a && a.ram.total ? `${M.fmtBytes(a.ram.used)} / ${M.fmtBytes(a.ram.total)}` : ''));
      if (d.disk != null) gs.push(M.gauge('Ổ đĩa (cao nhất)', d.disk, 'disk'));
      const stat = (label, v) => `<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px">${v}</div><div class="g-label">${label}</div></div>`;
      gs.push(stat('Thời gian chạy', M.fmtDur(d.uptime)), stat('Ping', d.rtt != null ? `${d.rtt} ms` : '—'));
      if (d.toner != null) gs.push(M.gauge('Mực in', d.toner, 'cpu'));
      if (d.temperature != null) gs.push(stat('Nhiệt độ', `${d.temperature}°C`));
      $('#d-gauges').innerHTML = `<div class="gauges" style="margin:0">${gs.join('')}</div>`;

      const names = d.groups.map((id) => (M.S.groups.find((g) => g.id === id) || {}).name).filter(Boolean);
      const chk = [d.check_icmp && 'ICMP ping', d.check_agent && 'Agent', d.snmp_enabled && 'SNMP'].filter(Boolean).join(', ') || '—';
      const kv = (k, v) => `<dt>${k}</dt><dd>${v == null || v === '' ? '—' : esc(v)}</dd>`;
      let html = `<h2 style="margin:0 0 10px">Thông tin</h2><dl class="kv">${kv('Loại', M.TYPE_NAME[d.type])}${kv('Địa chỉ', d.address)}${kv('Vị trí', d.location)}
        <dt>Mức cảnh báo</dt><dd><span class="sev-badge ${d.severity}">${M.SEV_NAME[d.severity]}</span>${d.severity_override ? '' : ' <span class="muted">(theo loại)</span>'}</dd>
        ${kv('Nhóm', names.join(', '))}${kv('Kiểm tra', chk)}${kv('Ghi chú', d.notes)}</dl>`;
      if (a) {
        html += `<h2>Agent</h2><dl class="kv">${kv('Hostname', a.hostname)}${kv('Hệ điều hành', a.os)}${kv('IP', a.ip)}${kv('Phiên bản', a.version)}
          ${kv('Báo cáo cuối', d.last_agent_at ? M.fmtTime(d.last_agent_at) : '')}</dl>`;
        if (a.disks.length) {
          html += `<h2>Ổ đĩa</h2><table class="tbl"><tbody>${a.disks.map((x) => `<tr><td>${esc(x.mount)}</td><td>${M.fmtBytes(x.used)} / ${M.fmtBytes(x.total)}</td>
            <td style="width:70px">${bar('', x.percent ?? 0, 'disk')}</td></tr>`).join('')}</tbody></table>`;
        }
      }
      if (d.snmp_enabled) html += this.snmpSection(d, kv);
      if (d.agent_token) {
        html += `<h2>Agent token</h2><details><summary class="muted">Hiện token (bí mật)</summary><code style="word-break:break-all">${esc(d.agent_token)}</code>
          <div style="margin-top:6px"><button class="btn sm danger" id="d-regen">Tạo token mới</button></div></details>`;
      }
      const open = $('#d-info details') && $('#d-info details').open;
      if (html !== this._infoHtml) { // keep the profile dropdown usable while live updates arrive
        this._infoHtml = html;
        $('#d-info').innerHTML = html;
        if (open && $('#d-info details')) $('#d-info details').open = true;
        this.bindSnmp(d);
      }
      const rg = $('#d-regen');
      if (rg) rg.onclick = () => M.confirm('Tạo token mới? Agent đang dùng token cũ sẽ bị từ chối.', async () => {
        await M.api('POST', `/api/devices/${d.id}/regen-token`, {});
        this.load();
      });
    },
    snmpSection(d, kv) {
      const s = d.snmp;
      const pr = s && s.profile;
      let h = '<h2>SNMP</h2>';
      if (d.snmp_error) h += `<div class="reason">• Lần đọc SNMP gần nhất lỗi: ${esc(d.snmp_error.message)}</div>`;
      if (s) {
        h += `<dl class="kv">${kv('sysName', s.sysName)}${kv('sysDescr', s.sysDescr)}${kv('sysObjectID', s.sysObjectID)}
          ${pr ? kv('Hồ sơ đang dùng', `${pr.name} (${pr.auto ? 'tự nhận diện' : 'chọn tay'})`) : ''}</dl>`;
        if (pr && pr.missing) h += `<div class="reason">• Hồ sơ đã chọn "${esc(pr.requested)}" không còn tồn tại, đang tự nhận diện.</div>`;
        const rows = Object.entries(s.diag || {}).map(([k, m]) => {
          const val = (x) => (k === 'uptime' ? M.fmtDur(x) : `${x}${m.unit || ''}`);
          if (m.ok) {
            const note = [m.source > 0 ? `nguồn dự phòng #${m.source + 1}` : '', m.unverified ? 'chưa kiểm chứng' : ''].filter(Boolean).join(' · ');
            return `<tr><td>${esc(m.label)}</td><td><b>${esc(val(m.value))}</b></td><td class="muted">${esc(note)}</td></tr>`;
          }
          const tried = (m.tried || []).map((t) => t.oid).join(', ');
          return `<tr><td>${esc(m.label)}</td><td>—</td><td class="${m.optional ? 'muted' : ''}" ${m.optional ? '' : 'style="color:var(--c-high)"'}>
            ${m.optional ? 'Không có: ' : 'Không đọc được: '}${esc(m.message)}<br><span class="muted">đã thử OID: ${esc(tried)}</span></td></tr>`;
        });
        if (rows.length) h += `<table class="tbl"><thead><tr><th>Chỉ số</th><th>Giá trị</th><th>Ghi chú / lý do</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
      } else if (!d.snmp_error) h += '<div class="muted">Chưa có dữ liệu SNMP.</div>';
      if (M.S.user.role === 'admin') {
        const opts = (M.profiles || []).map((p) => `<option value="${esc(p.id)}" ${p.id === d.snmp_profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        h += `<div class="row" style="margin-top:10px"><select class="sel" id="d-prof" title="Hồ sơ SNMP"><option value="">Tự nhận diện</option>${opts}</select>
          <button class="btn sm" id="d-walk">Xuất dữ liệu SNMP</button></div>
          <div class="muted" style="font-size:12px;margin-top:4px">Nhận diện sai? Chọn hồ sơ khác. Thiết bị chưa được hỗ trợ? Xuất dữ liệu SNMP và gửi file .walk cho nhà phát triển.</div>`;
      }
      return h;
    },
    bindSnmp(d) {
      const sel = $('#d-prof');
      if (sel) sel.onchange = async () => {
        try { await M.api('PUT', `/api/devices/${d.id}`, { snmp_profile: sel.value }); M.toast('Đã đổi hồ sơ SNMP, đang đọc lại...'); } catch (e) { M.toast(e.message); }
      };
      const btn = $('#d-walk');
      if (btn) btn.onclick = async () => {
        btn.disabled = true; btn.textContent = 'Đang đọc thiết bị...';
        try {
          const r = await fetch(`/api/devices/${d.id}/snmp-walk`, { method: 'POST', headers: { 'X-Requested-With': 'monitor' }, credentials: 'same-origin' });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await r.blob());
          a.download = `${d.name.replace(/[^\w.-]+/g, '-')}.walk`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          M.toast('Đã xuất file .walk');
        } catch (e) { M.toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Xuất dữ liệu SNMP'; }
      };
    },
    async loadCharts() {
      if (!$('#d-charts')) return;
      const { points } = await M.api('GET', `/api/devices/${this.id}/history?range=${this.range}`);
      if (!$('#d-charts')) return;
      const has = (k) => points.some((p) => p[k] != null);
      let html = '';
      if (has('cpu')) html += `<h2>CPU / RAM / Ổ đĩa (%)</h2>${M.chart(points, [{ key: 'cpu', color: 'var(--c-low)', label: 'CPU' }, { key: 'ram', color: 'var(--c-medium)', label: 'RAM' }, { key: 'disk', color: 'var(--c-high)', label: 'Disk' }], this.range, 100)}`;
      if (has('rtt')) html += `<h2>Độ trễ ping (ms)</h2>${M.chart(points, [{ key: 'rtt', color: 'var(--c-ok)', label: 'RTT' }], this.range)}`;
      $('#d-charts').innerHTML = html || '<div class="muted" style="padding:20px">Chưa có dữ liệu lịch sử</div>';
    },
    async loadEvents() {
      if (!$('#d-events')) return;
      const { events } = await M.api('GET', `/api/events?device=${this.id}&limit=15`);
      if ($('#d-events')) $('#d-events').innerHTML = M.eventsTable(events, false);
    },
  };

  // ---------- events ----------
  M.views.events = {
    async render(el) {
      el.innerHTML = `<div class="row"><h1>Nhật ký sự kiện</h1><span class="spacer"></span>
        <select class="sel" id="ev-kind"><option value="">Tất cả</option><option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Phục hồi</option><option value="audit">Hệ thống</option></select></div>
        <div class="panel" id="ev-body"></div>`;
      $('#ev-kind').onchange = () => this.load();
      await this.load();
      this.t = setInterval(() => this.load(), 10000);
    },
    destroy() { clearInterval(this.t); },
    async load() {
      const { events } = await M.api('GET', '/api/events?limit=300');
      const k = $('#ev-kind') && $('#ev-kind').value;
      if ($('#ev-body')) $('#ev-body').innerHTML = M.eventsTable(k ? events.filter((e) => e.kind === k) : events, true);
    },
  };
})();
