'use strict';
(() => {
  const { esc, $, $$ } = M;
  const th = () => M.S.settings.thresholds;
  const devs = () => (M.S.snap ? M.S.snap.devices : []);
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
  const STATE_RANK = { down: 0, warning: 1, unknown: 2, up: 3, maint: 4 };

  const defaultSort = (a, b) =>
    STATE_RANK[a.status] - STATE_RANK[b.status] ||
    (a.status === 'down' ? (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) : 0) ||
    a.name.localeCompare(b.name);

  const sortDevices = (list) => {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    if (Array.isArray(saved) && saved.length) {
      const orderMap = new Map(saved.map((id, idx) => [Number(id), idx]));
      return [...list].sort((a, b) => {
        const ia = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
        const ib = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
        if (ia !== ib) return ia - ib;
        return defaultSort(a, b);
      });
    }
    return [...list].sort(defaultSort);
  };

  // ---------- shared widgets ----------
  const level = (v, key) => (v >= th()[key] ? 'crit' : v >= th()[key] - 10 ? 'hi' : '');
  const bar = (label, v, key) => `<div class="bar ${level(v, key)}">${label} ${Math.round(v)}%<i><b style="width:${Math.min(100, v)}%"></b></i></div>`;

  M.tile = (d) => {
    const ago = M.fmtDur((Date.now() - d.since) / 1000);
    let sub;
    if (d.status === 'down') sub = `${d.reasons[0] || 'Mất kết nối'} · ${ago}`;
    else if (d.status === 'maint') sub = 'Đang bảo trì (tắt cảnh báo)';
    else if (d.status === 'unknown') sub = 'Chưa có dữ liệu';
    else if (d.type === 'printer') {
      const parts = [d.address];
      if (d.printer_status) parts.push(d.printer_status);
      else if (d.rtt != null) parts.push(`${d.rtt} ms`);
      if (d.page_count != null) parts.push(`${Number(d.page_count).toLocaleString('vi-VN')} trang`);
      if (d.printer_errors && d.printer_errors.length && !d.mute_local_alerts) parts.unshift(d.printer_errors[0]);
      sub = parts.filter(Boolean).join(' · ');
    } else if (d.type === 'ap') {
      const parts = [d.address];
      if (d.rtt != null) parts.push(`${d.rtt} ms`);
      if (d.total_ssids != null) parts.push(`📶 ${d.total_ssids} SSID`);
      if (d.total_clients != null) parts.push(`👥 ${d.total_clients} client`);
      if (d.uptime != null) parts.push(`up ${M.fmtDur(d.uptime)}`);
      sub = parts.filter(Boolean).join(' · ');
    } else if (d.status === 'warning') sub = d.reasons[0];
    else {
      const parts = [d.address, d.rtt != null ? `${d.rtt} ms` : null];
      if (d.total_ssids != null) parts.push(`📶 ${d.total_ssids} SSID`);
      if (d.total_clients != null) parts.push(`👥 ${d.total_clients} client`);
      if (d.uptime != null) parts.push(`up ${M.fmtDur(d.uptime)}`);
      sub = parts.filter(Boolean).join(' · ');
    }
    let bars = '';
    if (d.status === 'up' || d.status === 'warning') {
      const pBars = [];
      if (d.type === 'ap') {
        if (d.total_ssids != null || d.total_clients != null) {
          const sText = d.total_ssids != null ? `${d.total_ssids} SSID` : '— SSID';
          const cText = d.total_clients != null ? `${d.total_clients} client` : '— client';
          pBars.push(`<div class="bar bar-ap" style="background:var(--panel2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;display:flex;align-items:center;justify-content:space-between;line-height:18px" title="Tổng số lượng SSID phát sóng và Client kết nối"><span style="color:var(--c-low);font-weight:600">📶 ${sText}</span><span style="color:var(--c-ok);font-weight:700">👥 ${cText}</span></div>`);
        }
        const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram']].filter(([, value]) => value != null);
        for (const [lbl, val, k] of metrics) pBars.push(bar(lbl, val, k));
        bars = `<div class="bars">${pBars.join('')}</div>`;
      } else if (d.type === 'printer') {
        // 1. Drum (tuổi thọ trống từ)
        if (d.drum != null) {
          const lv = d.drum <= 10 ? 'crit' : d.drum <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Drum ${Math.round(d.drum)}%<i><b style="width:${Math.min(100, Math.max(0, d.drum))}%"></b></i></div>`);
        } else {
          pBars.push(`<div class="bar bar-na" title="Hộp mực tích hợp (all-in-one) hoặc không có cảm biến drum riêng">Drum —<i><b style="width:0%"></b></i></div>`);
        }
        // 2. Mực (lượng mực còn lại)
        if (d.toner != null) {
          const lv = d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Mực ${Math.round(d.toner)}%<i><b style="width:${Math.min(100, Math.max(0, d.toner))}%"></b></i></div>`);
        } else {
          pBars.push(`<div class="bar bar-na" title="Không đọc được dữ liệu mức mực">Mực —<i><b style="width:0%"></b></i></div>`);
        }
        bars = `<div class="bars">${pBars.join('')}</div>`;
      } else {
        if (d.drum != null) {
          const lv = d.drum <= 10 ? 'crit' : d.drum <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Drum ${Math.round(d.drum)}%<i><b style="width:${Math.min(100, Math.max(0, d.drum))}%"></b></i></div>`);
        }
        if (d.toner != null) {
          const lv = d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Mực ${Math.round(d.toner)}%<i><b style="width:${Math.min(100, Math.max(0, d.toner))}%"></b></i></div>`);
        }
        const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram'], ['Disk', d.disk, 'disk']]
          .filter(([, value]) => value != null);
        const metricBars = metrics.map(([label, value, key]) => bar(label, value, key));
        if (d.temperature != null) {
          const tTh = (th() && th().temp) || 85;
          const tLv = d.temperature >= tTh ? 'crit' : d.temperature >= tTh - 10 ? 'hi' : '';
          metricBars.push(`<div class="bar ${tLv}">Temp ${Math.round(d.temperature)}°C<i><b style="width:${Math.min(100, Math.max(0, d.temperature))}%"></b></i></div>`);
        } else if (d.type === 'vm' || d.type === 'server' || (d.checks && d.checks.agent)) {
          metricBars.push(`<div class="bar bar-na" title="Môi trường máy ảo (VM) hoặc phần cứng không có cảm biến nhiệt">Temp —<i><b style="width:0%"></b></i></div>`);
        }
        if (pBars.length && !metricBars.length) {
          bars = `<div class="bars">${pBars.join('')}</div>`;
        } else if (metricBars.length) {
          if (pBars.length) metricBars.push(...pBars);
          bars = `<div class="bars">${metricBars.join('')}</div>`;
        }
      }
    }
    let alertBadges = '';
    const al = d.alerts;
    if (al && !d.mute_local_alerts) {
      const items = [];
      if (al.dos || d.dos_alert) {
        const ppsStr = d.pkt_rate ? ` ${Math.round(d.pkt_rate / 1000)}k pps` : '';
        const titleStr = `Nghi ngờ tấn công Flood/DoS${d.pkt_rate ? ` (${d.pkt_rate.toLocaleString('vi-VN')} gói/s)` : ''}${d.dos_details ? ` · ${d.dos_details}` : ''}`;
        items.push(`<span class="t-badge-alert alert-dos" title="${esc(titleStr)}">🛡️ DoS${ppsStr}</span>`);
      }
      if (al.power || (d.power && d.power.on_battery)) {
        const pct = d.power && d.power.battery_percent != null ? ` ${d.power.battery_percent}%` : '';
        items.push(`<span class="t-badge-alert alert-power" title="Mất điện lưới - Đang dùng pin UPS${pct}">🔋 Mất điện${pct}</span>`);
      }
      if (al.smart || (d.smart && d.smart.ok === false)) {
        items.push(`<span class="t-badge-alert alert-smart" title="Cảnh báo đĩa cứng SMART lỗi / Bad Sector${d.smart && d.smart.details ? `: ${esc(d.smart.details)}` : ''}">💾 Lỗi đĩa</span>`);
      }
      if (al.thermal || (d.temperature != null && d.temperature >= ((th() && th().temp) || 85))) {
        items.push(`<span class="t-badge-alert alert-thermal" title="Báo động nhiệt độ CPU quá cao (Thermal Throttling)">🔥 ${Math.round(d.temperature)}°C</span>`);
      }
      if (al.printer || (d.printer_errors && d.printer_errors.length)) {
        const errText = d.printer_errors && d.printer_errors.length ? d.printer_errors[0] : 'Sự cố máy in';
        items.push(`<span class="t-badge-alert alert-printer" title="${esc(d.printer_errors ? d.printer_errors.join('; ') : errText)}">⚠️ ${esc(errText)}</span>`);
      }
      if (d.toner != null && d.toner >= 0 && d.toner <= 10) {
        items.push(`<span class="t-badge-alert alert-power" title="Hộp mực sắp hết: còn ${d.toner}%">🖨️ Mực ${d.toner}%</span>`);
      }
      if (d.drum != null && d.drum >= 0 && d.drum <= 10) {
        items.push(`<span class="t-badge-alert alert-smart" title="Cụm drum sắp hết hạn: còn ${d.drum}%, cần thay drum">🔄 Drum ${d.drum}%</span>`);
      }
      if (items.length) {
        alertBadges = `<div class="t-alert-row">${items.join('')}</div>`;
      }
    }
    return `<a class="tile ${M.statusClass(d)}" href="#/device/${d.id}" data-id="${d.id}" draggable="false">
      <div class="t-top"><span class="t-ico">${M.ICON[d.type] || ''}</span><span class="t-name" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="t-state">${M.STATE_NAME[d.status]}</span></div>${alertBadges}<div class="t-sub" title="${esc(sub)}">${esc(sub)}</div>${bars}</a>`;
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

  M.consumableGauge = (label, v, sub) => {
    const C = 2 * Math.PI * 52;
    const val = Math.min(100, Math.max(0, v));
    const col = val <= 10 ? 'var(--c-critical)' : val <= 25 ? 'var(--c-medium)' : 'var(--c-ok)';
    return `<div class="gauge"><svg viewBox="0 0 130 130"><circle cx="65" cy="65" r="52" fill="none" stroke="var(--panel2)" stroke-width="12"/>
      <circle cx="65" cy="65" r="52" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(val / 100) * C} ${C}" transform="rotate(-90 65 65)"/>
      <text x="65" y="74" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text)">${Math.round(val)}%</text></svg>
      <div class="g-label">${label}${sub ? `<br>${sub}` : ''}</div></div>`;
  };

  M.chart = (pts, series, range, max, fmtY) => {
    const W = 600, H = 170, L = fmtY ? 54 : 34, R = 8, T = 8, B = 20;
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
    const formatY = fmtY || ((v) => Math.round(v));
    const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${sy(yMax * f)}" y2="${sy(yMax * f)}"/><text x="${L - 4}" y="${sy(yMax * f) + 3}" text-anchor="end">${formatY(yMax * f)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}
      <text x="${L}" y="${H - 4}">${fmt(x0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text></svg>
      <div class="legend">${series.map((s) => `<span style="--lc:${s.color}">${s.label}</span>`).join('')}</div>`;
  };

  M.eventsTable = (events, showDevice) => {
    if (!events.length) return '<div class="muted">Chưa có sự kiện</div>';
    const badge = (e) => (e.kind === 'audit' ? 'ok' : e.severity);
    const label = { down: 'Mất kết nối', up: 'Phục hồi', warning: 'Cảnh báo', audit: 'Hệ thống', dos: 'Tấn công DoS', smart: 'Lỗi đĩa cứng', thermal: 'Quá nhiệt', power: 'Mất điện lưới' };
    return `<table class="tbl"><thead><tr><th>Thời gian</th>${showDevice ? '<th>Thiết bị</th>' : ''}<th>Loại</th><th>Nội dung</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${M.fmtTime(e.ts)}</td>${showDevice ? `<td>${e.device_id ? `<a href="#/device/${e.device_id}">${esc(e.device_name)}</a>` : esc(e.device_name)}</td>` : ''}
      <td><span class="sev-badge ${badge(e)}">${label[e.kind] || e.kind}</span></td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table>`;
  };

  // ---------- dashboard ----------
  const F = { q: '', status: '', type: '' };
  let isDragging = false;
  let draggedId = null;

  function saveDeviceOrder(visibleIds) {
    const snap = M.S.snap;
    if (!snap || !snap.devices) return;
    const allIds = snap.devices.map((d) => d.id);
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    if (!saved.length) saved = sortDevices(snap.devices).map((d) => d.id);
    else {
      const set = new Set(allIds);
      saved = saved.filter((id) => set.has(id));
      for (const id of allIds) if (!saved.includes(id)) saved.push(id);
    }
    const visSet = new Set(visibleIds);
    const slots = [];
    for (let i = 0; i < saved.length; i++) {
      if (visSet.has(saved[i])) slots.push(i);
    }
    for (let i = 0; i < slots.length && i < visibleIds.length; i++) {
      saved[slots[i]] = visibleIds[i];
    }
    localStorage.setItem('device_order', JSON.stringify(saved));
  }

  function reorderDevices(srcId, dstId) {
    const snap = M.S.snap;
    if (!snap || !snap.devices) return;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    const defaultIds = snap.devices.map((d) => d.id);
    if (!saved.length) saved = sortDevices(snap.devices).map((d) => d.id);
    else {
      const set = new Set(defaultIds);
      saved = saved.filter((id) => set.has(id));
      for (const id of defaultIds) if (!saved.includes(id)) saved.push(id);
    }
    const fromIdx = saved.indexOf(srcId);
    const toIdx = saved.indexOf(dstId);
    if (fromIdx !== -1 && toIdx !== -1) {
      saved.splice(fromIdx, 1);
      saved.splice(toIdx, 0, srcId);
      localStorage.setItem('device_order', JSON.stringify(saved));
      M.views.dashboard.update(M.S.snap);
    }
  }

  let dualTab = localStorage.getItem('dual_tab') || 'map';
  let currentDualMapId = null;
  let cachedDualMap = null;

  M.views.dashboard = {
    render(el) {
      if (M.S.dual) {
        el.innerHTML = `
          <div class="dual-layout">
            <div class="dual-pane dual-pane-main">
              <div class="dual-main-pinned">
                <div class="kpis" id="kpis"></div>
              </div>
              <div class="dual-main-scroll" id="dual-main-scroll">
                <div id="groups-sec"></div>
                <div class="row dual-filter-bar"><h2 style="margin:0">Thiết bị</h2>
                  <span class="dual-device-count" id="dev-count-badge">0</span>
                  <span class="spacer"></span>
                  <input class="inp" id="f-q" placeholder="Tìm thiết bị…" style="width:155px" value="${esc(F.q)}">
                  <select class="sel" id="f-status"><option value="">Tất cả trạng thái</option><option value="problem">Chỉ có vấn đề</option>
                    <option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Online</option></select>
                  <select class="sel" id="f-type"><option value="">Mọi loại</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
                </div>
                <div class="grid" id="grid"></div>
              </div>
            </div>
            <div class="dual-pane dual-pane-sub">
              <div class="dual-pane-head">
                <span class="dual-title">🖥️ Màn hình 2</span>
                <div class="dual-tabs">
                  <button class="btn sm ${dualTab === 'map' ? 'primary' : ''}" id="dual-tab-map">🗺️ Topology</button>
                  <button class="btn sm ${dualTab === 'groups' ? 'primary' : ''}" id="dual-tab-groups">🗂️ Nhóm <span class="dual-tab-badge" id="dual-badge-groups">0</span></button>
                  <button class="btn sm ${dualTab === 'problems' ? 'primary' : ''}" id="dual-tab-problems">⚠️ Cảnh báo <span class="dual-tab-badge" id="dual-badge-problems">0</span></button>
                </div>
                <span class="spacer"></span>
                <button class="btn sm" id="btn-dual-popout" title="Mở cửa sổ tách biệt cho màn hình phụ thứ hai">🗗 Cửa sổ riêng</button>
                <button class="btn sm" id="btn-dual-close" title="Tắt chế độ màn hình đôi">✕</button>
              </div>
              <div class="dual-pane-body" id="dual-pane-body"></div>
            </div>
          </div>`;

        const tabMap = $('#dual-tab-map');
        const tabGroups = $('#dual-tab-groups');
        const tabProblems = $('#dual-tab-problems');
        const switchDualTab = (t) => {
          dualTab = t;
          localStorage.setItem('dual_tab', t);
          tabMap?.classList.toggle('primary', t === 'map');
          tabGroups?.classList.toggle('primary', t === 'groups');
          tabProblems?.classList.toggle('primary', t === 'problems');
          this.updateDualPane(M.S.snap);
        };
        if (tabMap) tabMap.onclick = () => switchDualTab('map');
        if (tabGroups) tabGroups.onclick = () => switchDualTab('groups');
        if (tabProblems) tabProblems.onclick = () => switchDualTab('problems');

        const popoutBtn = $('#btn-dual-popout');
        if (popoutBtn) popoutBtn.onclick = () => {
          window.open(location.origin + '/#/secondary', 'monitoring_secondary_screen', 'width=1366,height=800,menubar=no,toolbar=no');
        };
        const closeBtn = $('#btn-dual-close');
        if (closeBtn) closeBtn.onclick = () => M.toggleDual(false);

        const body = $('#dual-pane-body');
        if (body) {
          body.addEventListener('click', (e) => {
            const node = e.target.closest('.m-node[data-href]');
            if (node && node.dataset.href) {
              location.hash = node.dataset.href;
            }
          });
        }
      } else {
        el.innerHTML = `<div class="kpis" id="kpis"></div>
          <div id="groups-sec"></div>
          <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">Thiết bị</h2>
            <span class="dual-device-count" id="dev-count-badge">0</span>
            <span class="spacer"></span>
            <input class="inp" id="f-q" placeholder="Tìm thiết bị…" style="width:200px" value="${esc(F.q)}">
            <select class="sel" id="f-status"><option value="">Tất cả trạng thái</option><option value="problem">Chỉ có vấn đề</option>
              <option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Online</option></select>
            <select class="sel" id="f-type"><option value="">Mọi loại</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="grid" id="grid"></div>`;
      }

      $('#f-status').value = F.status; $('#f-type').value = F.type;
      $('#f-q').addEventListener('input', (e) => { F.q = e.target.value; this.update(M.S.snap); });
      $('#f-status').addEventListener('change', (e) => { F.status = e.target.value; this.update(M.S.snap); });
      $('#f-type').addEventListener('change', (e) => { F.type = e.target.value; this.update(M.S.snap); });
      this.bindDragDrop();
    },
    destroy() {
      if (this.cleanupDrag) this.cleanupDrag();
    },
    bindDragDrop() {
      const grid = $('#grid');
      if (!grid) return;

      let session = null;
      let suppressClickUntil = 0;
      let scrollSpeed = 0;
      let scrollRaf = null;
      let lastSwapTime = 0;

      const stopAutoScroll = () => {
        scrollSpeed = 0;
        if (scrollRaf) {
          cancelAnimationFrame(scrollRaf);
          scrollRaf = null;
        }
      };

      const updateAutoScroll = (clientY) => {
        const scrollEl = $('#dual-main-scroll');
        const useContainer = scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight;
        const edge = 75;
        const maxSpeed = 14;
        let topBound = 0;
        let bottomBound = window.innerHeight;
        if (useContainer) {
          const r = scrollEl.getBoundingClientRect();
          topBound = r.top;
          bottomBound = r.bottom;
        }
        if (clientY < topBound + edge) {
          scrollSpeed = -Math.round((1 - Math.max(0, clientY - topBound) / edge) * maxSpeed);
        } else if (clientY > bottomBound - edge) {
          scrollSpeed = Math.round((1 - Math.max(0, bottomBound - clientY) / edge) * maxSpeed);
        } else {
          scrollSpeed = 0;
        }
        if (scrollSpeed !== 0 && !scrollRaf) {
          const loop = () => {
            if (scrollSpeed !== 0 && isDragging) {
              const sc = $('#dual-main-scroll');
              if (sc && sc.scrollHeight > sc.clientHeight) sc.scrollBy(0, scrollSpeed);
              else window.scrollBy(0, scrollSpeed);
              scrollRaf = requestAnimationFrame(loop);
            } else {
              scrollRaf = null;
            }
          };
          scrollRaf = requestAnimationFrame(loop);
        }
      };

      const detachWindowListeners = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', cancelDrag);
        window.removeEventListener('keydown', onKeyDown);
      };

      const cancelDrag = () => {
        if (!session) return;
        stopAutoScroll();
        detachWindowListeners();
        if (session.holdTimer) {
          clearTimeout(session.holdTimer);
          session.holdTimer = null;
        }
        if (session.started) {
          if (session.clone) session.clone.remove();
          if (session.tile) {
            session.tile.classList.remove('tile-placeholder');
            session.tile.style.transform = '';
            session.tile.style.transition = '';
          }
          grid.classList.remove('is-dragging');
          grid.style.touchAction = '';
          if (session.initialIds && session.initialIds.length) {
            const tileMap = new Map();
            grid.querySelectorAll('.tile').forEach((t) => {
              tileMap.set(Number(t.dataset.id), t);
              t.style.transform = '';
              t.style.transition = '';
            });
            for (const id of session.initialIds) {
              const el = tileMap.get(id);
              if (el) grid.appendChild(el);
            }
          }
          suppressClickUntil = Date.now() + 200;
          setTimeout(() => { isDragging = false; draggedId = null; }, 50);
        }
        session = null;
      };

      this.cleanupDrag = cancelDrag;

      const startDragging = (s, clientX, clientY) => {
        if (s.started) return;
        const tile = s.tile;
        if (!tile || !tile.dataset.id) return;
        const allTiles = Array.from(grid.querySelectorAll('.tile'));
        if (allTiles.length <= 1) return;

        s.started = true;
        isDragging = true;
        draggedId = Number(tile.dataset.id);
        s.initialIds = allTiles.map((t) => Number(t.dataset.id));

        const rect = tile.getBoundingClientRect();
        s.grabOffsetX = clientX - rect.left;
        s.grabOffsetY = clientY - rect.top;
        s.tileWidth = rect.width;
        s.tileHeight = rect.height;

        const clone = tile.cloneNode(true);
        clone.classList.add('tile-drag-clone');
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
        clone.style.left = '0px';
        clone.style.top = '0px';
        clone.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.04)`;
        document.body.appendChild(clone);
        s.clone = clone;

        tile.classList.add('tile-placeholder');
        grid.classList.add('is-dragging');
        grid.style.touchAction = 'none';

        if (navigator.vibrate) {
          try { navigator.vibrate(30); } catch {}
        }
      };

      const onPointerMove = (e) => {
        if (!session || e.pointerId !== session.pointerId) return;

        const dx = e.clientX - session.startX;
        const dy = e.clientY - session.startY;
        const dist = Math.hypot(dx, dy);

        if (!session.started) {
          if (session.pointerType === 'mouse') {
            if (dist > 4) {
              startDragging(session, e.clientX, e.clientY);
            }
          } else {
            if (dist > 8 && session.holdTimer) {
              clearTimeout(session.holdTimer);
              session.holdTimer = null;
              detachWindowListeners();
              session = null;
              return;
            }
          }
          return;
        }

        e.preventDefault();
        const curX = e.clientX - session.grabOffsetX;
        const curY = e.clientY - session.grabOffsetY;
        session.clone.style.transform = `translate3d(${curX}px, ${curY}px, 0) scale(1.04)`;

        updateAutoScroll(e.clientY);

        const cx = curX + session.tileWidth / 2;
        const cy = curY + session.tileHeight / 2;
        const allTiles = Array.from(grid.querySelectorAll('.tile'));
        let targetTile = null;

        for (const t of allTiles) {
          if (t === session.tile) continue;
          const r = t.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
            targetTile = t;
            break;
          }
        }

        if (!targetTile && allTiles.length > 1) {
          let closestDist = Infinity;
          for (const t of allTiles) {
            if (t === session.tile) continue;
            const r = t.getBoundingClientRect();
            const tcx = r.left + r.width / 2;
            const tcy = r.top + r.height / 2;
            const d = Math.hypot(cx - tcx, cy - tcy);
            if (d < closestDist && d < Math.max(r.width, r.height) * 0.85) {
              closestDist = d;
              targetTile = t;
            }
          }
        }

        const now = Date.now();
        if (targetTile && targetTile !== session.tile && (now - lastSwapTime > 75)) {
          const currentTiles = Array.from(grid.children).filter((el) => el.classList.contains('tile'));
          const pIdx = currentTiles.indexOf(session.tile);
          const tIdx = currentTiles.indexOf(targetTile);
          if (pIdx !== -1 && tIdx !== -1 && pIdx !== tIdx) {
            lastSwapTime = now;
            const firstRects = new Map();
            for (const t of currentTiles) {
              if (t !== session.tile) {
                firstRects.set(t, t.getBoundingClientRect());
              }
            }

            if (pIdx < tIdx) {
              grid.insertBefore(session.tile, targetTile.nextSibling);
            } else {
              grid.insertBefore(session.tile, targetTile);
            }

            for (const [t, oldRect] of firstRects.entries()) {
              const newRect = t.getBoundingClientRect();
              const diffX = oldRect.left - newRect.left;
              const diffY = oldRect.top - newRect.top;
              if (diffX !== 0 || diffY !== 0) {
                t.style.transition = 'none';
                t.style.transform = `translate(${diffX}px, ${diffY}px)`;
              }
            }

            grid.offsetHeight;

            requestAnimationFrame(() => {
              for (const [t] of firstRects) {
                t.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
                t.style.transform = '';
              }
            });
          }
        }
      };

      const onPointerUp = (e) => {
        if (!session || e.pointerId !== session.pointerId) return;

        stopAutoScroll();
        detachWindowListeners();

        if (session.holdTimer) {
          clearTimeout(session.holdTimer);
          session.holdTimer = null;
        }

        if (!session.started) {
          session = null;
          return;
        }

        e.preventDefault();
        const clone = session.clone;
        const tile = session.tile;
        const destRect = tile.getBoundingClientRect();

        grid.classList.remove('is-dragging');
        grid.style.touchAction = '';
        suppressClickUntil = Date.now() + 250;

        clone.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease, box-shadow 0.2s ease';
        clone.style.transform = `translate3d(${destRect.left}px, ${destRect.top}px, 0) scale(1)`;
        clone.style.boxShadow = '0 0 10px rgba(0,0,0,0.2)';
        clone.style.opacity = '1';

        const finalize = () => {
          if (clone.parentNode) clone.remove();
          tile.classList.remove('tile-placeholder');
          grid.querySelectorAll('.tile').forEach((t) => {
            t.style.transform = '';
            t.style.transition = '';
          });
          const newOrder = Array.from(grid.querySelectorAll('.tile'))
            .map((t) => Number(t.dataset.id))
            .filter(Boolean);
          saveDeviceOrder(newOrder);
          setTimeout(() => {
            isDragging = false;
            draggedId = null;
          }, 50);
        };

        let handled = false;
        clone.addEventListener('transitionend', () => {
          if (handled) return;
          handled = true;
          finalize();
        }, { once: true });
        setTimeout(() => {
          if (handled) return;
          handled = true;
          finalize();
        }, 220);

        session = null;
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape' && isDragging) {
          cancelDrag();
        }
      };

      grid.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const tile = e.target.closest('.tile');
        if (!tile || !tile.dataset.id) return;
        if (grid.querySelectorAll('.tile').length <= 1) return;

        session = {
          tile,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          pointerType: e.pointerType,
          started: false,
          holdTimer: null,
          clone: null,
        };

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp, { passive: false });
        window.addEventListener('pointercancel', cancelDrag);
        window.addEventListener('keydown', onKeyDown);

        if (e.pointerType === 'touch') {
          session.holdTimer = setTimeout(() => {
            if (session && !session.started) {
              startDragging(session, e.clientX, e.clientY);
            }
          }, 180);
        }
      });

      grid.addEventListener('dragstart', (e) => {
        e.preventDefault();
      });

      grid.addEventListener('click', (e) => {
        if (isDragging || Date.now() < suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    },
    update(snap) {
      if (!snap || !$('#kpis') || isDragging) return;
      const s = snap.summary;
      const k = (cls, label, v, zero, kpiKey, titleHint) => `
        <div class="kpi clickable ${cls} ${zero && !v ? 'zero' : ''}" data-kpi="${kpiKey}" title="${titleHint}">
          <div class="label">${label} <span class="kpi-hint">🔍 Chi tiết</span></div>
          <div class="val">${v}</div>
        </div>`;
      $('#kpis').innerHTML = `
        <div class="kpi big clickable" data-kpi="alive" title="Bấm để xem danh sách thiết bị đang hoạt động">
          <div class="label">Thiết bị đang hoạt động <span class="kpi-hint">🔍 Chi tiết</span></div>
          <div class="val">${s.alive}<small>/${s.total}</small></div>
        </div>
        ${k('k-down', 'Mất kết nối', s.down, true, 'down', 'Bấm để xem danh sách thiết bị mất kết nối')}
        ${k('k-warn', 'Cảnh báo', s.warning, true, 'warn', 'Bấm để xem danh sách chi tiết các cảnh báo')}
        ${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance, 'unk', 'Bấm để xem thiết bị chưa rõ hoặc đang bảo trì')}`;
      // Khi ở chế độ màn hình đôi, Nhóm thiết bị đã có tab riêng ở Màn hình 2, tránh lặp lại ở cột trái để dành trọn không gian từ mục Thiết bị trở xuống
      $('#groups-sec').innerHTML = (!M.S.dual && M.S.groups.length)
        ? `<h2>Nhóm thiết bị</h2><div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>` : '';
      let list = snap.devices;
      if (F.q) list = list.filter((d) => (d.name + d.address + d.location).toLowerCase().includes(F.q.toLowerCase()));
      if (F.type) list = list.filter((d) => d.type === F.type);
      if (F.status === 'problem') list = list.filter((d) => (d.status === 'down' || d.status === 'warning') && d.severity !== 'none');
      else if (F.status) list = list.filter((d) => d.status === F.status && (F.status !== 'warning' || d.severity !== 'none'));
      const countBadge = $('#dev-count-badge');
      if (countBadge) {
        countBadge.textContent = list.length === snap.devices.length ? `${list.length}` : `${list.length}/${snap.devices.length}`;
      }
      $('#grid').innerHTML = list.length ? sortDevices(list).map(M.tile).join('')
        : `<div class="muted">${snap.devices.length ? 'Không có thiết bị phù hợp' : 'Chưa có thiết bị nào. Vào mục "Thiết bị" để thêm.'}</div>`;

      if (M.S.dual) {
        this.updateDualPane(snap);
      }
    },
    updateDualPane(snap) {
      const body = $('#dual-pane-body');
      if (!body || !snap) return;
      const probs = snap.devices.filter((d) => (d.status === 'down' || d.status === 'warning') && d.severity !== 'none');
      const bGroups = $('#dual-badge-groups');
      if (bGroups) bGroups.textContent = `${M.S.groups.length}`;
      const bProbs = $('#dual-badge-problems');
      if (bProbs) {
        bProbs.textContent = `${probs.length}`;
        bProbs.classList.toggle('has-prob', probs.length > 0);
      }

      if (dualTab === 'map') {
        if (M.S.maps && M.S.maps.length > 0) {
          const mapId = currentDualMapId || M.S.maps[0].id;
          let selectHtml = '';
          if (M.S.maps.length > 1) {
            selectHtml = `<div style="margin-bottom:8px"><select class="sel" id="dual-map-sel">${M.S.maps.map((m) => `<option value="${m.id}" ${m.id === mapId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`;
          }
          if (!$('#dual-map-box')) {
            body.innerHTML = `${selectHtml}<div class="map-box" id="dual-map-box" style="overflow:hidden"><svg id="dual-map-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet"></svg></div>`;
          }
          const mapSel = $('#dual-map-sel');
          if (mapSel) {
            mapSel.onchange = async (e) => {
              currentDualMapId = Number(e.target.value);
              cachedDualMap = await M.api('GET', `/api/maps/${currentDualMapId}`);
              M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
            };
          }
          if (!cachedDualMap || cachedDualMap.id !== mapId) {
            M.api('GET', `/api/maps/${mapId}`).then((mData) => {
              cachedDualMap = mData;
              M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
            }).catch(() => {});
          } else {
            M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
          }
        } else {
          body.innerHTML = `<div class="panel" style="text-align:center;padding:36px 16px">
            <div style="font-size:36px;margin-bottom:8px">🗺️</div>
            <h3 style="margin:0 0 8px">Chưa có sơ đồ mạng Topology</h3>
            <p class="muted" style="margin:0 0 14px">Tạo sơ đồ mạng để theo dõi trực quan liên kết giữa các thiết bị trên màn hình thứ hai.</p>
            ${M.S.user.role !== 'viewer' ? '<a class="btn primary" href="#/maps">+ Tạo sơ đồ Topology</a>' : ''}
          </div>`;
        }
      } else if (dualTab === 'groups') {
        body.innerHTML = M.S.groups.length
          ? `<div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))">${M.S.groups.map(M.groupTile).join('')}</div>`
          : '<div class="muted">Chưa có nhóm thiết bị nào.</div>';
      } else if (dualTab === 'problems') {
        if (!probs.length) {
          body.innerHTML = `<div class="panel" style="text-align:center;padding:36px 16px;border-color:var(--c-ok)">
            <div style="font-size:40px;margin-bottom:8px">✅</div>
            <h3 style="color:var(--c-ok);margin:0 0 6px">Hệ thống đang hoạt động ổn định</h3>
            <p class="muted" style="margin:0">Tất cả thiết bị đều đang trực tuyến, không có cảnh báo.</p>
          </div>`;
        } else {
          body.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr))">${sortDevices(probs).map(M.tile).join('')}</div>`;
        }
      }
    },
  };

  // ---------- secondary screen (detached popout window) ----------
  M.views.secondary = {
    async render(el) {
      await Promise.all([M.loadGroups(), M.loadMaps()]);
      let secTab = localStorage.getItem('secondary_tab') || 'map';
      el.innerHTML = `
        <div class="secondary-screen-view">
          <div class="row" style="margin-bottom:14px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="brand" style="font-size:20px">◉ MÀN HÌNH PHỤ (SECONDARY)</div>
            <span class="chip" id="sec-chip">–/–</span>
            <div class="dual-tabs">
              <button class="btn sm ${secTab === 'map' ? 'primary' : ''}" id="sec-tab-map">🗺️ Sơ đồ Topology</button>
              <button class="btn sm ${secTab === 'groups' ? 'primary' : ''}" id="sec-tab-groups">🗂️ Nhóm thiết bị</button>
              <button class="btn sm ${secTab === 'problems' ? 'primary' : ''}" id="sec-tab-problems">⚠️ Cảnh báo</button>
              <button class="btn sm ${secTab === 'wallboard' ? 'primary' : ''}" id="sec-tab-wallboard">📊 Wallboard</button>
            </div>
            <span class="spacer"></span>
            <button class="icon-btn" id="sec-btn-fullscreen" title="Phóng to toàn màn hình (phím F)">📺 Toàn màn hình</button>
            <select class="sel" id="sec-theme-sel" title="Giao diện">
              <option value="neon">Neon</option><option value="dark">Tối</option><option value="light">Sáng</option>
            </select>
          </div>
          <div id="sec-body"></div>
        </div>`;

      $('#sec-theme-sel').value = document.documentElement.dataset.theme;
      $('#sec-theme-sel').onchange = (e) => M.applyTheme(e.target.value);
      $('#sec-btn-fullscreen').onclick = () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
        else document.exitFullscreen?.();
      };

      const switchTab = (t) => {
        secTab = t;
        localStorage.setItem('secondary_tab', t);
        $('#sec-tab-map')?.classList.toggle('primary', t === 'map');
        $('#sec-tab-groups')?.classList.toggle('primary', t === 'groups');
        $('#sec-tab-problems')?.classList.toggle('primary', t === 'problems');
        $('#sec-tab-wallboard')?.classList.toggle('primary', t === 'wallboard');
        this.update(M.S.snap);
      };
      $('#sec-tab-map').onclick = () => switchTab('map');
      $('#sec-tab-groups').onclick = () => switchTab('groups');
      $('#sec-tab-problems').onclick = () => switchTab('problems');
      $('#sec-tab-wallboard').onclick = () => switchTab('wallboard');
      const secBody = $('#sec-body');
      if (secBody) {
        secBody.addEventListener('click', (e) => {
          const node = e.target.closest('.m-node[data-href]');
          if (node && node.dataset.href) {
            location.hash = node.dataset.href;
          }
        });
      }
      this.update(M.S.snap);
    },
    update(snap) {
      if (!snap || !$('#sec-body')) return;
      const s = snap.summary;
      const chip = $('#sec-chip');
      if (chip) chip.textContent = `${s.alive}/${s.total} hoạt động`;
      const body = $('#sec-body');
      const tab = localStorage.getItem('secondary_tab') || 'map';
      if (tab === 'map') {
        if (M.S.maps && M.S.maps.length) {
          body.innerHTML = `<div class="map-box" style="height:calc(100vh - 120px)"><svg id="sec-map-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" style="height:100%"></svg></div>`;
          M.api('GET', `/api/maps/${M.S.maps[0].id}`).then((m) => {
            M.renderMapSvg($('#sec-map-svg'), m);
          }).catch(() => {});
        } else {
          body.innerHTML = '<div class="panel muted" style="padding:40px;text-align:center">Chưa có sơ đồ Topology nào.</div>';
        }
      } else if (tab === 'groups') {
        body.innerHTML = `<div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>`;
      } else if (tab === 'problems') {
        const probs = snap.devices.filter((d) => (d.status === 'down' || d.status === 'warning') && d.severity !== 'none');
        body.innerHTML = probs.length
          ? `<div class="grid">${sortDevices(probs).map(M.tile).join('')}</div>`
          : '<div class="panel" style="text-align:center;padding:40px;border-color:var(--c-ok);color:var(--c-ok)"><h3>✅ Tất cả thiết bị đang hoạt động ổn định</h3></div>';
      } else if (tab === 'wallboard') {
        const k = (cls, label, v, zero, kpiKey, titleHint) => `
          <div class="kpi clickable ${cls} ${zero && !v ? 'zero' : ''}" data-kpi="${kpiKey}" title="${titleHint}">
            <div class="label">${label} <span class="kpi-hint">🔍 Chi tiết</span></div>
            <div class="val">${v}</div>
          </div>`;
        body.innerHTML = `
          <div class="kpis">
            <div class="kpi big clickable" data-kpi="alive" title="Bấm để xem danh sách thiết bị đang hoạt động">
              <div class="label">Thiết bị đang hoạt động <span class="kpi-hint">🔍 Chi tiết</span></div>
              <div class="val">${s.alive}<small>/${s.total}</small></div>
            </div>
            ${k('k-down', 'Mất kết nối', s.down, true, 'down', 'Bấm để xem danh sách thiết bị mất kết nối')}
            ${k('k-warn', 'Cảnh báo', s.warning, true, 'warn', 'Bấm để xem danh sách chi tiết các cảnh báo')}
            ${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance, 'unk', 'Bấm để xem thiết bị chưa rõ hoặc đang bảo trì')}
          </div>
          <div class="grid" style="margin-top:20px">${sortDevices(snap.devices).map(M.tile).join('')}</div>`;
      }
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
      const stat = (label, v) => `<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px">${v}</div><div class="g-label">${label}</div></div>`;

      if (d.type === 'printer') {
        const prn = d.printer || (d.snmp && d.snmp.printer);
        if (d.drum != null) gs.push(M.consumableGauge('Độ bền Drum', d.drum));
        else gs.push(stat('Độ bền Drum', '<span class="muted" style="font-size:18px">Tích hợp</span>'));
        if (d.toner != null) gs.push(M.consumableGauge('Lượng mực in', d.toner));
        else gs.push(stat('Lượng mực in', '<span class="muted" style="font-size:18px">—</span>'));
        if (prn && prn.memory) {
          gs.push(M.gauge('Bộ nhớ RAM', prn.memory.percent, 'ram', `${M.fmtBytes(prn.memory.used)} / ${M.fmtBytes(prn.memory.total)}`));
        } else if (d.ram != null) {
          gs.push(M.gauge('Bộ nhớ RAM', d.ram, 'ram'));
        }
        if (d.page_count != null) {
          gs.push(stat('Tổng số trang in', Number(d.page_count).toLocaleString('vi-VN') + ' trang'));
        }
        if (prn && (prn.display || prn.status_text)) {
          const pSt = prn.display || prn.status_text;
          const pCol = (prn.errors && prn.errors.length) ? 'var(--c-critical)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:18px;font-weight:700;padding:42px 0 6px;color:${pCol}">🖨️ ${esc(pSt)}</div><div class="g-label">Màn hình điều khiển</div></div>`);
        }
        gs.push(stat('Thời gian chạy', M.fmtDur(d.uptime)));
      } else {
        if (d.cpu != null) gs.push(M.gauge('CPU', d.cpu, 'cpu', a && a.cores ? `${a.cores} nhân` : ''));
        if (d.ram != null) gs.push(M.gauge('RAM', d.ram, 'ram', a && a.ram.total ? `${M.fmtBytes(a.ram.used)} / ${M.fmtBytes(a.ram.total)}` : ''));
        if (d.disk != null) gs.push(M.gauge('Ổ đĩa (cao nhất)', d.disk, 'disk'));
        if (d.type === 'ap' || d.total_ssids != null || d.total_clients != null) {
          if (d.total_ssids != null) gs.push(stat('Tổng số SSID', `<span style="color:var(--c-low)">📶 ${d.total_ssids}</span>`));
          if (d.total_clients != null) gs.push(stat('Client kết nối', `<span style="color:var(--c-ok)">👥 ${Number(d.total_clients).toLocaleString('vi-VN')}</span>`));
        }
        gs.push(stat('Thời gian chạy', M.fmtDur(d.uptime)), stat('Ping', d.rtt != null ? `${d.rtt} ms` : '—'));
        if (d.net_in != null || d.net_out != null) {
          const netHtml = `<div style="font-size:18px;font-weight:700;padding:26px 0 2px;line-height:1.3"><span style="color:var(--c-low)" title="Download">↓ ${M.fmtRate(d.net_in || 0)}</span><br><span style="color:var(--c-maint);font-size:15px" title="Upload">↑ ${M.fmtRate(d.net_out || 0)}</span></div>`;
          gs.push(`<div class="gauge">${netHtml}<div class="g-label">Băng thông (Download / Upload)</div></div>`);
        }
        if (d.drum != null) gs.push(M.consumableGauge('Độ bền Drum', d.drum));
        if (d.toner != null) gs.push(M.consumableGauge('Lượng mực in', d.toner));
        if (d.page_count != null) gs.push(stat('Tổng số trang in', Number(d.page_count).toLocaleString('vi-VN') + ' trang'));
        if (d.printer && (d.printer.status_text || d.printer.display)) {
          const pSt = d.printer.display || d.printer.status_text;
          const pCol = (d.printer_errors && d.printer_errors.length) ? 'var(--c-critical)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:18px;font-weight:700;padding:42px 0 6px;color:${pCol}">🖨️ ${esc(pSt)}</div><div class="g-label">Trạng thái máy in</div></div>`);
        }
        if (d.temperature != null) {
          const tTh = (th() && th().temp) || 85;
          const tCol = d.temperature >= tTh ? 'var(--c-critical)' : d.temperature >= tTh - 10 ? 'var(--c-medium)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px;color:${tCol}">${Math.round(d.temperature)}°C</div><div class="g-label">Nhiệt độ CPU</div></div>`);
        } else if (d.type === 'vm' || (d.checks && d.checks.agent)) {
          gs.push(`<div class="gauge"><div style="font-size:24px;font-weight:700;padding:42px 0 6px;color:var(--muted)">N/A</div><div class="g-label">Nhiệt độ CPU (VM)</div></div>`);
        }
        if (d.power) {
          const pState = d.power.on_battery ? 'Đang chạy PIN' : 'Điện lưới AC';
          const pCol = d.power.on_battery ? 'var(--c-critical)' : 'var(--c-ok)';
          const pSub = d.power.battery_percent != null ? `Pin: ${d.power.battery_percent}%` : '';
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:42px 0 6px;color:${pCol}">${d.power.on_battery ? '🔋 ' : '⚡ '}${pState}</div><div class="g-label">Nguồn / UPS${pSub ? `<br>${pSub}` : ''}</div></div>`);
        }
        if (d.smart) {
          const sOk = d.smart.ok !== false;
          const sCol = sOk ? 'var(--c-ok)' : 'var(--c-critical)';
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:42px 0 6px;color:${sCol}">${sOk ? '✅ Bình thường' : '❌ Lỗi SMART'}</div><div class="g-label">Trạng thái đĩa cứng</div></div>`);
        }
        if (d.dos_alert || (d.alerts && d.alerts.dos)) {
          const detail = d.dos_details ? `<div style="font-size:12px;opacity:.85;margin-top:3px">${esc(d.dos_details)}</div>` : '';
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:36px 0 6px;color:var(--c-critical)">🛡️ Cảnh báo DoS</div><div class="g-label">${d.pkt_rate ? `${d.pkt_rate.toLocaleString('vi-VN')} gói/s` : 'Lưu lượng bất thường'}${detail}</div></div>`);
        }
      }
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
      if (d.printer || (d.snmp && d.snmp.printer) || d.type === 'printer') {
        const prn = d.printer || (d.snmp && d.snmp.printer) || {};
        const memStr = prn.memory
          ? `${M.fmtBytes(prn.memory.used)} / ${M.fmtBytes(prn.memory.total)} (${prn.memory.percent}%)`
          : (d.ram != null ? `${d.ram}%` : null);
        const langsStr = (prn.languages && prn.languages.length)
          ? prn.languages.map((l) => `<span class="badge" style="background:var(--panel2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:12px;margin-right:4px">${esc(l)}</span>`).join('')
          : null;

        html += `<h2>Cấu hình sản phẩm & In ấn (Product & Print Settings)</h2><dl class="kv">
          ${kv('Model sản phẩm', prn.model || d.name)}
          ${kv('Số Serial', prn.serial)}
          ${prn.firmware ? kv('Mã Firmware', prn.firmware) : ''}
          ${prn.duplex ? kv('In 2 mặt tự động', prn.duplex) : ''}
          ${memStr ? kv('Bộ nhớ RAM máy in', memStr) : ''}
          ${langsStr ? `<dt>Ngôn ngữ in hỗ trợ</dt><dd>${langsStr}</dd>` : ''}
          ${kv('Màn hình điều khiển LCD', prn.display)}
          ${kv('Trạng thái thiết bị', prn.status_text)}
          ${kv('Tổng trang đã in (Impressions)', (prn.page_count != null || d.page_count != null) ? `${Number(prn.page_count ?? d.page_count).toLocaleString('vi-VN')} trang` : '—')}
        </dl>`;

        if (prn.errors && prn.errors.length) {
          html += `<div class="reason" style="margin:8px 0;background:rgba(239,68,68,0.15);padding:10px 14px;border-radius:6px;border:1px solid var(--c-critical);color:var(--text)">
            <b style="color:var(--c-critical)">⚠️ Sự cố máy in phát hiện:</b><br>${prn.errors.map((e) => `• ${esc(e)}`).join('<br>')}
          </div>`;
        }

        if (prn.supplies && prn.supplies.length) {
          html += `<h2>Vật tư tiêu hao (Mực in & Cụm trống Drum)</h2>
          <table class="tbl"><thead><tr><th>Tên vật tư</th><th>Phân loại</th><th>Mức còn lại</th><th>Dung lượng</th></tr></thead><tbody>
          ${prn.supplies.map((s) => {
            const kindName = { toner: 'Hộp mực (Toner)', drum: 'Cụm trống (Drum)', waste: 'Hộp mực thải', fuser: 'Cụm sấy (Fuser)', transfer: 'Băng tải' }[s.kind] || 'Vật tư khác';
            const col = s.kind === 'drum' ? 'var(--c-maint)' : (s.percent != null && s.percent <= 10 ? 'var(--c-critical)' : (s.percent != null && s.percent <= 25 ? 'var(--c-medium)' : 'var(--c-ok)'));
            const barHtml = s.percent != null
              ? `<div class="bar" style="width:110px">${s.percent}%<i><b style="width:${s.percent}%;background:${col}"></b></i></div>`
              : (s.status || '—');
            const capText = (s.level != null && s.max != null && s.max > 0 && s.level >= 0) ? `${Number(s.level).toLocaleString('vi-VN')} / ${Number(s.max).toLocaleString('vi-VN')}` : (s.status || '—');
            return `<tr><td><b>${esc(s.name)}</b></td><td><span class="muted">${kindName}</span></td><td>${barHtml}</td><td>${esc(capText)}</td></tr>`;
          }).join('')}
          </tbody></table>`;
        }

        if (prn.trays && prn.trays.length) {
          html += `<h2>Cấu hình khay nạp giấy & Giấy in (Paper Settings)</h2>
          <table class="tbl"><thead><tr><th>Khay nạp</th><th>Loại giấy (Media)</th><th>Khổ giấy</th><th>Tình trạng</th><th>Sức chứa</th></tr></thead><tbody>
          ${prn.trays.map((t) => {
            const isWarn = t.status === 'Hết giấy';
            const stBadge = isWarn
              ? `<span style="color:var(--c-critical);font-weight:700">⚠️ ${esc(t.status)}</span>`
              : `<span style="color:var(--c-ok)">${esc(t.status)}</span>`;
            return `<tr><td><b>${esc(t.name)}</b></td><td>${esc(t.media_type || 'Mặc định')}</td><td>${esc(t.media_name || 'A4 / Mặc định')}</td><td>${stBadge}</td><td>${t.max != null && t.max > 0 ? `${t.max} tờ` : '—'}</td></tr>`;
          }).join('')}
          </tbody></table>`;
        }
      }
      if (d.type === 'ap' || d.ap || (d.snmp && d.snmp.ap)) {
        const ap = d.ap || (d.snmp && d.snmp.ap) || {};
        const ssids = ap.ssids || [];
        const arpTable = ap.arp_table || [];

        const bandSummary = ap.by_band && Object.keys(ap.by_band).length > 1
          ? Object.entries(ap.by_band).map(([b, info]) => `${b}: ${info.count} SSID (${info.clients} client)`).join(' · ')
          : '';

        html += `<h2>Thông tin mạng không dây & SSID (Wireless Networks)</h2>
          <dl class="kv">
            ${kv('Tổng số SSID phát sóng', ap.total_ssids != null ? `${ap.total_ssids} SSID` : (d.total_ssids != null ? `${d.total_ssids} SSID` : '—'))}
            ${kv('Tổng số Client đang kết nối', ap.total_clients != null ? `${Number(ap.total_clients).toLocaleString('vi-VN')} thiết bị (tính trên các SSID)` : (d.total_clients != null ? `${Number(d.total_clients).toLocaleString('vi-VN')} thiết bị` : '—'))}
            ${bandSummary ? kv('Phân bổ theo băng tần', bandSummary) : ''}
            ${kv('Bảng theo dõi ARP', ap.has_arp ? `Có hỗ trợ (${arpTable.length} thiết bị ghi nhận)` : 'Không có dữ liệu ARP')}
          </dl>`;

        if (ssids.length) {
          const totCli = ap.total_clients || 1;
          const ssidCountLabel = ap.total_ssids != null ? `${ap.total_ssids} SSID` : `${ssids.length} SSID`;
          html += `<h2>Chi tiết các SSID & Số lượng Client kết nối (${ssidCountLabel})</h2>
          <table class="tbl"><thead><tr><th>Tên SSID</th><th>BSSID (MAC phát sóng)</th><th>Băng tần (Band)</th><th>Kênh</th><th>Client kết nối</th><th>Tỷ lệ Client</th></tr></thead><tbody>
          ${ssids.map((s) => {
            const pct = Math.min(100, Math.round(((s.clients || 0) / totCli) * 100));
            const barHtml = `<div class="bar" style="width:110px">${s.clients || 0} client<i><b style="width:${pct}%;background:var(--c-ok)"></b></i></div>`;
            return `<tr>
              <td><b>📶 ${esc(s.ssid)}</b></td>
              <td><code>${esc(s.bssid || '—')}</code></td>
              <td><span class="badge" style="background:var(--panel2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:12px">${esc(s.band || 'Mặc định')}</span></td>
              <td>${s.channel != null ? `CH ${s.channel}` : '—'}</td>
              <td><b style="color:var(--c-ok);font-size:14px">${Number(s.clients || 0).toLocaleString('vi-VN')}</b> client</td>
              <td>${barHtml}</td>
            </tr>`;
          }).join('')}
          </tbody></table>`;
        }

        const arpCountLabel = arpTable.length ? ` (${arpTable.length} thiết bị)` : '';
        html += `<h2>Bảng theo dõi ARP & Thiết bị kết nối${arpCountLabel}</h2>
        <div class="ap-arp-note">
          <span class="note-icon">ℹ️</span>
          <div class="note-content">
            <b>Lưu ý:</b> Bảng ARP thu thập qua SNMP trên thiết bị AP có tính chất cục bộ (Local ARP Cache) và bị giới hạn bởi giao thức. Danh sách này phản ánh các thiết bị có giao tiếp Layer 3 trong mạng (như Gateway hoặc thiết bị cùng phân vầng), do đó có thể không hiển thị đầy đủ hoặc chính xác tuyệt đối IP và Hostname của tất cả các Client đang kết nối WiFi.
          </div>
        </div>`;

        if (arpTable.length) {
          html += `<div style="margin-bottom:8px">
            <input class="inp" id="arp-search-inp" placeholder="🔍 Tìm kiếm theo IP, MAC, Domain name / Hostname, SSID..." style="width:100%;max-width:380px">
          </div>
          <div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
          <table class="tbl" id="arp-table-el" style="margin:0"><thead><tr style="position:sticky;top:0;background:var(--panel);z-index:2">
            <th>Địa chỉ IP</th><th>Địa chỉ MAC</th><th>Tên miền / Hostname</th><th>SSID kết nối</th><th>Giao diện</th><th>Phân loại</th>
          </tr></thead><tbody>
          ${arpTable.map((a) => {
            const host = a.hostname ? `<b style="color:var(--text)">${esc(a.hostname)}</b>` : '<span class="muted">—</span>';
            const ssidBadge = a.ssid ? `<span class="badge" style="background:var(--panel2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--c-low)">📶 ${esc(a.ssid)}</span>` : '<span class="muted">—</span>';
            const typeCol = a.type === 'Dynamic (Động)' || a.type === 'Dynamic' ? 'var(--c-ok)' : (a.type && a.type.includes('Wireless') ? 'var(--c-low)' : 'var(--muted)');
            return `<tr class="arp-row" data-q="${esc(`${a.ip} ${a.mac} ${a.hostname || ''} ${a.ssid || ''}`.toLowerCase())}">
              <td><code><b>${esc(a.ip)}</b></code></td>
              <td><code>${esc(a.mac)}</code></td>
              <td>${host}</td>
              <td>${ssidBadge}</td>
              <td><span class="muted">${esc(a.interface || '—')}</span></td>
              <td><span style="color:${typeCol};font-weight:600">${esc(a.type || 'Dynamic')}</span></td>
            </tr>`;
          }).join('')}
          </tbody></table></div>`;
        } else {
          html += `<div class="muted" style="padding:10px 0">Thiết bị hiện chưa ghi nhận bản ghi ARP nào hoặc không có dữ liệu phản hồi từ SNMP.</div>`;
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
        const searchInp = $('#arp-search-inp');
        if (searchInp) {
          searchInp.oninput = () => {
            const q = searchInp.value.toLowerCase().trim();
            const rows = $$('.arp-row');
            for (const row of rows) {
              const text = row.getAttribute('data-q') || '';
              row.style.display = (!q || text.includes(q)) ? '' : 'none';
            }
          };
        }
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
      if (this.D && this.D.type === 'printer') {
        if (has('toner') || has('drum')) {
          const pSeries = [];
          if (has('toner')) pSeries.push({ key: 'toner', color: 'var(--c-low)', label: 'Mực in (%)' });
          if (has('drum')) pSeries.push({ key: 'drum', color: 'var(--c-maint)', label: 'Độ bền Drum (%)' });
          html += `<h2>Lịch sử tiêu hao Vật tư (Mực in & Drum %)</h2>${M.chart(points, pSeries, this.range, 100)}`;
        }
        if (has('ram')) {
          html += `<h2>Lịch sử sử dụng Bộ nhớ máy in (RAM %)</h2>${M.chart(points, [{ key: 'ram', color: 'var(--c-medium)', label: 'RAM máy in (%)' }], this.range, 100)}`;
        }
      } else {
        if (has('cpu')) html += `<h2>CPU / RAM / Ổ đĩa (%)</h2>${M.chart(points, [{ key: 'cpu', color: 'var(--c-low)', label: 'CPU' }, { key: 'ram', color: 'var(--c-medium)', label: 'RAM' }, { key: 'disk', color: 'var(--c-high)', label: 'Disk' }], this.range, 100)}`;
        if (has('rtt')) html += `<h2>Độ trễ ping (ms)</h2>${M.chart(points, [{ key: 'rtt', color: 'var(--c-ok)', label: 'RTT' }], this.range)}`;
        if (has('net_in') || has('net_out')) {
          html += `<h2>Tổng băng thông sử dụng</h2>${M.chart(points, [
            { key: 'net_in', color: 'var(--c-low)', label: 'Download' },
            { key: 'net_out', color: 'var(--c-maint)', label: 'Upload' },
          ], this.range, null, M.fmtRate)}`;
        }
        if (has('temp')) {
          html += `<h2>Nhiệt độ CPU (°C)</h2>${M.chart(points, [{ key: 'temp', color: 'var(--c-high)', label: 'Nhiệt độ (°C)' }], this.range, 120, (v) => `${Math.round(v)}°`)}`;
        }
        if (has('toner') || has('drum')) {
          const pSeries = [];
          if (has('toner')) pSeries.push({ key: 'toner', color: 'var(--c-low)', label: 'Mực in (%)' });
          if (has('drum')) pSeries.push({ key: 'drum', color: 'var(--c-maint)', label: 'Độ bền Drum (%)' });
          html += `<h2>Lịch sử Mực in & Độ bền Drum (%)</h2>${M.chart(points, pSeries, this.range, 100)}`;
        }
      }
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
        <select class="sel" id="ev-kind"><option value="">Tất cả</option><option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="dos">Tấn công DoS</option><option value="power">Mất điện lưới</option><option value="smart">Lỗi đĩa cứng</option><option value="thermal">Quá nhiệt</option><option value="up">Phục hồi</option><option value="audit">Hệ thống</option></select></div>
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

  // ---------- KPI details popup ----------
  function getDeviceAlertDetails(d) {
    const items = [];
    const thConf = (typeof th === 'function' ? th() : null) || (M.S.settings && M.S.settings.thresholds) || { cpu: 90, ram: 90, disk: 90, temp: 85 };

    // 1. Deep monitoring flags
    if ((d.alerts && d.alerts.dos) || d.dos_alert) {
      const ppsStr = d.pkt_rate ? `${d.pkt_rate.toLocaleString('vi-VN')} gói/giây` : 'Lưu lượng cao';
      const detailStr = d.dos_details ? ` - ${d.dos_details}` : '';
      items.push({ icon: '🛡️', title: 'Tấn công Flood/DoS', text: `Nghi ngờ tấn công mạng (lưu lượng ${ppsStr}${detailStr})`, cls: 'crit' });
    }
    if ((d.alerts && d.alerts.power) || (d.power && d.power.on_battery)) {
      const bat = d.power && d.power.battery_percent != null ? ` (pin còn ${d.power.battery_percent}%)` : '';
      items.push({ icon: '🔋', title: 'Mất điện lưới', text: `Đang chạy nguồn pin dự phòng UPS${bat}`, cls: 'crit' });
    }
    if ((d.alerts && d.alerts.smart) || (d.smart && d.smart.ok === false)) {
      items.push({ icon: '💾', title: 'Lỗi ổ đĩa SMART', text: (d.smart && d.smart.details) || 'Phát hiện Bad Sector hoặc đĩa sắp hỏng', cls: 'crit' });
    }
    if ((d.alerts && d.alerts.thermal) || (d.temperature != null && d.temperature >= thConf.temp)) {
      items.push({ icon: '🔥', title: 'Nhiệt độ CPU quá cao', text: `Nhiệt độ hiện tại: ${Math.round(d.temperature)}°C (vượt ngưỡng an toàn ${thConf.temp}°C)`, cls: 'crit' });
    }

    // 2. Printer specific alerts
    if (d.printer_errors && d.printer_errors.length) {
      d.printer_errors.forEach((err) => {
        items.push({ icon: '⚠️', title: 'Sự cố máy in', text: err, cls: 'crit' });
      });
    }
    if (d.toner != null && d.toner >= 0 && d.toner <= 10) {
      items.push({ icon: '🖨️', title: 'Lượng mực in sắp hết', text: `Hộp mực chỉ còn ${d.toner}%, cần chuẩn bị mực thay thế`, cls: d.toner === 0 ? 'crit' : 'hi' });
    }
    if (d.drum != null && d.drum >= 0 && d.drum <= 10) {
      items.push({ icon: '🔄', title: 'Tuổi thọ Drum sắp hết', text: `Độ bền trống từ chỉ còn ${d.drum}%, cần thay drum`, cls: d.drum === 0 ? 'crit' : 'hi' });
    }

    // 3. Reasons (thresholds, agent silence, ICMP, etc.)
    if (d.reasons && d.reasons.length) {
      d.reasons.forEach((r) => {
        const isDup = items.some((it) => it.text.includes(r) || r.includes(it.title) || it.title.includes(r));
        if (!isDup) {
          const isCrit = r.toLowerCase().includes('critical') || r.toLowerCase().includes('khẩn');
          items.push({ icon: '⚠️', title: 'Cảnh báo hệ thống', text: r, cls: isCrit ? 'crit' : 'hi' });
        }
      });
    }

    if (!items.length && d.status === 'warning') {
      items.push({ icon: '⚠️', title: 'Cảnh báo', text: 'Thiết bị đang ghi nhận cảnh báo hoạt động', cls: 'hi' });
    }

    return items;
  }

  M.showKpiModal = (kpiKey, snap) => {
    if (!snap) snap = M.S.snap || { devices: [], summary: {} };
    const allDevs = snap.devices || [];

    let title = '';
    let list = [];
    let emptyIcon = '✅';
    let emptyTitle = '';
    let emptyText = '';
    let isWarningModal = false;

    if (kpiKey === 'down') {
      title = 'Thiết bị Mất kết nối';
      list = allDevs.filter((d) => d.status === 'down');
      emptyIcon = '✅';
      emptyTitle = 'Tất cả thiết bị đang kết nối tốt!';
      emptyText = 'Hiện tại không có thiết bị nào bị ngắt kết nối mạng hoặc mất tín hiệu.';
    } else if (kpiKey === 'warn') {
      title = 'Thiết bị đang Cảnh báo';
      isWarningModal = true;
      list = allDevs.filter((d) => {
        if (d.severity === 'none') return false;
        if (d.status === 'warning') return true;
        const hasCritAlert = d.alerts && (d.alerts.dos || d.alerts.smart || d.alerts.thermal || d.alerts.power || d.alerts.printer);
        const hasSupplyAlert = (d.toner != null && d.toner >= 0 && d.toner <= 10) || (d.drum != null && d.drum >= 0 && d.drum <= 10);
        const hasPrinterErr = d.printer_errors && d.printer_errors.length;
        return hasCritAlert || hasSupplyAlert || hasPrinterErr;
      });
      emptyIcon = '🎉';
      emptyTitle = 'Hệ thống an toàn, không có cảnh báo!';
      emptyText = 'Tất cả thông số vận hành (CPU, RAM, Đĩa, Mực in, Drum, Cảm biến,...) đều ở mức an toàn.';
    } else if (kpiKey === 'unk') {
      title = 'Thiết bị Chưa rõ / Bảo trì';
      list = allDevs.filter((d) => d.status === 'unknown' || d.status === 'maint');
      emptyIcon = '👌';
      emptyTitle = 'Không có thiết bị cần lưu ý!';
      emptyText = 'Hiện không có thiết bị nào đang trong chế độ bảo trì hoặc chưa rõ dữ liệu.';
    } else {
      title = 'Thiết bị đang Hoạt động';
      list = allDevs.filter((d) => d.status === 'up' || d.status === 'warning');
      emptyIcon = 'ℹ️';
      emptyTitle = 'Chưa có thiết bị nào hoạt động';
      emptyText = 'Hãy kiểm tra lại danh sách thiết bị hoặc thêm thiết bị mới vào hệ thống.';
    }

    let bodyHtml = '';
    if (!list.length) {
      bodyHtml = `
        <div class="kpi-empty-box">
          <div class="kpi-empty-icon">${emptyIcon}</div>
          <b style="font-size:16px">${esc(emptyTitle)}</b>
          <span>${esc(emptyText)}</span>
        </div>`;
    } else {
      const searchBox = list.length > 3
        ? `<div style="margin-bottom:12px"><input class="inp" id="kpi-modal-search" placeholder="🔍 Lọc thiết bị theo tên, IP, loại..." style="width:100%"></div>`
        : '';

      const itemsHtml = list.map((d) => {
        const typeIcon = M.ICON[d.type] || '📟';
        const typeName = M.TYPE_NAME[d.type] || d.type;

        let statusBadge = '';
        if (d.status === 'down') {
          statusBadge = `<span class="sev-badge critical">Mất kết nối</span>`;
        } else if (d.status === 'warning') {
          statusBadge = `<span class="sev-badge medium">Cảnh báo</span>`;
        } else if (d.status === 'maint') {
          statusBadge = `<span class="sev-badge" style="background:var(--c-maint);color:#fff">Bảo trì</span>`;
        } else if (d.status === 'unknown') {
          statusBadge = `<span class="sev-badge none">Chưa rõ</span>`;
        } else {
          statusBadge = `<span class="sev-badge ok">Online</span>`;
        }

        let detailSection = '';
        if (kpiKey === 'down') {
          const ago = M.fmtDur((Date.now() - d.since) / 1000);
          const reason = (d.reasons && d.reasons.length) ? d.reasons.join(' · ') : 'Không phản hồi ICMP / Mất tín hiệu agent';
          detailSection = `
            <div class="kpi-alert-list">
              <div class="kpi-alert-item crit">
                <span class="kpi-alert-item-icon">⚠️</span>
                <div>
                  <span class="kpi-alert-item-title">Lý do:</span>
                  <span class="kpi-alert-item-text">${esc(reason)}</span>
                </div>
              </div>
              <div class="muted" style="font-size:12px">Mất kết nối từ: <b>${ago}</b> trước (lúc ${M.fmtTime(d.since)})</div>
            </div>`;
        } else if (isWarningModal) {
          const alerts = getDeviceAlertDetails(d);
          detailSection = `
            <div class="kpi-alert-list">
              ${alerts.map((it) => `
                <div class="kpi-alert-item ${it.cls || ''}">
                  <span class="kpi-alert-item-icon">${it.icon}</span>
                  <div>
                    <span class="kpi-alert-item-title">${esc(it.title)}:</span>
                    <span class="kpi-alert-item-text">${esc(it.text)}</span>
                  </div>
                </div>`).join('')}
            </div>`;
        } else if (kpiKey === 'unk') {
          const desc = d.status === 'maint'
            ? 'Thiết bị đang đặt ở chế độ bảo trì (đã tạm ngắt cảnh báo âm thanh & thông báo).'
            : 'Chưa nhận được dữ liệu giám sát hoặc thiết bị mới được thêm vào.';
          detailSection = `<div class="muted" style="font-size:13px">${esc(desc)}</div>`;
        } else {
          const parts = [];
          if (d.rtt != null) parts.push(`Ping: ${d.rtt} ms`);
          if (d.uptime != null) parts.push(`Uptime: ${M.fmtDur(d.uptime)}`);
          if (d.type === 'printer') {
            if (d.toner != null) parts.push(`Mực: ${d.toner}%`);
            if (d.drum != null) parts.push(`Drum: ${d.drum}%`);
            if (d.page_count != null) parts.push(`${Number(d.page_count).toLocaleString('vi-VN')} trang`);
          } else {
            if (d.cpu != null) parts.push(`CPU: ${Math.round(d.cpu)}%`);
            if (d.ram != null) parts.push(`RAM: ${Math.round(d.ram)}%`);
            if (d.disk != null) parts.push(`Disk: ${Math.round(d.disk)}%`);
            if (d.temperature != null) parts.push(`Temp: ${Math.round(d.temperature)}°C`);
          }
          detailSection = `<div class="muted" style="font-size:13px">${esc(parts.join(' · ') || 'Đang phản hồi tốt')}</div>`;
        }

        return `
          <div class="kpi-dev-item">
            <div class="kpi-dev-top">
              <div class="kpi-dev-main">
                <span style="font-size:18px">${typeIcon}</span>
                <a href="#/device/${d.id}" class="kpi-dev-name" title="${esc(d.name)}">${esc(d.name)}</a>
                ${statusBadge}
              </div>
              <a href="#/device/${d.id}" class="btn sm">Xem chi tiết →</a>
            </div>
            <div class="kpi-dev-meta">${esc(d.address)} · ${typeName}${d.location ? ` · ${esc(d.location)}` : ''}</div>
            ${detailSection}
          </div>`;
      }).join('');

      bodyHtml = `
        <div class="kpi-modal-head">
          <span class="muted" style="font-size:14px">Hiển thị <b>${list.length}</b> thiết bị</span>
        </div>
        ${searchBox}
        <div class="kpi-modal-list">${itemsHtml}</div>`;
    }

    const { form } = M.modal(
      `${title} (${list.length})`,
      bodyHtml,
      async () => {},
      { submit: 'Đóng', noCancel: true, wide: true }
    );

    const sInp = $('#kpi-modal-search', form);
    if (sInp) {
      sInp.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        $$('.kpi-dev-item', form).forEach((el) => {
          el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
      setTimeout(() => sInp.focus(), 80);
    }
  };

  document.addEventListener('click', (e) => {
    const kpiEl = e.target.closest('.kpi[data-kpi]');
    if (kpiEl && kpiEl.dataset.kpi) {
      M.showKpiModal(kpiEl.dataset.kpi, M.S.snap);
    }
  });
})();
