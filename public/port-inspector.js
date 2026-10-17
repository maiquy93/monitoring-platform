'use strict';
// Isolated Frontend Module: Switch / Router Per-Port Inspector (Faceplate Grid + Traffic Table).
// Zero Impact Core & UI Isolation: opens in an independent modal from Device Detail view.
(() => {
  if (typeof window === 'undefined' || !window.M) return;
  const { esc, $, $$ } = M;

  function injectPortInspectorStyles() {
    if (document.getElementById('port-inspector-styles')) return;
    const style = document.createElement('style');
    style.id = 'port-inspector-styles';
    style.textContent = `
      .pi-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(125px, 1fr)); gap:8px; margin-bottom:12px; }
      .pi-kpi { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:8px 10px; text-align:center; }
      .pi-kpi .pk-lbl { font-size:11px; color:var(--muted); text-transform:uppercase; }
      .pi-kpi .pk-val { font-size:19px; font-weight:700; margin-top:2px; }
      .pi-faceplate { display:grid; grid-template-columns:repeat(auto-fill, minmax(74px, 1fr)); gap:6px; background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:12px; max-height:190px; overflow-y:auto; }
      .pi-port-box { border:1px solid var(--border); border-radius:6px; padding:5px 6px; text-align:center; cursor:pointer; background:var(--bg); transition:transform .12s ease, border-color .12s ease; user-select:none; }
      .pi-port-box:hover { transform:translateY(-1px); border-color:var(--c-low); }
      .pi-port-box.st-up { border-color:var(--c-ok); background:rgba(34,197,94,0.1); }
      .pi-port-box.st-warn { border-color:var(--c-medium); background:rgba(245,158,11,0.14); }
      .pi-port-box.st-err { border-color:var(--c-critical); background:rgba(239,68,68,0.16); }
      .pi-port-box.st-down { opacity:0.65; }
      .pi-port-box.st-admdown { opacity:0.4; border-style:dashed; }
      .pi-port-box .pb-name { font-size:11px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .pi-port-box .pb-spd { font-size:10px; color:var(--muted); margin-top:2px; }
      .pi-tbl-wrap { max-height:310px; overflow:auto; border:1px solid var(--border); border-radius:8px; }
    `;
    document.head.appendChild(style);
  }

  M.openPortInspectorModal = async (deviceOrId) => {
    injectPortInspectorStyles();
    const isEn = M.S.lang === 'en';
    const allDevs = (M.S.snap && M.S.snap.devices) ? M.S.snap.devices : [];
    const d = typeof deviceOrId === 'object' ? deviceOrId : allDevs.find((x) => x.id === Number(deviceOrId));
    if (!d) return;

    let filterMode = 'all';
    let searchQuery = '';
    let autoRefresh = true;
    let timer = null;
    let lastData = null;

    const html = `
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <span class="chip">🌐 ${esc(d.address)}</span>
        <select class="sel" id="pi-filter-sel">
          <option value="all">${isEn ? 'All Interfaces' : 'Tất cả cổng mạng'}</option>
          <option value="up">${isEn ? '🟢 Active (UP)' : '🟢 Đang kết nối (UP)'}</option>
          <option value="down">${isEn ? '⚪ Disconnected (DOWN)' : '⚪ Không cắm dây (DOWN)'}</option>
          <option value="issues">${isEn ? '⚠️ Errors / High Load / Flapping' : '⚠️ Có lỗi gói / Tải cao / Chập chờn'}</option>
        </select>
        <input class="inp" id="pi-search-inp" placeholder="${isEn ? '🔍 Search port name, alias, MAC...' : '🔍 Tìm tên cổng, mô tả (alias), MAC...'}" style="flex:1;min-width:180px">
        <label class="field inline" style="margin:0;font-size:12px">
          <input type="checkbox" id="pi-auto-chk" checked>
          <span>${isEn ? 'Auto-refresh (4s)' : 'Tự làm mới (4s)'}</span>
        </label>
        <button type="button" class="btn sm primary" id="pi-refresh-btn">🔄 ${isEn ? 'Refresh Now' : 'Đọc lại ngay'}</button>
      </div>
      <div id="pi-body">
        <div class="muted" style="padding:32px;text-align:center">⏳ ${isEn ? 'Polling SNMP IF-MIB & ifXTable...' : 'Đang đọc bảng cổng mạng SNMP (IF-MIB & ifXTable)...'}</div>
      </div>
    `;

    const { form } = M.modal(
      isEn ? `🔌 Switch / Router Port Inspector — ${d.name}` : `🔌 Giám sát Chi tiết Cổng mạng (Port Inspector) — ${d.name}`,
      html,
      async () => {},
      { submit: isEn ? 'Close' : 'Đóng', noCancel: true, wide: true }
    );

    const bodyEl = $('#pi-body', form);
    const filterSel = $('#pi-filter-sel', form);
    const searchInp = $('#pi-search-inp', form);
    const autoChk = $('#pi-auto-chk', form);
    const refreshBtn = $('#pi-refresh-btn', form);

    const paint = () => {
      if (!lastData || !bodyEl) return;
      const ports = Array.isArray(lastData.ports) ? lastData.ports : [];
      const q = searchQuery.toLowerCase().trim();

      const filtered = ports.filter((p) => {
        if (filterMode === 'up' && p.oper_status !== 'up') return false;
        if (filterMode === 'down' && p.oper_status === 'up') return false;
        if (filterMode === 'issues' && !(p.total_errors > 0 || p.flapping || (p.utilization_pct != null && p.utilization_pct >= 75))) return false;
        if (q) {
          const hay = `${p.name} ${p.descr} ${p.alias} ${p.mac} ${p.speed_label}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const faceHtml = ports.map((p) => {
        let cls = 'st-down';
        let ico = '⚪';
        if (p.admin_status !== 'up') { cls = 'st-admdown'; ico = '⚫'; }
        else if (p.flapping || p.total_errors > 0) { cls = 'st-err'; ico = '🔴'; }
        else if (p.oper_status === 'up' && p.utilization_pct != null && p.utilization_pct >= 75) { cls = 'st-warn'; ico = '🟡'; }
        else if (p.oper_status === 'up') { cls = 'st-up'; ico = '🟢'; }

        const tip = [
          `#${p.index} ${p.name}${p.alias ? ` (${p.alias})` : ''}`,
          `Status: ${p.oper_status.toUpperCase()} (${p.speed_label})`,
          p.rx_Bps != null ? `RX: ${M.fmtRate(p.rx_Bps)} | TX: ${M.fmtRate(p.tx_Bps)}` : '',
          p.total_errors > 0 ? `Errors: ${p.total_errors}` : '',
          p.flapping ? 'PORT FLAPPING DETECTED' : '',
        ].filter(Boolean).join(' · ');

        return `<div class="pi-port-box ${cls}" data-port-name="${esc(p.name)}" title="${esc(tip)}">
          <div class="pb-name">${ico} ${esc(p.name)}</div>
          <div class="pb-spd">${esc(p.oper_status === 'up' ? p.speed_label : (p.admin_status !== 'up' ? 'ADM OFF' : 'DOWN'))}</div>
        </div>`;
      }).join('');

      const rowsHtml = filtered.map((p) => {
        const stBadge = p.admin_status !== 'up'
          ? `<span class="sev-badge none">ADMIN DOWN</span>`
          : (p.oper_status === 'up'
            ? `<span class="sev-badge ok">UP</span>`
            : `<span class="sev-badge low">DOWN</span>`);

        const bwHtml = p.rx_Bps != null
          ? `<span style="color:var(--c-low)">↓ ${M.fmtRate(p.rx_Bps)}</span> · <span style="color:var(--c-maint)">↑ ${M.fmtRate(p.tx_Bps)}</span>${p.utilization_pct != null ? ` <span class="muted">(${p.utilization_pct}%)</span>` : ''}`
          : `<span class="muted" style="font-size:12px">${isEn ? 'Waiting 2nd sample...' : 'Đang đo mẫu thứ 2...'}</span>`;

        const totalTraffic = (p.in_octets != null || p.out_octets != null)
          ? `↓ ${M.fmtBytes(p.in_octets || 0)} / ↑ ${M.fmtBytes(p.out_octets || 0)}`
          : '—';

        const errFlags = [];
        if (p.flapping) errFlags.push(`<span class="sev-badge critical" title="${isEn ? 'Port state changed repeatedly' : 'Cổng chập chờn bật/tắt liên tục'}">⚡ FLAPPING</span>`);
        if (p.total_errors > 0) errFlags.push(`<span class="sev-badge high">Err: ${p.total_errors}</span>`);
        if (p.total_discards > 0) errFlags.push(`<span class="sev-badge medium">Drop: ${p.total_discards}</span>`);

        return `<tr>
          <td><b>${esc(p.name)}</b>${p.alias ? `<br><span class="muted" style="font-size:11px">${esc(p.alias)}</span>` : ''}</td>
          <td>${stBadge}</td>
          <td><b>${esc(p.speed_label)}</b></td>
          <td>${bwHtml}</td>
          <td class="muted" style="font-size:12px">${totalTraffic}</td>
          <td>${errFlags.length ? errFlags.join(' ') : `<span style="color:var(--c-ok);font-size:12px">0 lỗi</span>`}</td>
        </tr>`;
      }).join('');

      bodyEl.innerHTML = `
        <div class="pi-kpis">
          <div class="pi-kpi"><div class="pk-lbl">${isEn ? 'Total Ports' : 'Tổng số cổng'}</div><div class="pk-val">${lastData.total_ports}</div></div>
          <div class="pi-kpi"><div class="pk-lbl">${isEn ? 'Active (UP)' : 'Đang kết nối (UP)'}</div><div class="pk-val" style="color:var(--c-ok)">${lastData.up_count}</div></div>
          <div class="pi-kpi"><div class="pk-lbl">${isEn ? 'Link Down' : 'Không cắm (DOWN)'}</div><div class="pk-val">${lastData.down_count}</div></div>
          <div class="pi-kpi"><div class="pk-lbl">${isEn ? 'Errors / Flap' : 'Cổng lỗi / Chập chờn'}</div><div class="pk-val" style="color:${lastData.issue_count > 0 ? 'var(--c-critical)' : 'var(--c-ok)'}">${lastData.issue_count}</div></div>
        </div>
        <div class="pi-faceplate">${faceHtml}</div>
        <div class="pi-tbl-wrap">
          <table class="tbl" style="margin:0">
            <thead>
              <tr>
                <th>${isEn ? 'Interface / Alias' : 'Cổng / Mô tả'}</th>
                <th>${isEn ? 'State' : 'Trạng thái'}</th>
                <th>${isEn ? 'Link Speed' : 'Tốc độ Link'}</th>
                <th>${isEn ? 'Live Bandwidth (RX / TX)' : 'Băng thông tức thời (RX / TX)'}</th>
                <th>${isEn ? 'Cumulative Traffic' : 'Tổng lưu lượng (In / Out)'}</th>
                <th>${isEn ? 'Errors / Flapping' : 'Lỗi gói / Chập chờn'}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="6" class="muted" style="text-align:center">${isEn ? 'No matching interfaces' : 'Không có cổng mạng phù hợp'}</td></tr>`}</tbody>
          </table>
        </div>
      `;

      $$('.pi-port-box', bodyEl).forEach((box) => {
        box.onclick = () => {
          const pName = box.dataset.portName || '';
          searchInp.value = searchInp.value === pName ? '' : pName;
          searchQuery = searchInp.value;
          paint();
        };
      });
    };

    const loadPorts = async () => {
      if (!document.body.contains(form)) {
        clearInterval(timer);
        return;
      }
      if (refreshBtn) refreshBtn.disabled = true;
      try {
        lastData = await M.api('GET', `/api/devices/${d.id}/ports`);
        paint();
        // If this was the first sample (no bandwidth delta yet), schedule one fast follow-up poll in 1.2s
        if (lastData && !lastData.has_rate_sample && !form._secondSampleTriggered) {
          form._secondSampleTriggered = true;
          setTimeout(() => { if (document.body.contains(form)) loadPorts(); }, 1200);
        }
      } catch (err) {
        if (bodyEl && !lastData) {
          bodyEl.innerHTML = `<div class="panel err" style="margin:0">⚠️ ${esc(M.trData(err.message))}</div>`;
        }
      } finally {
        if (refreshBtn) refreshBtn.disabled = false;
      }
    };

    filterSel.onchange = () => { filterMode = filterSel.value; paint(); };
    searchInp.oninput = () => { searchQuery = searchInp.value; paint(); };
    autoChk.onchange = () => { autoRefresh = autoChk.checked; };
    refreshBtn.onclick = loadPorts;

    await loadPorts();
    timer = setInterval(() => {
      if (!document.body.contains(form)) { clearInterval(timer); return; }
      if (autoRefresh) loadPorts();
    }, 4000);
  };

  // ---- Non-Intrusive UI Hook into Device Detail View ------------------------
  function hookDeviceView() {
    if (M.views.device && !M.views.device._portInspectorHooked) {
      M.views.device._portInspectorHooked = true;
      const origPaint = M.views.device.paint;
      M.views.device.paint = function (...args) {
        const res = origPaint.apply(this, args);
        try {
          const d = this.D;
          const heroRow = $('#d-hero .hero > .row');
          const isNetDevice = d && d.address && (d.snmp_enabled || ['switch', 'router', 'firewall', 'ap'].includes(d.type));
          if (isNetDevice && heroRow && !$('#d-port-inspector')) {
            const isEn = M.S.lang === 'en';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn';
            btn.id = 'd-port-inspector';
            btn.title = isEn ? 'Inspect Switch/Router physical ports, link speed, bandwidth & flapping' : 'Soi chi tiết băng thông, tốc độ link, lỗi gói & trạng thái từng cổng Switch/Router';
            btn.textContent = isEn ? '🔌 Port Inspector' : '🔌 Soi cổng mạng';
            btn.onclick = () => M.openPortInspectorModal(d);
            const backBtn = $('#d-back', heroRow);
            if (backBtn) heroRow.insertBefore(btn, backBtn);
            else heroRow.appendChild(btn);
          }
        } catch { /* keep core view safe */ }
        return res;
      };
    }
  }

  hookDeviceView();
})();
