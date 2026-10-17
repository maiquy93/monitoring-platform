'use strict';
(() => {
  const { esc, $, $$ } = M;
  const t = (s) => M.t(s);
  const tr = (s) => M.trData(s);
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
    const numLoc = M.S.lang === 'en' ? 'en-US' : 'vi-VN';
    let sub;
    if (d.status === 'down') sub = `${tr(d.reasons[0] || t('Mất kết nối'))} · ${ago}`;
    else if (d.status === 'maint') sub = t('Đang bảo trì (tắt cảnh báo)');
    else if (d.status === 'unknown') sub = t('Chưa có dữ liệu');
    else if (d.type === 'printer') {
      const parts = [d.address];
      if (d.printer_status) parts.push(tr(d.printer_status));
      if (d.page_count != null) parts.push(`${Number(d.page_count).toLocaleString(numLoc)} ${t('trang')}`);
      if (d.printer_errors && d.printer_errors.length && !d.mute_local_alerts) parts.unshift(tr(d.printer_errors[0]));
      sub = parts.filter(Boolean).join(' · ');
    } else if (d.type === 'ap') {
      const parts = [d.address];
      if (d.status === 'warning' && d.reasons && d.reasons.length) parts.push(tr(d.reasons[0]));
      if (d.total_ssids != null || d.total_clients != null) {
        const s = d.total_ssids != null ? `${d.total_ssids} SSID` : '';
        const c = d.total_clients != null ? `${d.total_clients} client` : '';
        const wifi = s && c ? `${s} - ${c}` : (s || c);
        if (wifi) parts.push(wifi);
      }
      if (d.uptime != null) parts.push(`up ${M.fmtDur(d.uptime)}`);
      sub = parts.filter(Boolean).join(' · ');
    } else if (d.status === 'warning') sub = tr(d.reasons[0]);
    else {
      const parts = [d.address];
      if (d.total_ssids != null || d.total_clients != null) {
        const s = d.total_ssids != null ? `${d.total_ssids} SSID` : '';
        const c = d.total_clients != null ? `${d.total_clients} client` : '';
        const wifi = s && c ? `${s} - ${c}` : (s || c);
        if (wifi) parts.push(wifi);
      }
      if (d.uptime != null) parts.push(`up ${M.fmtDur(d.uptime)}`);
      sub = parts.filter(Boolean).join(' · ');
    }
    let bars = '';
    if (d.status === 'up' || d.status === 'warning') {
      const pBars = [];
      if (d.type === 'ap') {
        const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram']].filter(([, value]) => value != null);
        for (const [lbl, val, k] of metrics) pBars.push(bar(lbl, val, k));
        if (pBars.length) bars = `<div class="bars">${pBars.join('')}</div>`;
      } else if (d.type === 'printer') {
        // 1. Drum (tuổi thọ trống từ)
        if (d.drum != null) {
          const lv = d.drum <= 10 ? 'crit' : d.drum <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Drum ${Math.round(d.drum)}%<i><b style="width:${Math.min(100, Math.max(0, d.drum))}%"></b></i></div>`);
        } else {
          pBars.push(`<div class="bar bar-na" title="${esc(t('Hộp mực tích hợp (all-in-one) hoặc không có cảm biến drum riêng'))}">Drum —<i><b style="width:0%"></b></i></div>`);
        }
        // 2. Mực (lượng mực còn lại)
        if (d.toner != null) {
          const lv = d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">${esc(t('Mực'))} ${Math.round(d.toner)}%<i><b style="width:${Math.min(100, Math.max(0, d.toner))}%"></b></i></div>`);
        } else {
          pBars.push(`<div class="bar bar-na" title="${esc(t('Không đọc được dữ liệu mức mực'))}">${esc(t('Mực'))} —<i><b style="width:0%"></b></i></div>`);
        }
        bars = `<div class="bars">${pBars.join('')}</div>`;
      } else {
        if (d.drum != null) {
          const lv = d.drum <= 10 ? 'crit' : d.drum <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">Drum ${Math.round(d.drum)}%<i><b style="width:${Math.min(100, Math.max(0, d.drum))}%"></b></i></div>`);
        }
        if (d.toner != null) {
          const lv = d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : '';
          pBars.push(`<div class="bar ${lv}">${esc(t('Mực'))} ${Math.round(d.toner)}%<i><b style="width:${Math.min(100, Math.max(0, d.toner))}%"></b></i></div>`);
        }
        const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram'], ['Disk', d.disk, 'disk']]
          .filter(([, value]) => value != null);
        const metricBars = metrics.map(([label, value, key]) => bar(label, value, key));
        if (d.temperature != null) {
          const tTh = (th() && th().temp) || 85;
          const tLv = d.temperature >= tTh ? 'crit' : d.temperature >= tTh - 10 ? 'hi' : '';
          metricBars.push(`<div class="bar ${tLv}">Temp ${Math.round(d.temperature)}°C<i><b style="width:${Math.min(100, Math.max(0, d.temperature))}%"></b></i></div>`);
        } else if (d.type === 'vm' || d.type === 'server' || (d.checks && d.checks.agent)) {
          metricBars.push(`<div class="bar bar-na" title="${esc(t('Môi trường máy ảo (VM) hoặc phần cứng không có cảm biến nhiệt'))}">Temp —<i><b style="width:0%"></b></i></div>`);
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
        const titleStr = tr(`Nghi ngờ tấn công Flood/DoS${d.pkt_rate ? ` (${d.pkt_rate.toLocaleString(numLoc)} gói/s)` : ''}${d.dos_details ? ` · ${d.dos_details}` : ''}`);
        items.push(`<span class="t-badge-alert alert-dos" title="${esc(titleStr)}">🛡️ DoS${ppsStr}</span>`);
      }
      if (al.power || (d.power && d.power.on_battery)) {
        const pct = d.power && d.power.battery_percent != null ? ` ${d.power.battery_percent}%` : '';
        const pwrTitle = M.S.lang === 'en' ? `AC Power Loss - Running on UPS battery${pct}` : `Mất điện lưới - Đang dùng pin UPS${pct}`;
        items.push(`<span class="t-badge-alert alert-power" title="${esc(pwrTitle)}">${esc(t('🔋 Mất điện'))}${pct}</span>`);
      }
      if (al.smart || (d.smart && d.smart.ok === false)) {
        const smTitle = M.S.lang === 'en'
          ? `Disk SMART / Bad Sector error${d.smart && d.smart.details ? `: ${d.smart.details}` : ''}`
          : `Cảnh báo đĩa cứng SMART lỗi / Bad Sector${d.smart && d.smart.details ? `: ${d.smart.details}` : ''}`;
        items.push(`<span class="t-badge-alert alert-smart" title="${esc(smTitle)}">${esc(t('💾 Lỗi đĩa'))}</span>`);
      }
      if (al.thermal || (d.temperature != null && d.temperature >= ((th() && th().temp) || 85))) {
        items.push(`<span class="t-badge-alert alert-thermal" title="${esc(t('Báo động nhiệt độ CPU quá cao (Thermal Throttling)'))}">🔥 ${Math.round(d.temperature)}°C</span>`);
      }
      if (al.printer || (d.printer_errors && d.printer_errors.length)) {
        const errText = d.printer_errors && d.printer_errors.length ? tr(d.printer_errors[0]) : t('Sự cố máy in');
        const fullErr = d.printer_errors ? d.printer_errors.map(tr).join('; ') : errText;
        items.push(`<span class="t-badge-alert alert-printer" title="${esc(fullErr)}">⚠️ ${esc(errText)}</span>`);
      }
      if (d.toner != null && d.toner >= 0 && d.toner <= 10) {
        const tnTitle = M.S.lang === 'en' ? `Toner low: ${d.toner}% remaining` : `Hộp mực sắp hết: còn ${d.toner}%`;
        items.push(`<span class="t-badge-alert alert-power" title="${esc(tnTitle)}">🖨️ ${esc(t('Mực'))} ${d.toner}%</span>`);
      }
      if (d.drum != null && d.drum >= 0 && d.drum <= 10) {
        const drTitle = M.S.lang === 'en' ? `Drum unit low: ${d.drum}% remaining, replace soon` : `Cụm drum sắp hết hạn: còn ${d.drum}%, cần thay drum`;
        items.push(`<span class="t-badge-alert alert-smart" title="${esc(drTitle)}">🔄 Drum ${d.drum}%</span>`);
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
    const stText = s.down ? `${s.down} down` : s.warning ? `${s.warning} ${t('cảnh báo')}` : s.total ? t('Ổn định') : t('Trống');
    return `<a class="tile group ${cls}" href="#/group/${g.id}"><div class="t-top"><span class="t-ico">🗂️</span>
      <span class="t-name">${esc(g.name)}</span><span class="t-state">${esc(stText)}</span></div>
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
    if (pts.length < 2) return `<div class="muted" style="padding:30px;text-align:center">${esc(t('Chưa đủ dữ liệu lịch sử'))}</div>`;
    const x0 = pts[0].ts, x1 = pts[pts.length - 1].ts;
    const yMax = max || Math.max(1, ...series.flatMap((s) => pts.map((p) => p[s.key] ?? 0))) * 1.2;
    const sx = (tVal) => L + (W - L - R) * ((tVal - x0) / (x1 - x0 || 1));
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
    const loc = M.S.lang === 'en' ? 'en-US' : 'vi-VN';
    const fmt = (tVal) => new Date(tVal).toLocaleString(loc, range === '7d' || range === '24h' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    const formatY = fmtY || ((v) => Math.round(v));
    const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${sy(yMax * f)}" y2="${sy(yMax * f)}"/><text x="${L - 4}" y="${sy(yMax * f) + 3}" text-anchor="end">${formatY(yMax * f)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}
      <text x="${L}" y="${H - 4}">${fmt(x0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text></svg>
      <div class="legend">${series.map((s) => `<span style="--lc:${s.color}">${s.label}</span>`).join('')}</div>`;
  };

  M.renderAiReportCard = (r, showHeader = true) => {
    const isEn = M.S.lang === 'en';
    if (!r || typeof r !== 'object') {
      return `<div class="muted" style="padding:14px;text-align:center">${isEn ? 'No AI diagnosis data available' : 'Chưa có dữ liệu chẩn đoán AI'}</div>`;
    }
    const isDaily = r.kind === 'daily';
    const tokTotal = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const srcBadge = r.cached
      ? `<span class="sev-badge low" title="${isEn ? 'Reused from deduplication cache (0 tokens spent)' : 'Tái sử dụng từ bộ nhớ đệm chống trùng lặp (0 token)'}">⚡ ${isEn ? 'Cached (0 tokens)' : 'Cache (0 token)'}</span>`
      : r.source === 'ai'
        ? `<span class="sev-badge ok">🤖 AI API (${tokTotal} tokens)</span>`
        : `<span class="sev-badge medium" title="${isEn ? 'Zero-token local expert analysis' : 'Phân tích từ bộ quy tắc chuyên gia nội bộ (0 token)'}">🧠 ${isEn ? 'Smart Engine (0 tokens)' : 'Chuyên gia nội bộ (0 token)'}</span>`;
    const kindBadge = isDaily
      ? `<span class="sev-badge low">📊 ${isEn ? 'Daily Digest (24h)' : 'Tổng hợp cuối ngày (24h)'}</span>`
      : `<span class="sev-badge ${r.severity || 'high'}">🚨 ${isEn ? 'Incident Diagnosis' : 'Chẩn đoán sự cố'}</span>`;
    const devLink = r.device_id
      ? `<a href="#/device/${r.device_id}"><b>${esc(r.device_name)}</b></a>`
      : `<b>${esc(tr(r.device_name || (isEn ? 'System' : 'Hệ thống')))}</b>`;

    const hasLogTarget = (r.event_id || r.device_id) && !isDaily;
    const copyLogBtnHtml = hasLogTarget
      ? `<button type="button" class="btn sm tech-copy" data-ai-copy-logs="${r.event_id || ''}" data-dev-id="${r.device_id || ''}" style="padding:1px 8px;font-size:11px;margin-right:6px" title="${isEn ? 'Copy technical diagnostic logs to clipboard for ChatGPT / Claude / Gemini' : 'Sao chép logs kỹ thuật để tra cứu trên ChatGPT / Claude / Gemini'}">📋 ${isEn ? 'Copy Tech Logs' : 'Copy Logs Kỹ thuật'}</button>`
      : '';

    return `<div class="ai-card ${isDaily ? 'daily' : ''}">
      ${showHeader ? `<div class="ai-card-head">
        ${kindBadge} ${devLink}
        <span class="muted">· ${M.fmtTime(r.ts)}</span>
        <span class="spacer"></span>
        ${copyLogBtnHtml}
        ${srcBadge}
      </div>` : `<div class="ai-card-head" style="margin-bottom:6px">
        <b>🤖 ${isEn ? 'AI Diagnosis & Remediation' : 'AI Chẩn đoán & Đề xuất xử lý'}</b>
        <span class="muted">· ${M.fmtTime(r.ts)}</span>
        <span class="spacer"></span>
        ${copyLogBtnHtml}
        ${srcBadge}
        ${r.event_id ? `<button type="button" class="btn sm" data-ai-toggle="${r.event_id}" style="padding:1px 7px;font-size:11px;margin-left:6px" title="${isEn ? 'Collapse AI report' : 'Thu gọn bảng phân tích AI'}">▲ ${isEn ? 'Collapse' : 'Thu gọn'}</button>` : ''}
      </div>`}
      <div class="ai-grid">
        <div class="ai-box">
          <div class="ai-box-title">🔴 ${isEn ? 'Issue / Problem' : 'Vấn đề (Issue)'}</div>
          <div>${esc(r.issue || '—')}</div>
        </div>
        <div class="ai-box">
          <div class="ai-box-title">🔍 ${isEn ? 'Root Cause' : 'Nguyên nhân (Cause)'}</div>
          <div>${esc(r.cause || '—')}</div>
        </div>
        <div class="ai-box">
          <div class="ai-box-title">🛠️ ${isEn ? 'Recommended Solution' : 'Giải pháp đề xuất (Solution)'}</div>
          <div>${esc(r.solution || '—')}</div>
        </div>
        <div class="ai-box">
          <div class="ai-box-title">📈 ${isEn ? 'Predictive Risk / Trend' : 'Dự đoán xu hướng (Prediction)'}</div>
          <div>${esc(r.prediction || '—')}</div>
        </div>
      </div>
    </div>`;
  };

  M.isAiEligibleEvent = (e) => {
    if (!e || typeof e !== 'object') return false;
    const k = String(e.kind || '').toLowerCase();
    const msg = String(e.message || '');
    const sev = String(e.severity || '').toLowerCase();
    if (k === 'up' || k === 'audit') return false;
    if (sev === 'ok') return false;
    if (/trở lại bình thường|mức an toàn|hoạt động bình thường|có điện lưới trở lại|hoạt động trở lại|recovered|returned to normal/i.test(msg)) return false;
    if (/mực còn|hết mực|no toner|low toner|drum|kẹt giấy|paper jam|cửa máy in|sự cố máy in/i.test(msg)) return false;
    return true;
  };

  M.showTechnicalLogsModal = (data) => {
    const isEn = M.S.lang === 'en';
    const logText = data.log_text || '';
    const devId = data.device_id;
    const canOp = M.S.user && M.S.user.role !== 'viewer';
    const modalHtml = `
      <p class="muted" style="margin:0 0 8px">${isEn
        ? 'Technical diagnostic telemetry gathered directly from server SQLite database & live agent/SNMP metrics. Ready to paste (Ctrl+V) into ChatGPT, Claude, Gemini, or DeepSeek.'
        : 'Logs kỹ thuật chuyên sâu được trích xuất trực tiếp từ DB SQLite của Server và dữ liệu telemetry Agent/SNMP. Sẵn sàng để dán (Ctrl+V) vào ChatGPT, Claude, Gemini hoặc DeepSeek.'}</p>
      <div style="position:relative">
        <textarea id="tech-log-area" readonly class="inp" style="width:100%;height:320px;font-family:monospace;font-size:12px;line-height:1.45;white-space:pre;resize:vertical;background:var(--bg);color:var(--text);border:1px solid var(--border)">${esc(logText)}</textarea>
      </div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button type="button" class="btn primary" id="btn-copy-tech-modal">📋 ${isEn ? 'Copy Technical Logs' : 'Sao chép Logs Kỹ thuật'}</button>
        ${canOp && devId ? `<button type="button" class="btn" id="btn-analyze-from-modal">✨ ${isEn ? 'Run AI Analysis Now' : 'Gửi AI Phân tích ngay'}</button>` : ''}
      </div>
    `;
    const { form } = M.modal(
      isEn ? `📋 Technical Telemetry & Logs: ${data.device_name}` : `📋 Logs Kỹ thuật Chẩn đoán: ${data.device_name}`,
      modalHtml,
      async () => {},
      { submit: t('Đóng'), noCancel: true, wide: true }
    );
    const copyBtn = $('#btn-copy-tech-modal', form);
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const area = $('#tech-log-area', form);
        if (area) {
          area.select();
          try {
            await navigator.clipboard.writeText(area.value);
          } catch {
            document.execCommand('copy');
          }
          M.toast(isEn ? 'Copied to clipboard!' : 'Đã sao chép vào bộ nhớ tạm!');
        }
      };
    }
    const analyzeBtn = $('#btn-analyze-from-modal', form);
    if (analyzeBtn) {
      analyzeBtn.onclick = async () => {
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = isEn ? '⏳ Analyzing...' : '⏳ Đang phân tích...';
        try {
          const res = await M.api('POST', '/api/ai/analyze', { event_id: data.event_id, device_id: devId, lang: M.S.lang });
          if (!res || !res.report) {
            throw new Error(isEn ? 'AI analysis returned empty result' : 'Không nhận được kết quả chẩn đoán từ AI');
          }
          M.closeModal();
          M.modal(
            isEn ? '🤖 AI Diagnosis Result' : '🤖 Kết quả Chẩn đoán AI',
            M.renderAiReportCard(res.report, true),
            async () => {},
            { submit: t('Đóng'), noCancel: true, wide: true }
          );
        } catch (err) {
          M.toast(M.trData(err.message));
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = isEn ? 'Run AI Analysis Now' : 'Gửi AI Phân tích ngay';
        }
      };
    }
  };

  const _hiddenAiSet = new Set();
  const _syncHiddenAi = () => {
    try {
      const raw = localStorage.getItem('hidden_ai_events');
      if (raw) {
        _hiddenAiSet.clear();
        JSON.parse(raw).forEach((id) => _hiddenAiSet.add(Number(id)));
      }
    } catch {}
  };
  _syncHiddenAi();

  M.getHiddenAiEvents = () => {
    _syncHiddenAi();
    return _hiddenAiSet;
  };

  M.isAiRowHidden = (id) => {
    if (!id) return false;
    const numId = Number(id);
    _syncHiddenAi();
    if (_hiddenAiSet.has(numId)) return true;
    const existing = document.getElementById(`ai-ev-row-${numId}`);
    if (existing && existing.classList.contains('hidden')) {
      _hiddenAiSet.add(numId);
      return true;
    }
    return false;
  };

  M.setAiRowHidden = (id, hidden) => {
    if (!id) return;
    const numId = Number(id);
    _syncHiddenAi();
    if (hidden) {
      _hiddenAiSet.add(numId);
    } else {
      _hiddenAiSet.delete(numId);
    }
    try {
      const arr = Array.from(_hiddenAiSet);
      if (arr.length > 500) arr.splice(0, arr.length - 500);
      localStorage.setItem('hidden_ai_events', JSON.stringify(arr));
    } catch {}
  };

  M.eventsTable = (events, showDevice) => {
    if (!events.length) return `<div class="muted">${esc(t('Chưa có sự kiện'))}</div>`;
    const isEn = M.S.lang === 'en';
    const canOp = M.S.user && M.S.user.role !== 'viewer';
    const badge = (e) => (e.kind === 'audit' ? 'ok' : e.severity);
    const label = {
      down: t('Mất kết nối'), up: t('Phục hồi'), warning: t('Cảnh báo'), audit: t('Hệ thống'),
      dos: t('Tấn công DoS'), smart: t('Lỗi đĩa cứng'), thermal: t('Quá nhiệt'), power: t('Mất điện lưới'),
    };
    const colSpan = showDevice ? 4 : 3;
    const rowsHtml = events.map((e) => {
      const isEligible = M.isAiEligibleEvent(e);
      const hasAi = !!e.ai_report;
      const isHidden = !hasAi || M.isAiRowHidden(e.id);
      const aiBtns = [];
      if (hasAi) {
        aiBtns.push(`<button type="button" class="ai-badge" data-ai-toggle="${e.id}" title="${isHidden ? (isEn ? 'Click to show AI diagnosis' : 'Bấm để hiện chẩn đoán AI') : (isEn ? 'Click to hide AI diagnosis' : 'Bấm để ẩn chẩn đoán AI')}">🤖 ${isEn ? 'AI Diagnosis' : 'AI Chẩn đoán'}</button>`);
      } else if (isEligible && canOp) {
        aiBtns.push(`<button type="button" class="ai-badge" data-ai-analyze="${e.id}" data-dev-id="${e.device_id || ''}" title="${isEn ? 'Collect tech logs & analyze with AI' : 'Thu thập log kỹ thuật & gọi AI phân tích'}">✨ ${isEn ? 'AI Analyze' : 'Phân tích AI'}</button>`);
      }
      if (isEligible || hasAi) {
        aiBtns.push(`<button type="button" class="ai-badge tech-copy" data-ai-copy-logs="${e.id}" data-dev-id="${e.device_id || ''}" title="${isEn ? 'Copy technical diagnostic logs to clipboard for ChatGPT / Claude / Gemini' : 'Sao chép logs kỹ thuật để tra cứu trên ChatGPT / Claude / Gemini'}">📋 ${isEn ? 'Copy Tech Logs' : 'Copy Logs Kỹ thuật'}</button>`);
      }
      const rowTitle = hasAi
        ? (isHidden
          ? (isEn ? 'Click to show AI diagnosis' : 'Bấm vào sự kiện để hiện bảng phân tích AI')
          : (isEn ? 'Click to hide AI diagnosis' : 'Bấm vào sự kiện để ẩn bảng phân tích AI'))
        : '';
      return `<tr class="ev-row ${hasAi ? 'has-ai' : ''} ${hasAi && isHidden ? 'ai-closed' : ''}" data-ev-id="${e.id}" ${rowTitle ? `title="${rowTitle}"` : ''}>
        <td>${M.fmtTime(e.ts)}</td>
        ${showDevice ? `<td>${e.device_id ? `<a href="#/device/${e.device_id}">${esc(e.device_name)}</a>` : esc(e.device_name)}</td>` : ''}
        <td><span class="sev-badge ${badge(e)} ev-${e.kind}">${esc(label[e.kind] || e.kind)}</span></td>
        <td>${esc(tr(e.message))} ${aiBtns.join('')}</td>
      </tr>
      <tr id="ai-ev-row-${e.id}" class="${isHidden ? 'hidden' : ''}">
        <td colspan="${colSpan}" style="padding-top:0;border-top:none">${hasAi ? M.renderAiReportCard(e.ai_report, false) : ''}</td>
      </tr>`;
    }).join('');
    return `<table class="tbl" data-events-tbl="1"><thead><tr><th>${esc(t('Thời gian'))}</th>${showDevice ? `<th>${esc(t('Thiết bị'))}</th>` : ''}<th>${esc(t('Loại'))}</th><th>${esc(t('Nội dung'))}</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  };

  document.addEventListener('click', async (ev) => {
    const isEn = M.S.lang === 'en';
    const toggleAiRow = (id) => {
      const row = document.getElementById(`ai-ev-row-${id}`);
      if (!row) return;
      const isHidden = row.classList.toggle('hidden');
      M.setAiRowHidden(id, isHidden);
      const evRow = document.querySelector(`tr.ev-row[data-ev-id="${id}"]`);
      if (evRow) {
        evRow.classList.toggle('ai-closed', isHidden);
        evRow.setAttribute('title', isHidden
          ? (isEn ? 'Click to show AI diagnosis' : 'Bấm vào sự kiện để hiện bảng phân tích AI')
          : (isEn ? 'Click to hide AI diagnosis' : 'Bấm vào sự kiện để ẩn bảng phân tích AI'));
      }
      const toggleBtns = document.querySelectorAll(`button[data-ai-toggle="${id}"]`);
      toggleBtns.forEach((toggleBtn) => {
        toggleBtn.setAttribute('title', isHidden
          ? (isEn ? 'Click to show AI diagnosis' : 'Bấm để hiện chẩn đoán AI')
          : (isEn ? 'Click to hide AI diagnosis' : 'Bấm để ẩn chẩn đoán AI'));
      });
    };

    const toggleBtn = ev.target.closest('[data-ai-toggle]');
    if (toggleBtn) {
      const id = toggleBtn.dataset.aiToggle;
      toggleAiRow(id);
      return;
    }

    const copyLogBtn = ev.target.closest('[data-ai-copy-logs]');
    if (copyLogBtn) {
      const id = Number(copyLogBtn.dataset.aiCopyLogs);
      const devId = copyLogBtn.dataset.devId;
      const origHtml = copyLogBtn.innerHTML;
      copyLogBtn.disabled = true;
      copyLogBtn.innerHTML = isEn ? '⏳ Copying...' : '⏳ Đang lấy logs...';
      try {
        const q = id
          ? (devId ? `event_id=${id}&device_id=${devId}&lang=${M.S.lang}` : `event_id=${id}&lang=${M.S.lang}`)
          : `device_id=${devId}&lang=${M.S.lang}`;
        const res = await M.api('GET', `/api/ai/technical-logs?${q}`);
        try {
          await navigator.clipboard.writeText(res.log_text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = res.log_text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        M.toast(isEn ? 'Copied technical diagnostic logs! Paste into ChatGPT/Claude.' : 'Đã sao chép logs kỹ thuật! Dán (Ctrl+V) vào ChatGPT / Claude.');
        M.showTechnicalLogsModal(res);
      } catch (err) {
        M.toast(M.trData(err.message));
      } finally {
        copyLogBtn.disabled = false;
        copyLogBtn.innerHTML = origHtml;
      }
      return;
    }

    const analyzeBtn = ev.target.closest('[data-ai-analyze]');
    if (analyzeBtn) {
      const id = Number(analyzeBtn.dataset.aiAnalyze);
      const origText = analyzeBtn.textContent;
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = isEn ? '⏳ Analyzing...' : '⏳ Đang phân tích...';
      try {
        const res = await M.api('POST', '/api/ai/analyze', { event_id: id, lang: M.S.lang });
        if (!res || !res.report) {
          throw new Error(isEn ? 'AI analysis returned empty result' : 'Không nhận được kết quả chẩn đoán từ AI');
        }
        const row = document.getElementById(`ai-ev-row-${id}`);
        if (row) {
          row.firstElementChild.innerHTML = M.renderAiReportCard(res.report, false);
          row.classList.remove('hidden');
        }
        M.setAiRowHidden(id, false);
        analyzeBtn.removeAttribute('data-ai-analyze');
        analyzeBtn.setAttribute('data-ai-toggle', String(id));
        analyzeBtn.textContent = `🤖 ${isEn ? 'AI Diagnosis' : 'AI Chẩn đoán'}`;
        analyzeBtn.setAttribute('title', isEn ? 'Click to hide AI diagnosis' : 'Bấm để ẩn chẩn đoán AI');
        const evRow = document.querySelector(`tr.ev-row[data-ev-id="${id}"]`);
        if (evRow) {
          evRow.classList.add('has-ai');
          evRow.classList.remove('ai-closed');
          evRow.setAttribute('title', isEn ? 'Click to hide AI diagnosis' : 'Bấm vào sự kiện để ẩn bảng phân tích AI');
        }
      } catch (err) {
        M.toast(M.trData(err.message));
        analyzeBtn.textContent = origText;
      } finally {
        analyzeBtn.disabled = false;
      }
      return;
    }

    const evRow = ev.target.closest('tr.ev-row.has-ai');
    if (evRow) {
      if (ev.target.closest('a, button, input, textarea, select')) return;
      const id = evRow.dataset.evId;
      toggleAiRow(id);
      return;
    }
  });

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
                <div class="row dual-filter-bar"><h2 style="margin:0">${esc(t('Thiết bị'))}</h2>
                  <span class="dual-device-count" id="dev-count-badge">0</span>
                  <span class="spacer"></span>
                  <input class="inp" id="f-q" placeholder="${esc(t('Tìm thiết bị…'))}" style="width:155px" value="${esc(F.q)}">
                  <select class="sel" id="f-status"><option value="">${esc(t('Tất cả trạng thái'))}</option><option value="problem">${esc(t('Chỉ có vấn đề'))}</option>
                    <option value="down">${esc(t('Mất kết nối'))}</option><option value="warning">${esc(t('Cảnh báo'))}</option><option value="up">${esc(t('Online'))}</option></select>
                  <select class="sel" id="f-type"><option value="">${esc(t('Mọi loại'))}</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
                </div>
                <div class="grid" id="grid"></div>
              </div>
            </div>
            <div class="dual-pane dual-pane-sub">
              <div class="dual-pane-head">
                <span class="dual-title">${esc(t('🖥️ Màn hình 2'))}</span>
                <div class="dual-tabs">
                  <button class="btn sm ${dualTab === 'map' ? 'primary' : ''}" id="dual-tab-map">${esc(t('🗺️ Topology'))}</button>
                  <button class="btn sm ${dualTab === 'groups' ? 'primary' : ''}" id="dual-tab-groups">${esc(t('🗂️ Nhóm'))} <span class="dual-tab-badge" id="dual-badge-groups">0</span></button>
                  <button class="btn sm ${dualTab === 'problems' ? 'primary' : ''}" id="dual-tab-problems">${esc(t('⚠️ Cảnh báo'))} <span class="dual-tab-badge" id="dual-badge-problems">0</span></button>
                </div>
                <span class="spacer"></span>
                <button class="btn sm" id="btn-dual-popout" title="${esc(t('Mở cửa sổ tách biệt cho màn hình phụ thứ hai'))}">${esc(t('🗗 Cửa sổ riêng'))}</button>
                <button class="btn sm" id="btn-dual-close" title="${esc(t('Tắt chế độ màn hình đôi'))}">✕</button>
              </div>
              <div class="dual-pane-body" id="dual-pane-body"></div>
            </div>
          </div>`;

        const tabMap = $('#dual-tab-map');
        const tabGroups = $('#dual-tab-groups');
        const tabProblems = $('#dual-tab-problems');
        const switchDualTab = (tVal) => {
          dualTab = tVal;
          localStorage.setItem('dual_tab', tVal);
          tabMap?.classList.toggle('primary', tVal === 'map');
          tabGroups?.classList.toggle('primary', tVal === 'groups');
          tabProblems?.classList.toggle('primary', tVal === 'problems');
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
          <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">${esc(t('Thiết bị'))}</h2>
            <span class="dual-device-count" id="dev-count-badge">0</span>
            <span class="spacer"></span>
            <input class="inp" id="f-q" placeholder="${esc(t('Tìm thiết bị…'))}" style="width:200px" value="${esc(F.q)}">
            <select class="sel" id="f-status"><option value="">${esc(t('Tất cả trạng thái'))}</option><option value="problem">${esc(t('Chỉ có vấn đề'))}</option>
              <option value="down">${esc(t('Mất kết nối'))}</option><option value="warning">${esc(t('Cảnh báo'))}</option><option value="up">${esc(t('Online'))}</option></select>
            <select class="sel" id="f-type"><option value="">${esc(t('Mọi loại'))}</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
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
        <div class="kpi clickable ${cls} ${zero && !v ? 'zero' : ''}" data-kpi="${kpiKey}" title="${esc(t(titleHint))}">
          <div class="label">${esc(t(label))} <span class="kpi-hint">${esc(t('🔍 Chi tiết'))}</span></div>
          <div class="val">${v}</div>
        </div>`;
      $('#kpis').innerHTML = `
        <div class="kpi big clickable" data-kpi="alive" title="${esc(t('Bấm để xem danh sách thiết bị đang hoạt động'))}">
          <div class="label">${esc(t('Thiết bị đang hoạt động'))} <span class="kpi-hint">${esc(t('🔍 Chi tiết'))}</span></div>
          <div class="val">${s.alive}<small>/${s.total}</small></div>
        </div>
        ${k('k-down', 'Mất kết nối', s.down, true, 'down', 'Bấm để xem danh sách thiết bị mất kết nối')}
        ${k('k-warn', 'Cảnh báo', s.warning, true, 'warn', 'Bấm để xem danh sách chi tiết các cảnh báo')}
        ${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance, 'unk', 'Bấm để xem thiết bị chưa rõ hoặc đang bảo trì')}`;
      // Khi ở chế độ màn hình đôi, Nhóm thiết bị đã có tab riêng ở Màn hình 2, tránh lặp lại ở cột trái để dành trọn không gian từ mục Thiết bị trở xuống
      $('#groups-sec').innerHTML = (!M.S.dual && M.S.groups.length)
        ? `<h2>${esc(t('Nhóm thiết bị'))}</h2><div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>` : '';
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
        : `<div class="muted">${esc(snap.devices.length ? t('Không có thiết bị phù hợp') : t('Chưa có thiết bị nào. Vào mục "Thiết bị" để thêm.'))}</div>`;

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
            <h3 style="margin:0 0 8px">${esc(t('Chưa có sơ đồ mạng Topology'))}</h3>
            <p class="muted" style="margin:0 0 14px">${esc(t('Tạo sơ đồ mạng để theo dõi trực quan liên kết giữa các thiết bị trên màn hình thứ hai.'))}</p>
            ${M.S.user.role !== 'viewer' ? `<a class="btn primary" href="#/maps">${esc(t('+ Tạo sơ đồ Topology'))}</a>` : ''}
          </div>`;
        }
      } else if (dualTab === 'groups') {
        body.innerHTML = M.S.groups.length
          ? `<div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))">${M.S.groups.map(M.groupTile).join('')}</div>`
          : `<div class="muted">${esc(t('Chưa có nhóm thiết bị nào.'))}</div>`;
      } else if (dualTab === 'problems') {
        if (!probs.length) {
          body.innerHTML = `<div class="panel" style="text-align:center;padding:36px 16px;border-color:var(--c-ok)">
            <div style="font-size:40px;margin-bottom:8px">✅</div>
            <h3 style="color:var(--c-ok);margin:0 0 6px">${esc(t('Hệ thống đang hoạt động ổn định'))}</h3>
            <p class="muted" style="margin:0">${esc(t('Tất cả thiết bị đều đang trực tuyến, không có cảnh báo.'))}</p>
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
            <div class="brand" style="font-size:20px">${esc(t('◉ MÀN HÌNH PHỤ (SECONDARY)'))}</div>
            <span class="chip" id="sec-chip">–/–</span>
            <div class="dual-tabs">
              <button class="btn sm ${secTab === 'map' ? 'primary' : ''}" id="sec-tab-map">${esc(t('🗺️ Sơ đồ Topology'))}</button>
              <button class="btn sm ${secTab === 'groups' ? 'primary' : ''}" id="sec-tab-groups">${esc(t('🗂️ Nhóm thiết bị'))}</button>
              <button class="btn sm ${secTab === 'problems' ? 'primary' : ''}" id="sec-tab-problems">${esc(t('⚠️ Cảnh báo'))}</button>
              <button class="btn sm ${secTab === 'wallboard' ? 'primary' : ''}" id="sec-tab-wallboard">${esc(t('📊 Wallboard'))}</button>
            </div>
            <span class="spacer"></span>
            <button class="icon-btn" id="sec-btn-fullscreen" title="${esc(t('Phóng to toàn màn hình (phím F)'))}">${esc(t('📺 Toàn màn hình'))}</button>
            <select class="sel" id="sec-theme-sel" title="${esc(t('Giao diện'))}">
              <option value="neon">Neon</option><option value="dark">${esc(t('Tối'))}</option><option value="light">${esc(t('Sáng'))}</option>
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

      const switchTab = (tVal) => {
        secTab = tVal;
        localStorage.setItem('secondary_tab', tVal);
        $('#sec-tab-map')?.classList.toggle('primary', tVal === 'map');
        $('#sec-tab-groups')?.classList.toggle('primary', tVal === 'groups');
        $('#sec-tab-problems')?.classList.toggle('primary', tVal === 'problems');
        $('#sec-tab-wallboard')?.classList.toggle('primary', tVal === 'wallboard');
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
      if (chip) chip.textContent = M.S.lang === 'en' ? `${s.alive}/${s.total} active` : `${s.alive}/${s.total} hoạt động`;
      const body = $('#sec-body');
      const tab = localStorage.getItem('secondary_tab') || 'map';
      if (tab === 'map') {
        if (M.S.maps && M.S.maps.length) {
          body.innerHTML = `<div class="map-box" style="height:calc(100vh - 120px)"><svg id="sec-map-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" style="height:100%"></svg></div>`;
          M.api('GET', `/api/maps/${M.S.maps[0].id}`).then((m) => {
            M.renderMapSvg($('#sec-map-svg'), m);
          }).catch(() => {});
        } else {
          body.innerHTML = `<div class="panel muted" style="padding:40px;text-align:center">${esc(t('Chưa có sơ đồ Topology nào.'))}</div>`;
        }
      } else if (tab === 'groups') {
        body.innerHTML = `<div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>`;
      } else if (tab === 'problems') {
        const probs = snap.devices.filter((d) => (d.status === 'down' || d.status === 'warning') && d.severity !== 'none');
        body.innerHTML = probs.length
          ? `<div class="grid">${sortDevices(probs).map(M.tile).join('')}</div>`
          : `<div class="panel" style="text-align:center;padding:40px;border-color:var(--c-ok);color:var(--c-ok)"><h3>${esc(t('✅ Tất cả thiết bị đang hoạt động ổn định'))}</h3></div>`;
      } else if (tab === 'wallboard') {
        const k = (cls, label, v, zero, kpiKey, titleHint) => `
          <div class="kpi clickable ${cls} ${zero && !v ? 'zero' : ''}" data-kpi="${kpiKey}" title="${esc(t(titleHint))}">
            <div class="label">${esc(t(label))} <span class="kpi-hint">${esc(t('🔍 Chi tiết'))}</span></div>
            <div class="val">${v}</div>
          </div>`;
        body.innerHTML = `
          <div class="kpis">
            <div class="kpi big clickable" data-kpi="alive" title="${esc(t('Bấm để xem danh sách thiết bị đang hoạt động'))}">
              <div class="label">${esc(t('Thiết bị đang hoạt động'))} <span class="kpi-hint">${esc(t('🔍 Chi tiết'))}</span></div>
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
      el.innerHTML = `<div class="row"><h1>${esc(t('Nhóm / cụm thiết bị'))}</h1><span class="spacer"></span>
        ${M.S.user.role === 'admin' ? `<button class="btn primary" id="g-add">${esc(t('+ Thêm nhóm'))}</button>` : ''}</div><div class="grid" id="g-grid"></div>`;
      const add = $('#g-add');
      if (add) add.onclick = () => M.editGroup(null);
    },
    update() { $('#g-grid') && ($('#g-grid').innerHTML = M.S.groups.map(M.groupTile).join('') || `<div class="muted">${esc(t('Chưa có nhóm. Nhóm giúp gom các thiết bị (ví dụ: Tầng 1, Cụm DB) để theo dõi riêng.'))}</div>`); },
  };

  M.views.group = {
    async render(el, id) {
      await M.loadGroups();
      const g = M.S.groups.find((x) => x.id === Number(id));
      if (!g) { el.innerHTML = `<div class="panel err">${esc(t('Không tìm thấy nhóm'))}</div>`; return; }
      this.g = g;
      el.innerHTML = `<div id="grp-hero"></div><h2>${esc(t('Thiết bị trong nhóm'))}</h2><div class="grid" id="grp-grid"></div>`;
    },
    update(snap) {
      const g = this.g;
      if (!g || !$('#grp-hero')) return;
      const list = snap.devices.filter((d) => d.groups.includes(g.id));
      const { s, cls } = groupClass(list);
      const avg = (k) => { const v = list.map((d) => d[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const isEn = M.S.lang === 'en';
      $('#grp-hero').innerHTML = `<div class="hero ${cls}"><div class="h-ico">🗂️</div><div style="flex:1"><h1>${esc(g.name)}</h1>
        <div class="muted">${esc(g.description || '')}</div></div>
        <div style="text-align:right"><div class="h-state">${s.alive}/${s.total} ${isEn ? 'active' : 'hoạt động'}</div>
        <div class="muted">${isEn ? `${s.down} offline · ${s.warning} warning` : `${s.down} mất kết nối · ${s.warning} cảnh báo`}</div></div>
        ${M.S.user.role === 'admin' ? `<button class="btn" id="g-edit">${esc(t('Sửa nhóm'))}</button>` : ''}</div>
        <div class="gauges panel" style="margin-top:14px">${['cpu', 'ram', 'disk'].map((k) => (avg(k) != null ? M.gauge(`${k.toUpperCase()} ${t('trung bình')}`, avg(k), k) : '')).join('') || `<span class="muted">${esc(t('Nhóm chưa có thiết bị cài agent'))}</span>`}</div>`;
      $('#grp-grid').innerHTML = sortDevices(list).map(M.tile).join('') || `<div class="muted">${esc(t('Nhóm chưa có thiết bị'))}</div>`;
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
          <div class="panel"><div class="row"><h2 style="margin:0">${esc(t('Lịch sử'))}</h2><span class="spacer"></span>
            <select class="sel" id="d-range"><option value="1h">${esc(t('1 giờ'))}</option><option value="6h">${esc(t('6 giờ'))}</option><option value="24h">${esc(t('24 giờ'))}</option><option value="7d">${esc(t('7 ngày'))}</option></select></div>
            <div id="d-charts"></div></div>
          <div class="panel" style="margin-top:14px"><h2 style="margin:0 0 10px">${esc(t('Sự kiện gần đây'))}</h2><div id="d-events"></div></div>
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
        if ($('#d-hero')) $('#d-hero').innerHTML = `<div class="panel err">${esc(tr(e.message))}</div>`;
      } finally { this.busy = false; }
    },
    paint() {
      const d = this.D;
      if (!d || !$('#d-hero')) return;
      const role = M.S.user.role;
      const isEn = M.S.lang === 'en';
      const numLoc = isEn ? 'en-US' : 'vi-VN';
      const sinceWord = isEn ? 'since' : 'từ';
      const isPrinter = d.type === 'printer';
      const canAck = (d.status === 'down' || d.status === 'warning') && !d.acked && role !== 'viewer';
      $('#d-hero').innerHTML = `<div class="hero ${M.statusClass(d)}"><div class="h-ico">${M.ICON[d.type] || ''}</div>
        <div style="flex:1;min-width:0"><h1>${esc(d.name)}</h1><div class="h-state">${M.STATE_NAME[d.status]}
        <span class="muted" style="font-size:14px;text-transform:none"> · ${sinceWord} ${M.fmtTime(d.since)} (${M.fmtDur((Date.now() - d.since) / 1000)})</span></div>
        ${d.reasons.map((r) => `<div class="reason">• ${esc(tr(r))}</div>`).join('')}</div>
        <div class="row">${canAck ? `<button class="btn" id="d-ack">${esc(t('Đã biết'))}</button>` : ''}
        ${!isPrinter ? `<button class="btn" id="d-copy-tech" title="${isEn ? 'Copy technical diagnostic logs to clipboard for ChatGPT / Claude' : 'Sao chép logs kỹ thuật để tra cứu trên ChatGPT / Claude'}">📋 ${esc(t('Copy Logs Kỹ thuật'))}</button>${role !== 'viewer' ? `<button class="btn" id="d-ai-diag" title="${isEn ? 'Run AI technical diagnosis on this device' : 'Chạy chẩn đoán AI kỹ thuật cho thiết bị này'}">✨ ${esc(t('Chẩn đoán AI'))}</button>` : ''}` : ''}
        ${role === 'admin' ? `<button class="btn" id="d-maint">${esc(d.maintenance ? t('Kết thúc bảo trì') : t('Bảo trì'))}</button><button class="btn" id="d-edit">${esc(t('Sửa'))}</button>` : ''}
        <button class="btn" id="d-back">${esc(t('← Quay lại'))}</button></div></div>`;
      const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
      on('#d-back', () => history.back());
      on('#d-copy-tech', async () => {
        try {
          const res = await M.api('GET', `/api/ai/technical-logs?device_id=${d.id}&lang=${M.S.lang}`);
          try { await navigator.clipboard.writeText(res.log_text); } catch { /* ignore */ }
          M.toast(isEn ? 'Copied technical diagnostic logs! Paste into ChatGPT/Claude.' : 'Đã sao chép logs kỹ thuật! Dán (Ctrl+V) vào ChatGPT / Claude.');
          M.showTechnicalLogsModal(res);
        } catch (err) {
          M.toast(M.trData(err.message));
        }
      });
      on('#d-ai-diag', async () => {
        const btn = $('#d-ai-diag');
        if (btn) {
          btn.disabled = true;
          btn.textContent = isEn ? '⏳ Analyzing...' : '⏳ Đang phân tích...';
        }
        try {
          const res = await M.api('POST', '/api/ai/analyze', { device_id: d.id, lang: M.S.lang });
          if (!res || !res.report) {
            throw new Error(isEn ? 'AI analysis returned empty result' : 'Không nhận được kết quả chẩn đoán từ AI');
          }
          M.modal(
            isEn ? '🤖 AI Health & Capacity Diagnosis' : '🤖 Kết quả Chẩn đoán AI & Dự báo Sức khỏe',
            M.renderAiReportCard(res.report, true),
            async () => {},
            { submit: t('Đóng'), noCancel: true, wide: true }
          );
        } catch (err) {
          M.toast(M.trData(err.message));
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = `✨ ${esc(t('Chẩn đoán AI'))}`;
          }
        }
      });
      on('#d-ack', async () => {
        await M.api('POST', `/api/devices/${d.id}/ack`, {});
        d.acked = true;
        if (M.S.snap && M.S.snap.devices) {
          const sd = M.S.snap.devices.find((x) => x.id === d.id);
          if (sd) sd.acked = true;
        }
        M.syncAlarmLoop();
        this.paint();
      });
      on('#d-maint', async () => { await M.api('PUT', `/api/devices/${d.id}`, { maintenance: !d.maintenance }); });
      on('#d-edit', () => M.editDevice(d.id));

      const a = d.agent;
      const gs = [];
      const stat = (label, v) => `<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px">${v}</div><div class="g-label">${label}</div></div>`;

      if (d.type === 'printer') {
        const prn = d.printer || (d.snmp && d.snmp.printer);
        if (d.drum != null) gs.push(M.consumableGauge(t('Độ bền Drum'), d.drum));
        else gs.push(stat(t('Độ bền Drum'), `<span class="muted" style="font-size:18px">${esc(t('Tích hợp'))}</span>`));
        if (d.toner != null) gs.push(M.consumableGauge(t('Lượng mực in'), d.toner));
        else gs.push(stat(t('Lượng mực in'), '<span class="muted" style="font-size:18px">—</span>'));
        if (prn && prn.memory) {
          gs.push(M.gauge(t('Bộ nhớ RAM'), prn.memory.percent, 'ram', `${M.fmtBytes(prn.memory.used)} / ${M.fmtBytes(prn.memory.total)}`));
        } else if (d.ram != null) {
          gs.push(M.gauge(t('Bộ nhớ RAM'), d.ram, 'ram'));
        }
        if (d.page_count != null) {
          gs.push(stat(t('Tổng số trang in'), `${Number(d.page_count).toLocaleString(numLoc)} ${t('trang')}`));
        }
        if (prn && (prn.display || prn.status_text)) {
          const pSt = tr(prn.display || prn.status_text);
          const pCol = (prn.errors && prn.errors.length) ? 'var(--c-critical)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:18px;font-weight:700;padding:42px 0 6px;color:${pCol}">🖨️ ${esc(pSt)}</div><div class="g-label">${esc(t('Màn hình điều khiển'))}</div></div>`);
        }
        gs.push(stat(t('Thời gian chạy'), M.fmtDur(d.uptime)));
      } else {
        if (d.cpu != null) gs.push(M.gauge('CPU', d.cpu, 'cpu', a && a.cores ? `${a.cores} ${t('nhân')}` : ''));
        if (d.ram != null) gs.push(M.gauge('RAM', d.ram, 'ram', a && a.ram.total ? `${M.fmtBytes(a.ram.used)} / ${M.fmtBytes(a.ram.total)}` : ''));
        if (d.disk != null) gs.push(M.gauge(t('Ổ đĩa (cao nhất)'), d.disk, 'disk'));
        if (d.type === 'ap' || d.total_ssids != null || d.total_clients != null) {
          if (d.total_ssids != null) gs.push(stat(t('Tổng số SSID'), `<span style="color:var(--c-low)">📶 ${d.total_ssids}</span>`));
          if (d.total_clients != null) gs.push(stat(t('Client kết nối'), `<span style="color:var(--c-ok)">👥 ${Number(d.total_clients).toLocaleString(numLoc)}</span>`));
        }
        gs.push(stat(t('Thời gian chạy'), M.fmtDur(d.uptime)), stat('Ping', d.rtt != null ? `${d.rtt} ms` : '—'));
        if (d.net_in != null || d.net_out != null) {
          const netHtml = `<div style="font-size:18px;font-weight:700;padding:26px 0 2px;line-height:1.3"><span style="color:var(--c-low)" title="Download">↓ ${M.fmtRate(d.net_in || 0)}</span><br><span style="color:var(--c-maint);font-size:15px" title="Upload">↑ ${M.fmtRate(d.net_out || 0)}</span></div>`;
          gs.push(`<div class="gauge">${netHtml}<div class="g-label">${esc(t('Băng thông (Download / Upload)'))}</div></div>`);
        }
        if (d.drum != null) gs.push(M.consumableGauge(t('Độ bền Drum'), d.drum));
        if (d.toner != null) gs.push(M.consumableGauge(t('Lượng mực in'), d.toner));
        if (d.page_count != null) gs.push(stat(t('Tổng số trang in'), `${Number(d.page_count).toLocaleString(numLoc)} ${t('trang')}`));
        if (d.printer && (d.printer.status_text || d.printer.display)) {
          const pSt = tr(d.printer.display || d.printer.status_text);
          const pCol = (d.printer_errors && d.printer_errors.length) ? 'var(--c-critical)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:18px;font-weight:700;padding:42px 0 6px;color:${pCol}">🖨️ ${esc(pSt)}</div><div class="g-label">${esc(t('Trạng thái máy in'))}</div></div>`);
        }
        if (d.temperature != null) {
          const tTh = (th() && th().temp) || 85;
          const tCol = d.temperature >= tTh ? 'var(--c-critical)' : d.temperature >= tTh - 10 ? 'var(--c-medium)' : 'var(--c-ok)';
          gs.push(`<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px;color:${tCol}">${Math.round(d.temperature)}°C</div><div class="g-label">${esc(t('Nhiệt độ CPU'))}</div></div>`);
        } else if (d.type === 'vm' || (d.checks && d.checks.agent)) {
          gs.push(`<div class="gauge"><div style="font-size:24px;font-weight:700;padding:42px 0 6px;color:var(--muted)">N/A</div><div class="g-label">${esc(t('Nhiệt độ CPU (VM)'))}</div></div>`);
        }
        if (d.power) {
          const pState = d.power.on_battery ? t('Đang chạy PIN') : t('Điện lưới AC');
          const pCol = d.power.on_battery ? 'var(--c-critical)' : 'var(--c-ok)';
          const pSub = d.power.battery_percent != null ? `${isEn ? 'Battery' : 'Pin'}: ${d.power.battery_percent}%` : '';
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:42px 0 6px;color:${pCol}">${d.power.on_battery ? '🔋 ' : '⚡ '}${esc(pState)}</div><div class="g-label">${esc(t('Nguồn / UPS'))}${pSub ? `<br>${esc(pSub)}` : ''}</div></div>`);
        }
        if (d.smart) {
          const sOk = d.smart.ok !== false;
          const sCol = sOk ? 'var(--c-ok)' : 'var(--c-critical)';
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:42px 0 6px;color:${sCol}">${esc(sOk ? t('✅ Bình thường') : t('❌ Lỗi SMART'))}</div><div class="g-label">${esc(t('Trạng thái đĩa cứng'))}</div></div>`);
        }
        if (d.dos_alert || (d.alerts && d.alerts.dos)) {
          const detail = d.dos_details ? `<div style="font-size:12px;opacity:.85;margin-top:3px">${esc(tr(d.dos_details))}</div>` : '';
          const ppsTxt = d.pkt_rate ? `${d.pkt_rate.toLocaleString(numLoc)} ${isEn ? 'pkt/s' : 'gói/s'}` : t('Lưu lượng bất thường');
          gs.push(`<div class="gauge"><div style="font-size:20px;font-weight:700;padding:36px 0 6px;color:var(--c-critical)">${esc(t('🛡️ Cảnh báo DoS'))}</div><div class="g-label">${esc(ppsTxt)}${detail}</div></div>`);
        }
      }
      $('#d-gauges').innerHTML = `<div class="gauges" style="margin:0">${gs.join('')}</div>`;

      const names = d.groups.map((id) => (M.S.groups.find((g) => g.id === id) || {}).name).filter(Boolean);
      const chk = [d.check_icmp && 'ICMP ping', d.check_agent && 'Agent', d.snmp_enabled && 'SNMP'].filter(Boolean).join(', ') || '—';
      const kv = (k, v) => `<dt>${esc(t(k))}</dt><dd>${v == null || v === '' ? '—' : esc(v)}</dd>`;
      let html = `<h2 style="margin:0 0 10px">${esc(t('Thông tin'))}</h2><dl class="kv">${kv('Loại', M.TYPE_NAME[d.type])}${kv('Địa chỉ', d.address)}${kv('Vị trí', d.location)}
        <dt>${esc(t('Mức cảnh báo'))}</dt><dd><span class="sev-badge ${d.severity}">${M.SEV_NAME[d.severity]}</span>${d.severity_override ? '' : ` <span class="muted">${esc(t('(theo loại)'))}</span>`}</dd>
        ${kv('Nhóm', names.join(', '))}${kv('Kiểm tra', chk)}${kv('Ghi chú', d.notes)}</dl>`;
      if (a) {
        html += `<h2>Agent</h2><dl class="kv">${kv('Hostname', a.hostname)}${kv('Hệ điều hành', a.os)}${kv('IP', a.ip)}${kv('Phiên bản', a.version)}
          ${kv('Báo cáo cuối', d.last_agent_at ? M.fmtTime(d.last_agent_at) : '')}</dl>`;
        if (a.disks.length) {
          html += `<h2>${esc(t('Ổ đĩa'))}</h2><table class="tbl"><tbody>${a.disks.map((x) => `<tr><td>${esc(x.mount)}</td><td>${M.fmtBytes(x.used)} / ${M.fmtBytes(x.total)}</td>
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

        html += `<h2>${esc(t('Cấu hình sản phẩm & In ấn (Product & Print Settings)'))}</h2><dl class="kv">
          ${kv('Model sản phẩm', prn.model || d.name)}
          ${kv('Số Serial', prn.serial)}
          ${prn.firmware ? kv('Mã Firmware', prn.firmware) : ''}
          ${prn.duplex ? kv('In 2 mặt tự động', tr(prn.duplex)) : ''}
          ${memStr ? kv('Bộ nhớ RAM máy in', memStr) : ''}
          ${langsStr ? `<dt>${esc(t('Ngôn ngữ in hỗ trợ'))}</dt><dd>${langsStr}</dd>` : ''}
          ${kv('Màn hình điều khiển LCD', prn.display)}
          ${kv('Trạng thái thiết bị', tr(prn.status_text))}
          ${kv('Tổng trang đã in (Impressions)', (prn.page_count != null || d.page_count != null) ? `${Number(prn.page_count ?? d.page_count).toLocaleString(numLoc)} ${t('trang')}` : '—')}
        </dl>`;

        if (prn.errors && prn.errors.length) {
          html += `<div class="reason" style="margin:8px 0;background:rgba(239,68,68,0.15);padding:10px 14px;border-radius:6px;border:1px solid var(--c-critical);color:var(--text)">
            <b style="color:var(--c-critical)">${esc(t('⚠️ Sự cố máy in phát hiện:'))}</b><br>${prn.errors.map((e) => `• ${esc(tr(e))}`).join('<br>')}
          </div>`;
        }

        if (prn.supplies && prn.supplies.length) {
          html += `<h2>${esc(t('Vật tư tiêu hao (Mực in & Cụm trống Drum)'))}</h2>
          <table class="tbl"><thead><tr><th>${esc(t('Tên vật tư'))}</th><th>${esc(t('Phân loại'))}</th><th>${esc(t('Mức còn lại'))}</th><th>${esc(t('Dung lượng'))}</th></tr></thead><tbody>
          ${prn.supplies.map((s) => {
            const kindName = t({ toner: 'Hộp mực (Toner)', drum: 'Cụm trống (Drum)', waste: 'Hộp mực thải', fuser: 'Cụm sấy (Fuser)', transfer: 'Băng tải' }[s.kind] || 'Vật tư khác');
            const col = s.kind === 'drum' ? 'var(--c-maint)' : (s.percent != null && s.percent <= 10 ? 'var(--c-critical)' : (s.percent != null && s.percent <= 25 ? 'var(--c-medium)' : 'var(--c-ok)'));
            const barHtml = s.percent != null
              ? `<div class="bar" style="width:110px">${s.percent}%<i><b style="width:${s.percent}%;background:${col}"></b></i></div>`
              : esc(tr(s.status || '—'));
            const capText = (s.level != null && s.max != null && s.max > 0 && s.level >= 0) ? `${Number(s.level).toLocaleString(numLoc)} / ${Number(s.max).toLocaleString(numLoc)}` : tr(s.status || '—');
            return `<tr><td><b>${esc(s.name)}</b></td><td><span class="muted">${esc(kindName)}</span></td><td>${barHtml}</td><td>${esc(capText)}</td></tr>`;
          }).join('')}
          </tbody></table>`;
        }

        if (prn.trays && prn.trays.length) {
          html += `<h2>${esc(t('Cấu hình khay nạp giấy & Giấy in (Paper Settings)'))}</h2>
          <table class="tbl"><thead><tr><th>${esc(t('Khay nạp'))}</th><th>${esc(t('Loại giấy (Media)'))}</th><th>${esc(t('Khổ giấy'))}</th><th>${esc(t('Tình trạng'))}</th><th>${esc(t('Sức chứa'))}</th></tr></thead><tbody>
          ${prn.trays.map((trItem) => {
            const isWarn = trItem.status === 'Hết giấy';
            const stBadge = isWarn
              ? `<span style="color:var(--c-critical);font-weight:700">⚠️ ${esc(tr(trItem.status))}</span>`
              : `<span style="color:var(--c-ok)">${esc(tr(trItem.status))}</span>`;
            return `<tr><td><b>${esc(trItem.name)}</b></td><td>${esc(trItem.media_type || t('Mặc định'))}</td><td>${esc(trItem.media_name || t('A4 / Mặc định'))}</td><td>${stBadge}</td><td>${trItem.max != null && trItem.max > 0 ? `${trItem.max} ${t('tờ')}` : '—'}</td></tr>`;
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

        html += `<h2>${esc(t('Thông tin mạng không dây & SSID (Wireless Networks)'))}</h2>
          <dl class="kv">
            ${kv('Tổng số SSID phát sóng', ap.total_ssids != null ? `${ap.total_ssids} SSID` : (d.total_ssids != null ? `${d.total_ssids} SSID` : '—'))}
            ${kv('Tổng số Client đang kết nối', ap.total_clients != null ? `${Number(ap.total_clients).toLocaleString(numLoc)} ${isEn ? 'clients (across SSIDs)' : 'thiết bị (tính trên các SSID)'}` : (d.total_clients != null ? `${Number(d.total_clients).toLocaleString(numLoc)} ${isEn ? 'clients' : 'thiết bị'}` : '—'))}
            ${bandSummary ? kv('Phân bổ theo băng tần', bandSummary) : ''}
            ${kv('Bảng theo dõi ARP', ap.has_arp ? (isEn ? `Supported (${arpTable.length} entries)` : `Có hỗ trợ (${arpTable.length} thiết bị ghi nhận)`) : t('Không có dữ liệu ARP'))}
          </dl>`;

        if (ssids.length) {
          const totCli = ap.total_clients || 1;
          const ssidCountLabel = ap.total_ssids != null ? `${ap.total_ssids} SSID` : `${ssids.length} SSID`;
          html += `<h2>${esc(t('Chi tiết các SSID & Số lượng Client kết nối'))} (${ssidCountLabel})</h2>
          <table class="tbl"><thead><tr><th>${esc(t('Tên SSID'))}</th><th>${esc(t('BSSID (MAC phát sóng)'))}</th><th>${esc(t('Băng tần (Band)'))}</th><th>${esc(t('Kênh'))}</th><th>${esc(t('Client kết nối'))}</th><th>${esc(t('Tỷ lệ Client'))}</th></tr></thead><tbody>
          ${ssids.map((s) => {
            const pct = Math.min(100, Math.round(((s.clients || 0) / totCli) * 100));
            const barHtml = `<div class="bar" style="width:110px">${s.clients || 0} client<i><b style="width:${pct}%;background:var(--c-ok)"></b></i></div>`;
            return `<tr>
              <td><b>📶 ${esc(s.ssid)}</b></td>
              <td><code>${esc(s.bssid || '—')}</code></td>
              <td><span class="badge" style="background:var(--panel2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:12px">${esc(s.band || t('Mặc định'))}</span></td>
              <td>${s.channel != null ? `CH ${s.channel}` : '—'}</td>
              <td><b style="color:var(--c-ok);font-size:14px">${Number(s.clients || 0).toLocaleString(numLoc)}</b> client</td>
              <td>${barHtml}</td>
            </tr>`;
          }).join('')}
          </tbody></table>`;
        }

        const arpCountLabel = arpTable.length ? (isEn ? ` (${arpTable.length} entries)` : ` (${arpTable.length} thiết bị)`) : '';
        const arpNoteHtml = isEn
          ? `<b>${esc(t('Lưu ý:'))}</b> ${esc(t('Bảng ARP thu thập qua SNMP trên thiết bị AP có tính chất cục bộ (Local ARP Cache) và bị giới hạn bởi giao thức. Danh sách này phản ánh các thiết bị có giao tiếp Layer 3 trong mạng (như Gateway hoặc thiết bị cùng phân vầng), do đó có thể không hiển thị đầy đủ hoặc chính xác tuyệt đối IP và Hostname của tất cả các Client đang kết nối WiFi.'))}`
          : '<b>Lưu ý:</b> Bảng ARP thu thập qua SNMP trên thiết bị AP có tính chất cục bộ (Local ARP Cache) và bị giới hạn bởi giao thức. Danh sách này phản ánh các thiết bị có giao tiếp Layer 3 trong mạng (như Gateway hoặc thiết bị cùng phân vầng), do đó có thể không hiển thị đầy đủ hoặc chính xác tuyệt đối IP và Hostname của tất cả các Client đang kết nối WiFi.';
        html += `<h2>${esc(t('Bảng theo dõi ARP & Thiết bị kết nối'))}${arpCountLabel}</h2>
        <div class="ap-arp-note">
          <span class="note-icon">ℹ️</span>
          <div class="note-content">
            ${arpNoteHtml}
          </div>
        </div>`;

        if (arpTable.length) {
          html += `<div style="margin-bottom:8px">
            <input class="inp" id="arp-search-inp" placeholder="${esc(t('🔍 Tìm kiếm theo IP, MAC, Domain name / Hostname, SSID...'))}" style="width:100%;max-width:380px">
          </div>
          <div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
          <table class="tbl" id="arp-table-el" style="margin:0"><thead><tr style="position:sticky;top:0;background:var(--panel);z-index:2">
            <th>${esc(t('Địa chỉ IP'))}</th><th>${esc(t('Địa chỉ MAC'))}</th><th>${esc(t('Tên miền / Hostname'))}</th><th>${esc(t('SSID kết nối'))}</th><th>${esc(isEn ? 'Interface' : 'Giao diện')}</th><th>${esc(t('Phân loại'))}</th>
          </tr></thead><tbody>
          ${arpTable.map((aItem) => {
            const host = aItem.hostname ? `<b style="color:var(--text)">${esc(aItem.hostname)}</b>` : '<span class="muted">—</span>';
            const ssidBadge = aItem.ssid ? `<span class="badge" style="background:var(--panel2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--c-low)">📶 ${esc(aItem.ssid)}</span>` : '<span class="muted">—</span>';
            const typeCol = aItem.type === 'Dynamic (Động)' || aItem.type === 'Dynamic' ? 'var(--c-ok)' : (aItem.type && aItem.type.includes('Wireless') ? 'var(--c-low)' : 'var(--muted)');
            return `<tr class="arp-row" data-q="${esc(`${aItem.ip} ${aItem.mac} ${aItem.hostname || ''} ${aItem.ssid || ''}`.toLowerCase())}">
              <td><code><b>${esc(aItem.ip)}</b></code></td>
              <td><code>${esc(aItem.mac)}</code></td>
              <td>${host}</td>
              <td>${ssidBadge}</td>
              <td><span class="muted">${esc(aItem.interface || '—')}</span></td>
              <td><span style="color:${typeCol};font-weight:600">${esc(aItem.type || 'Dynamic')}</span></td>
            </tr>`;
          }).join('')}
          </tbody></table></div>`;
        } else {
          html += `<div class="muted" style="padding:10px 0">${esc(t('Thiết bị hiện chưa ghi nhận bản ghi ARP nào hoặc không có dữ liệu phản hồi từ SNMP.'))}</div>`;
        }
      }
      if (d.snmp_enabled) html += this.snmpSection(d, kv);
      if (d.agent_token) {
        html += `<h2>Agent token</h2><details><summary class="muted">${esc(t('Hiện token (bí mật)'))}</summary><code style="word-break:break-all">${esc(d.agent_token)}</code>
          <div style="margin-top:6px"><button class="btn sm danger" id="d-regen">${esc(t('Tạo token mới'))}</button></div></details>`;
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
      const isEn = M.S.lang === 'en';
      let h = '<h2>SNMP</h2>';
      if (d.snmp_error) h += `<div class="reason">• ${isEn ? 'Last SNMP poll failed' : 'Lần đọc SNMP gần nhất lỗi'}: ${esc(tr(d.snmp_error.message))}</div>`;
      if (s) {
        h += `<dl class="kv">${kv('sysName', s.sysName)}${kv('sysDescr', s.sysDescr)}${kv('sysObjectID', s.sysObjectID)}
          ${pr ? kv('Hồ sơ đang dùng', `${pr.name} (${pr.auto ? t('tự nhận diện') : t('chọn tay')})`) : ''}</dl>`;
        if (pr && pr.missing) h += `<div class="reason">• ${isEn ? `Selected profile "${esc(pr.requested)}" no longer exists, falling back to auto-detect.` : `Hồ sơ đã chọn "${esc(pr.requested)}" không còn tồn tại, đang tự nhận diện.`}</div>`;
        const rows = Object.entries(s.diag || {}).map(([k, m]) => {
          const val = (x) => (k === 'uptime' ? M.fmtDur(x) : `${x}${m.unit || ''}`);
          if (m.ok) {
            const note = [m.source > 0 ? (isEn ? `fallback source #${m.source + 1}` : `nguồn dự phòng #${m.source + 1}`) : '', m.unverified ? t('chưa kiểm chứng') : ''].filter(Boolean).join(' · ');
            return `<tr><td>${esc(m.label)}</td><td><b>${esc(val(m.value))}</b></td><td class="muted">${esc(note)}</td></tr>`;
          }
          const tried = (m.tried || []).map((trOid) => trOid.oid).join(', ');
          return `<tr><td>${esc(m.label)}</td><td>—</td><td class="${m.optional ? 'muted' : ''}" ${m.optional ? '' : 'style="color:var(--c-high)"'}>
            ${esc(m.optional ? t('Không có: ') : t('Không đọc được: '))}${esc(tr(m.message))}<br><span class="muted">${esc(t('đã thử OID: '))}${esc(tried)}</span></td></tr>`;
        });
        if (rows.length) h += `<table class="tbl"><thead><tr><th>${esc(t('Chỉ số'))}</th><th>${esc(t('Giá trị'))}</th><th>${esc(t('Ghi chú / lý do'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
      } else if (!d.snmp_error) h += `<div class="muted">${esc(t('Chưa có dữ liệu SNMP.'))}</div>`;
      if (M.S.user.role === 'admin') {
        const opts = (M.profiles || []).map((p) => `<option value="${esc(p.id)}" ${p.id === d.snmp_profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        h += `<div class="row" style="margin-top:10px"><select class="sel" id="d-prof" title="${esc(t('Hồ sơ SNMP'))}"><option value="">${esc(t('Tự nhận diện'))}</option>${opts}</select>
          <button class="btn sm" id="d-walk">${esc(t('Xuất dữ liệu SNMP'))}</button></div>
          <div class="muted" style="font-size:12px;margin-top:4px">${esc(t('Nhận diện sai? Chọn hồ sơ khác. Thiết bị chưa được hỗ trợ? Xuất dữ liệu SNMP và gửi file .walk cho nhà phát triển.'))}</div>`;
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
        btn.disabled = true; btn.textContent = t('Đang đọc thiết bị...');
        try {
          const r = await fetch(`/api/devices/${d.id}/snmp-walk`, { method: 'POST', headers: { 'X-Requested-With': 'monitor' }, credentials: 'same-origin' });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await r.blob());
          a.download = `${d.name.replace(/[^\w.-]+/g, '-')}.walk`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          M.toast('Đã xuất file .walk');
        } catch (e) { M.toast(e.message); } finally { btn.disabled = false; btn.textContent = t('Xuất dữ liệu SNMP'); }
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
          if (has('toner')) pSeries.push({ key: 'toner', color: 'var(--c-low)', label: t('Mực in (%)') });
          if (has('drum')) pSeries.push({ key: 'drum', color: 'var(--c-maint)', label: t('Độ bền Drum (%)') });
          html += `<h2>${esc(t('Lịch sử tiêu hao Vật tư (Mực in & Drum %)'))}</h2>${M.chart(points, pSeries, this.range, 100)}`;
        }
        if (has('ram')) {
          html += `<h2>${esc(t('Lịch sử sử dụng Bộ nhớ máy in (RAM %)'))}</h2>${M.chart(points, [{ key: 'ram', color: 'var(--c-medium)', label: t('RAM máy in (%)') }], this.range, 100)}`;
        }
      } else {
        if (has('cpu')) html += `<h2>${esc(t('CPU / RAM / Ổ đĩa (%)'))}</h2>${M.chart(points, [{ key: 'cpu', color: 'var(--c-low)', label: 'CPU' }, { key: 'ram', color: 'var(--c-medium)', label: 'RAM' }, { key: 'disk', color: 'var(--c-high)', label: 'Disk' }], this.range, 100)}`;
        if (has('rtt')) html += `<h2>${esc(t('Độ trễ ping (ms)'))}</h2>${M.chart(points, [{ key: 'rtt', color: 'var(--c-ok)', label: 'RTT' }], this.range)}`;
        if (has('net_in') || has('net_out')) {
          html += `<h2>${esc(t('Tổng băng thông sử dụng'))}</h2>${M.chart(points, [
            { key: 'net_in', color: 'var(--c-low)', label: 'Download' },
            { key: 'net_out', color: 'var(--c-maint)', label: 'Upload' },
          ], this.range, null, M.fmtRate)}`;
        }
        if (has('temp')) {
          html += `<h2>${esc(t('Nhiệt độ CPU (°C)'))}</h2>${M.chart(points, [{ key: 'temp', color: 'var(--c-high)', label: t('Nhiệt độ (°C)') }], this.range, 120, (v) => `${Math.round(v)}°`)}`;
        }
        if (has('toner') || has('drum')) {
          const pSeries = [];
          if (has('toner')) pSeries.push({ key: 'toner', color: 'var(--c-low)', label: t('Mực in (%)') });
          if (has('drum')) pSeries.push({ key: 'drum', color: 'var(--c-maint)', label: t('Độ bền Drum (%)') });
          html += `<h2>${esc(t('Lịch sử Mực in & Độ bền Drum (%)'))}</h2>${M.chart(points, pSeries, this.range, 100)}`;
        }
      }
      $('#d-charts').innerHTML = html || `<div class="muted" style="padding:20px">${esc(t('Chưa có dữ liệu lịch sử'))}</div>`;
    },
    async loadEvents() {
      if (!$('#d-events')) return;
      const { events } = await M.api('GET', `/api/events?device=${this.id}&limit=15`);
      if ($('#d-events')) $('#d-events').innerHTML = M.eventsTable(events, false);
    },
  };

  // ---------- events & integrated AI reports ----------
  M.views.events = {
    subTab: 'events', // 'events' | 'ai'
    aiKind: '',
    async render(el, sub) {
      if (sub === 'ai') this.subTab = 'ai';
      else if (sub === 'events' || !sub) this.subTab = 'events';
      clearInterval(this.t);
      this.t = null;
      const isEn = M.S.lang === 'en';
      const canOp = M.S.user && M.S.user.role !== 'viewer';
      el.innerHTML = `<div class="row" style="margin-bottom:12px">
        <h1 style="margin:0">${esc(t('Nhật ký sự kiện'))}</h1>
        <div class="ai-subtabs">
          <button type="button" id="ev-tab-list" class="${this.subTab === 'events' ? 'active' : ''}">📋 ${isEn ? 'Event Log' : 'Nhật ký sự kiện'}</button>
          <button type="button" id="ev-tab-ai" class="${this.subTab === 'ai' ? 'active' : ''}">🤖 ${isEn ? 'AI Reports & Daily Digest' : 'Báo cáo & Dự đoán AI'}</button>
        </div>
        <span class="spacer"></span>
        <div id="ev-filters" class="${this.subTab === 'events' ? '' : 'hidden'}">
          <select class="sel" id="ev-kind"><option value="">${esc(t('Tất cả'))}</option><option value="down">${esc(t('Mất kết nối'))}</option><option value="warning">${esc(t('Cảnh báo'))}</option><option value="dos">${esc(t('Tấn công DoS'))}</option><option value="power">${esc(t('Mất điện lưới'))}</option><option value="smart">${esc(t('Lỗi đĩa cứng'))}</option><option value="thermal">${esc(t('Quá nhiệt'))}</option><option value="up">${esc(t('Phục hồi'))}</option><option value="audit">${esc(t('Hệ thống'))}</option></select>
        </div>
        <div id="ai-filters" class="row ${this.subTab === 'ai' ? '' : 'hidden'}">
          <select class="sel" id="ai-kind-sel">
            <option value="" ${this.aiKind === '' ? 'selected' : ''}>${isEn ? 'All AI Reports' : 'Tất cả báo cáo AI'}</option>
            <option value="daily" ${this.aiKind === 'daily' ? 'selected' : ''}>📊 ${isEn ? 'End-of-Day Digests (24h)' : 'Báo cáo cuối ngày (24h)'}</option>
            <option value="incident" ${this.aiKind === 'incident' ? 'selected' : ''}>🚨 ${isEn ? 'Incident Diagnoses' : 'Chẩn đoán sự cố'}</option>
          </select>
          ${canOp ? `<button type="button" class="btn primary" id="btn-run-digest">📊 ${isEn ? 'Collect Logs & Run Daily Digest' : 'Thu thập Log & Phân tích Cuối ngày'}</button>` : ''}
        </div>
      </div>
      <div id="ai-stats-wrap" class="${this.subTab === 'ai' ? '' : 'hidden'}"></div>
      <div class="panel" id="ev-body"></div>`;

      $('#ev-tab-list').onclick = () => {
        this.subTab = 'events';
        if (location.hash !== '#/events') location.hash = '#/events';
        else this.render(el, 'events');
      };
      $('#ev-tab-ai').onclick = () => {
        this.subTab = 'ai';
        if (location.hash !== '#/events/ai') location.hash = '#/events/ai';
        else this.render(el, 'ai');
      };
      const evKind = $('#ev-kind');
      if (evKind) evKind.onchange = () => this.load();
      const aiKindSel = $('#ai-kind-sel');
      if (aiKindSel) aiKindSel.onchange = (e) => { this.aiKind = e.target.value; this.load(); };
      const runDigestBtn = $('#btn-run-digest');
      if (runDigestBtn) {
        runDigestBtn.onclick = async () => {
          runDigestBtn.disabled = true;
          const orig = runDigestBtn.textContent;
          runDigestBtn.textContent = isEn ? '⏳ Analyzing 24h logs...' : '⏳ Đang tổng hợp log 24h...';
          try {
            await M.api('POST', '/api/ai/daily-digest', { lang: M.S.lang });
            M.toast(isEn ? 'Generated End-of-Day AI Digest' : 'Đã tạo báo cáo phân tích cuối ngày');
            await this.load();
          } catch (err) {
            M.toast(M.trData(err.message));
          } finally {
            runDigestBtn.disabled = false;
            runDigestBtn.textContent = orig;
          }
        };
      }
      await this.load();
      this.t = setInterval(() => this.load(), 10000);
    },
    destroy() {
      clearInterval(this.t);
      this.t = null;
    },
    async load() {
      const isEn = M.S.lang === 'en';
      if (this.subTab === 'ai') {
        try {
          const q = this.aiKind ? `?kind=${encodeURIComponent(this.aiKind)}&limit=100` : '?limit=100';
          const { reports, stats, ai } = await M.api('GET', `/api/ai/reports${q}`);
          const statsWrap = $('#ai-stats-wrap');
          if (statsWrap && stats && ai) {
            const stBadge = ai.enabled
              ? `<span class="sev-badge ok">● ${isEn ? 'AI API Enabled' : 'API AI Đang bật'}</span>`
              : `<span class="sev-badge medium">○ ${isEn ? 'AI API Disabled (Smart Fallback Active)' : 'Đã tắt gọi API AI (Đang dùng Chuyên gia nội bộ 0 token)'}</span>`;
            const dailyBadge = ai.daily_digest_enabled
              ? `<span class="sev-badge low">🕒 ${isEn ? `Auto Daily Digest: ${ai.daily_digest_time}` : `Tự động tổng hợp cuối ngày: ${ai.daily_digest_time}`}</span>`
              : `<span class="muted">🕒 ${isEn ? 'Auto Daily Digest: Off' : 'Tự động báo cáo cuối ngày: Tắt'}</span>`;
            statsWrap.innerHTML = `<div class="ai-stats-bar">
              ${stBadge}
              ${dailyBadge}
              <span><b>${isEn ? 'API Calls Today:' : 'Lượt gọi API hôm nay:'}</b> ${stats.calls_today} / ${ai.daily_call_limit}</span>
              <span><b>${isEn ? 'Tokens Used Today:' : 'Token dùng hôm nay:'}</b> ${Number(stats.tokens_today || 0).toLocaleString()}</span>
              <span><b>${isEn ? 'Cache Hits (0 tokens):' : 'Lượt Cache tiết kiệm (0 token):'}</b> ${stats.cached_today || 0}</span>
              <span class="spacer"></span>
              ${M.S.user && M.S.user.role === 'admin' ? `<a href="#/settings" class="btn sm">⚙️ ${isEn ? 'Configure AI' : 'Cài đặt AI'}</a>` : ''}
            </div>`;
          }
          if ($('#ev-body')) {
            $('#ev-body').innerHTML = reports && reports.length
              ? reports.map((r) => M.renderAiReportCard(r, true)).join('')
              : `<div class="muted" style="padding:18px;text-align:center">${isEn
                ? 'No AI reports yet. High/Critical incidents are analyzed automatically, or click "Collect Logs & Run Daily Digest" above.'
                : 'Chưa có báo cáo AI nào. Các sự cố mức Cao & Nghiêm trọng sẽ tự động được phân tích, hoặc bạn có thể bấm nút "Thu thập Log & Phân tích Cuối ngày" ở trên.'}</div>`;
          }
        } catch (err) {
          if ($('#ev-body')) {
            $('#ev-body').innerHTML = `<div class="panel err" style="margin:12px 0">${esc(M.trData(err.message))}</div>`;
          }
        }
        return;
      }
      try {
        const { events } = await M.api('GET', '/api/events?limit=300');
        const k = $('#ev-kind') && $('#ev-kind').value;
        if ($('#ev-body')) $('#ev-body').innerHTML = M.eventsTable(k ? events.filter((e) => e.kind === k) : events, true);
      } catch (err) {
        if ($('#ev-body')) {
          $('#ev-body').innerHTML = `<div class="panel err" style="margin:12px 0">${esc(M.trData(err.message))}</div>`;
        }
      }
    },
  };

  // ---------- KPI details popup ----------
  function getDeviceAlertDetails(d) {
    const items = [];
    const isEn = M.S.lang === 'en';
    const numLoc = isEn ? 'en-US' : 'vi-VN';
    const thConf = (typeof th === 'function' ? th() : null) || (M.S.settings && M.S.settings.thresholds) || { cpu: 90, ram: 90, disk: 90, temp: 85 };

    // 1. Deep monitoring flags
    if ((d.alerts && d.alerts.dos) || d.dos_alert) {
      const ppsStr = d.pkt_rate ? `${d.pkt_rate.toLocaleString(numLoc)} ${isEn ? 'pkt/s' : 'gói/giây'}` : (isEn ? 'High traffic' : 'Lưu lượng cao');
      const detailStr = d.dos_details ? ` - ${tr(d.dos_details)}` : '';
      items.push({
        icon: '🛡️',
        title: isEn ? 'Flood/DoS Attack' : 'Tấn công Flood/DoS',
        text: isEn ? `Suspected network flood (${ppsStr}${detailStr})` : `Nghi ngờ tấn công mạng (lưu lượng ${ppsStr}${detailStr})`,
        cls: 'crit',
      });
    }
    if ((d.alerts && d.alerts.power) || (d.power && d.power.on_battery)) {
      const bat = d.power && d.power.battery_percent != null ? (isEn ? ` (battery ${d.power.battery_percent}%)` : ` (pin còn ${d.power.battery_percent}%)`) : '';
      items.push({
        icon: '🔋',
        title: t('Mất điện lưới'),
        text: isEn ? `Running on UPS backup battery${bat}` : `Đang chạy nguồn pin dự phòng UPS${bat}`,
        cls: 'crit',
      });
    }
    if ((d.alerts && d.alerts.smart) || (d.smart && d.smart.ok === false)) {
      items.push({
        icon: '💾',
        title: isEn ? 'Disk SMART Error' : 'Lỗi ổ đĩa SMART',
        text: (d.smart && d.smart.details) || (isEn ? 'Bad Sectors or imminent disk failure detected' : 'Phát hiện Bad Sector hoặc đĩa sắp hỏng'),
        cls: 'crit',
      });
    }
    if ((d.alerts && d.alerts.thermal) || (d.temperature != null && d.temperature >= thConf.temp)) {
      items.push({
        icon: '🔥',
        title: isEn ? 'CPU Overheating' : 'Nhiệt độ CPU quá cao',
        text: isEn ? `Current temperature: ${Math.round(d.temperature)}°C (exceeds safe threshold ${thConf.temp}°C)` : `Nhiệt độ hiện tại: ${Math.round(d.temperature)}°C (vượt ngưỡng an toàn ${thConf.temp}°C)`,
        cls: 'crit',
      });
    }

    // 2. Printer specific alerts
    if (d.printer_errors && d.printer_errors.length) {
      d.printer_errors.forEach((err) => {
        items.push({ icon: '⚠️', title: t('Sự cố máy in'), text: tr(err), cls: 'crit' });
      });
    }
    if (d.toner != null && d.toner >= 0 && d.toner <= 10) {
      items.push({
        icon: '🖨️',
        title: isEn ? 'Low Toner' : 'Lượng mực in sắp hết',
        text: isEn ? `Toner cartridge at ${d.toner}%, prepare replacement` : `Hộp mực chỉ còn ${d.toner}%, cần chuẩn bị mực thay thế`,
        cls: d.toner === 0 ? 'crit' : 'hi',
      });
    }
    if (d.drum != null && d.drum >= 0 && d.drum <= 10) {
      items.push({
        icon: '🔄',
        title: isEn ? 'Low Drum Life' : 'Tuổi thọ Drum sắp hết',
        text: isEn ? `Drum unit life at ${d.drum}%, replace drum soon` : `Độ bền trống từ chỉ còn ${d.drum}%, cần thay drum`,
        cls: d.drum === 0 ? 'crit' : 'hi',
      });
    }

    // 3. Reasons (thresholds, agent silence, ICMP, etc.)
    if (d.reasons && d.reasons.length) {
      d.reasons.forEach((r) => {
        const trR = tr(r);
        const isDup = items.some((it) => it.text.includes(r) || it.text.includes(trR) || r.includes(it.title) || it.title.includes(r));
        if (!isDup) {
          const isCrit = r.toLowerCase().includes('critical') || r.toLowerCase().includes('khẩn');
          items.push({ icon: '⚠️', title: isEn ? 'System Warning' : 'Cảnh báo hệ thống', text: trR, cls: isCrit ? 'crit' : 'hi' });
        }
      });
    }

    if (!items.length && d.status === 'warning') {
      items.push({ icon: '⚠️', title: t('Cảnh báo'), text: isEn ? 'Device has an active operational warning' : 'Thiết bị đang ghi nhận cảnh báo hoạt động', cls: 'hi' });
    }

    return items;
  }

  M.showKpiModal = (kpiKey, snap) => {
    if (!snap) snap = M.S.snap || { devices: [], summary: {} };
    const allDevs = snap.devices || [];
    const isEn = M.S.lang === 'en';
    const numLoc = isEn ? 'en-US' : 'vi-VN';

    let title = '';
    let list = [];
    let emptyIcon = '✅';
    let emptyTitle = '';
    let emptyText = '';
    let isWarningModal = false;

    if (kpiKey === 'down') {
      title = t('Thiết bị Mất kết nối');
      list = allDevs.filter((d) => d.status === 'down');
      emptyIcon = '✅';
      emptyTitle = t('Tất cả thiết bị đang kết nối tốt!');
      emptyText = t('Hiện tại không có thiết bị nào bị ngắt kết nối mạng hoặc mất tín hiệu.');
    } else if (kpiKey === 'warn') {
      title = t('Thiết bị đang Cảnh báo');
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
      emptyTitle = t('Hệ thống an toàn, không có cảnh báo!');
      emptyText = t('Tất cả thông số vận hành (CPU, RAM, Đĩa, Mực in, Drum, Cảm biến,...) đều ở mức an toàn.');
    } else if (kpiKey === 'unk') {
      title = t('Thiết bị Chưa rõ / Bảo trì');
      list = allDevs.filter((d) => d.status === 'unknown' || d.status === 'maint');
      emptyIcon = '👌';
      emptyTitle = t('Không có thiết bị cần lưu ý!');
      emptyText = t('Hiện không có thiết bị nào đang trong chế độ bảo trì hoặc chưa rõ dữ liệu.');
    } else {
      title = t('Tất cả thiết bị đang Hoạt động');
      list = allDevs.filter((d) => d.status === 'up' || d.status === 'warning');
      emptyIcon = 'ℹ️';
      emptyTitle = t('Chưa có thiết bị nào hoạt động');
      emptyText = t('Hãy kiểm tra lại danh sách thiết bị hoặc thêm thiết bị mới vào hệ thống.');
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
        ? `<div style="margin-bottom:12px"><input class="inp" id="kpi-modal-search" placeholder="${esc(t('🔍 Lọc thiết bị theo tên, IP, loại...'))}" style="width:100%"></div>`
        : '';

      const itemsHtml = list.map((d) => {
        const typeIcon = M.ICON[d.type] || '📟';
        const typeName = M.TYPE_NAME[d.type] || d.type;

        let statusBadge = '';
        if (d.status === 'down') {
          statusBadge = `<span class="sev-badge critical ev-down">${esc(t('Mất kết nối'))}</span>`;
        } else if (d.status === 'warning') {
          statusBadge = `<span class="sev-badge medium ev-warning">${esc(t('Cảnh báo'))}</span>`;
        } else if (d.status === 'maint') {
          statusBadge = `<span class="sev-badge maint">${esc(t('Bảo trì'))}</span>`;
        } else if (d.status === 'unknown') {
          statusBadge = `<span class="sev-badge none">${esc(t('Chưa rõ'))}</span>`;
        } else {
          statusBadge = `<span class="sev-badge ok ev-up">${esc(t('Online'))}</span>`;
        }

        let detailSection = '';
        if (kpiKey === 'down') {
          const ago = M.fmtDur((Date.now() - d.since) / 1000);
          const reason = (d.reasons && d.reasons.length) ? d.reasons.map(tr).join(' · ') : t('Không phản hồi ICMP / Mất tín hiệu agent');
          detailSection = `
            <div class="kpi-alert-list">
              <div class="kpi-alert-item crit">
                <span class="kpi-alert-item-icon">⚠️</span>
                <div>
                  <span class="kpi-alert-item-title">${esc(t('Lý do:'))}</span>
                  <span class="kpi-alert-item-text">${esc(reason)}</span>
                </div>
              </div>
              <div class="muted" style="font-size:12px">${isEn ? `Disconnected for: <b>${ago}</b> (since ${M.fmtTime(d.since)})` : `Mất kết nối từ: <b>${ago}</b> trước (lúc ${M.fmtTime(d.since)})`}</div>
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
            ? t('Thiết bị đang đặt ở chế độ bảo trì (đã tạm ngắt cảnh báo âm thanh & thông báo).')
            : t('Chưa nhận được dữ liệu giám sát hoặc thiết bị mới được thêm vào.');
          detailSection = `<div class="muted" style="font-size:13px">${esc(desc)}</div>`;
        } else {
          const parts = [];
          if (d.rtt != null) parts.push(`Ping: ${d.rtt} ms`);
          if (d.uptime != null) parts.push(`Uptime: ${M.fmtDur(d.uptime)}`);
          if (d.type === 'printer') {
            if (d.toner != null) parts.push(`${t('Mực')}: ${d.toner}%`);
            if (d.drum != null) parts.push(`Drum: ${d.drum}%`);
            if (d.page_count != null) parts.push(`${Number(d.page_count).toLocaleString(numLoc)} ${t('trang')}`);
          } else {
            if (d.cpu != null) parts.push(`CPU: ${Math.round(d.cpu)}%`);
            if (d.ram != null) parts.push(`RAM: ${Math.round(d.ram)}%`);
            if (d.disk != null) parts.push(`Disk: ${Math.round(d.disk)}%`);
            if (d.temperature != null) parts.push(`Temp: ${Math.round(d.temperature)}°C`);
          }
          detailSection = `<div class="muted" style="font-size:13px">${esc(parts.join(' · ') || t('Đang phản hồi tốt'))}</div>`;
        }

        return `
          <div class="kpi-dev-item">
            <div class="kpi-dev-top">
              <div class="kpi-dev-main">
                <span style="font-size:18px">${typeIcon}</span>
                <a href="#/device/${d.id}" class="kpi-dev-name" title="${esc(d.name)}">${esc(d.name)}</a>
                ${statusBadge}
              </div>
              <a href="#/device/${d.id}" class="btn sm">${esc(t('Xem chi tiết →'))}</a>
            </div>
            <div class="kpi-dev-meta">${esc(d.address)} · ${esc(typeName)}${d.location ? ` · ${esc(d.location)}` : ''}</div>
            ${detailSection}
          </div>`;
      }).join('');

      bodyHtml = `
        <div class="kpi-modal-head">
          <span class="muted" style="font-size:14px">${isEn ? `Showing <b>${list.length}</b> device(s)` : `Hiển thị <b>${list.length}</b> thiết bị`}</span>
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
