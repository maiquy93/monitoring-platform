'use strict';
// Isolated Frontend Module: LAN Subnet Auto-Discovery & Bulk Onboarding Modal.
// Zero Impact Core & UI Isolation: hooks into Devices admin view via a standalone button & modal.
(() => {
  if (typeof window === 'undefined' || !window.M) return;
  const { esc, $, $$ } = M;

  function injectDiscoveryStyles() {
    if (document.getElementById('discovery-module-styles')) return;
    const style = document.createElement('style');
    style.id = 'discovery-module-styles';
    style.textContent = `
      .disc-bar { display:grid; grid-template-columns:1.6fr 1fr auto; gap:10px; align-items:end; background:var(--panel2); padding:12px; border-radius:8px; border:1px solid var(--border); margin-bottom:12px; }
      @media (max-width:700px) { .disc-bar { grid-template-columns:1fr; } }
      .disc-tbl-wrap { max-height:340px; overflow:auto; border:1px solid var(--border); border-radius:8px; margin-bottom:12px; }
      .disc-summary { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:10px; font-size:13px; }
      .disc-row.exists { opacity:0.65; }
    `;
    document.head.appendChild(style);
  }

  M.openDiscoveryModal = async () => {
    injectDiscoveryStyles();
    const isEn = M.S.lang === 'en';
    if (!M.S.groups.length) {
      try { await M.loadGroups(); } catch { /* ignore */ }
    }

    let defaults = { subnet_cidr: '192.168.1.0/24', range_example: '192.168.1.1-192.168.1.254' };
    try {
      defaults = await M.api('GET', '/api/discovery/defaults');
    } catch { /* fallback */ }

    let discoveredHosts = [];

    const groupCheckboxes = M.S.groups.map((g) =>
      `<span class="field inline"><input type="checkbox" name="disc_grp" value="${g.id}" id="disc-g-${g.id}"><label for="disc-g-${g.id}">${esc(g.name)}</label></span>`
    ).join('');

    const html = `
      <p class="muted" style="margin:0 0 10px">
        ${isEn
          ? 'Scan an IPv4 CIDR subnet (/24) or IP range to automatically discover active hosts via ICMP Ping, SNMP v2c Vendor Profiles, and TCP service ports.'
          : 'Quét dải mạng IPv4 CIDR (/24) hoặc dải IP để tự động phát hiện thiết bị đang hoạt động qua ICMP Ping, nhận diện hãng/loại qua SNMP v2c và cổng dịch vụ TCP.'}
      </p>

      <div class="disc-bar">
        <div class="field" style="margin:0">
          <label>${isEn ? 'Subnet CIDR or IP Range *' : 'Dải mạng CIDR hoặc Khoảng IP *'}</label>
          <input class="inp" id="disc-target" value="${esc(defaults.subnet_cidr || '192.168.1.0/24')}" placeholder="192.168.1.0/24, 192.168.1.1-50">
        </div>
        <div class="field" style="margin:0">
          <label>${isEn ? 'SNMP Communities (comma-separated)' : 'SNMP Community cần thử'}</label>
          <input class="inp" id="disc-comm" value="public" placeholder="public, private">
        </div>
        <div>
          <button type="button" class="btn primary" id="disc-scan-btn">🚀 ${isEn ? 'Start Scan' : 'Bắt đầu quét mạng'}</button>
        </div>
      </div>

      <div id="disc-results-area">
        <div class="muted" style="padding:28px;text-align:center">
          ${isEn ? 'Click "Start Scan" to discover devices on your LAN.' : 'Nhấn "Bắt đầu quét mạng" để tự động dò tìm thiết bị trong mạng LAN.'}
        </div>
      </div>

      <div id="disc-import-bar" style="display:none;border-top:1px solid var(--border);padding-top:10px">
        ${groupCheckboxes ? `<div class="field" style="margin-bottom:10px"><label>${isEn ? 'Assign to Groups (optional):' : 'Gán vào Nhóm thiết bị (tùy chọn):'}</label><div class="row" style="flex-wrap:wrap;gap:8px">${groupCheckboxes}</div></div>` : ''}
        <div class="row" style="justify-content:space-between">
          <span id="disc-sel-count" class="muted" style="font-size:13px"></span>
          <button type="button" class="btn primary" id="disc-import-btn">➕ ${isEn ? 'Import Selected Devices' : 'Thêm các thiết bị đã chọn'}</button>
        </div>
      </div>
    `;

    const { form, close } = M.modal(
      isEn ? '🔍 LAN Subnet Auto-Discovery & Onboarding' : '🔍 Quét mạng LAN Tự động phát hiện Thiết bị (Auto-Discovery)',
      html,
      async () => {},
      { submit: isEn ? 'Close' : 'Đóng', noCancel: true, wide: true }
    );

    const targetInp = $('#disc-target', form);
    const commInp = $('#disc-comm', form);
    const scanBtn = $('#disc-scan-btn', form);
    const resArea = $('#disc-results-area', form);
    const importBar = $('#disc-import-bar', form);
    const importBtn = $('#disc-import-btn', form);
    const selCountSpan = $('#disc-sel-count', form);

    const typeSelectHtml = (selType, idx, disabled) => {
      const opts = Object.entries(M.TYPE_NAME).map(([k, v]) =>
        `<option value="${k}" ${k === selType ? 'selected' : ''}>${esc(v)}</option>`
      ).join('');
      return `<select class="sel inp disc-type-inp" data-idx="${idx}" style="padding:3px 6px;font-size:12px" ${disabled ? 'disabled' : ''}>${opts}</select>`;
    };

    const syncSelectedCount = () => {
      const checked = $$('.disc-chk:checked', resArea);
      if (selCountSpan) {
        selCountSpan.textContent = isEn
          ? `${checked.length} new device(s) selected for import`
          : `Đang chọn ${checked.length} thiết bị mới để thêm vào hệ thống`;
      }
      if (importBtn) importBtn.disabled = checked.length === 0;
    };

    const renderScanResults = (res) => {
      discoveredHosts = Array.isArray(res.hosts) ? res.hosts : [];
      if (!discoveredHosts.length) {
        importBar.style.display = 'none';
        resArea.innerHTML = `<div class="panel muted" style="text-align:center;padding:24px">
          ${isEn ? `Scanned ${res.scanned_count} IPs in ${res.duration_ms}ms — no active hosts responded.` : `Đã quét ${res.scanned_count} địa chỉ IP trong ${res.duration_ms}ms — không phát hiện thiết bị nào phản hồi.`}
        </div>`;
        return;
      }

      const rowsHtml = discoveredHosts.map((h, idx) => {
        const exists = !!h.already_exists;
        const protoBadges = [];
        if (h.check_icmp) protoBadges.push(`<span class="sev-badge ok">ICMP${h.rtt_ms != null ? ` ${h.rtt_ms}ms` : ''}</span>`);
        if (h.snmp_enabled) protoBadges.push(`<span class="sev-badge low" title="${esc(h.sys_descr || '')}">SNMP: ${esc(h.snmp_profile_name || 'OK')}</span>`);
        if (h.open_ports && h.open_ports.length) protoBadges.push(`<span class="sev-badge medium">TCP: ${h.open_ports.join(',')}</span>`);

        return `
          <tr class="disc-row ${exists ? 'exists' : ''}" data-idx="${idx}">
            <td>
              <input type="checkbox" class="disc-chk" data-idx="${idx}" ${exists ? 'disabled' : 'checked'}>
            </td>
            <td><code><b>${esc(h.ip)}</b></code></td>
            <td>
              <input class="inp disc-name-inp" data-idx="${idx}" value="${esc(h.existing_name || h.name)}" style="width:100%;min-width:140px;padding:3px 6px;font-size:12px" ${exists ? 'disabled' : ''}>
            </td>
            <td>${typeSelectHtml(h.type, idx, exists)}</td>
            <td><div style="display:flex;gap:4px;flex-wrap:wrap">${protoBadges.join('')}</div></td>
            <td>
              ${exists
                ? `<span class="muted" style="font-size:12px">✅ ${isEn ? 'Already in system' : 'Đã có trong hệ thống'}</span>`
                : `<span style="color:var(--c-ok);font-size:12px;font-weight:600">✨ ${isEn ? 'New' : 'Thiết bị mới'}</span>`}
            </td>
          </tr>
        `;
      }).join('');

      resArea.innerHTML = `
        <div class="disc-summary">
          <span>📡 <b>${isEn ? 'Scanned:' : 'Đã quét:'}</b> ${res.scanned_count} IP (${res.duration_ms} ms)</span>
          <span>🟢 <b>${isEn ? 'Active Hosts:' : 'Đang hoạt động:'}</b> ${res.found_count}</span>
          <span style="color:var(--c-ok)">✨ <b>${isEn ? 'New Devices:' : 'Thiết bị mới:'}</b> ${res.new_count}</span>
          <span class="spacer"></span>
          <button type="button" class="btn sm" id="disc-sel-all">${isEn ? 'Select All New' : 'Chọn tất cả mới'}</button>
          <button type="button" class="btn sm" id="disc-sel-none">${isEn ? 'Deselect All' : 'Bỏ chọn'}</button>
        </div>
        <div class="disc-tbl-wrap">
          <table class="tbl" style="margin:0">
            <thead>
              <tr>
                <th style="width:32px"></th>
                <th>IP</th>
                <th>${isEn ? 'Device Name' : 'Tên thiết bị'}</th>
                <th>${isEn ? 'Type' : 'Loại thiết bị'}</th>
                <th>${isEn ? 'Detected Protocols & SNMP Profile' : 'Giao thức & Hồ sơ SNMP phát hiện'}</th>
                <th>${isEn ? 'Status' : 'Trạng thái'}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;

      importBar.style.display = res.new_count > 0 ? '' : 'none';
      syncSelectedCount();

      $$('.disc-chk', resArea).forEach((chk) => { chk.onchange = syncSelectedCount; });
      const selAllBtn = $('#disc-sel-all', resArea);
      if (selAllBtn) selAllBtn.onclick = () => {
        $$('.disc-chk:not(:disabled)', resArea).forEach((c) => { c.checked = true; });
        syncSelectedCount();
      };
      const selNoneBtn = $('#disc-sel-none', resArea);
      if (selNoneBtn) selNoneBtn.onclick = () => {
        $$('.disc-chk', resArea).forEach((c) => { c.checked = false; });
        syncSelectedCount();
      };
    };

    scanBtn.onclick = async () => {
      const target = targetInp.value.trim();
      if (!target) {
        M.toast(isEn ? 'Please enter a subnet CIDR or IP range' : 'Vui lòng nhập dải mạng CIDR hoặc khoảng IP');
        return;
      }
      scanBtn.disabled = true;
      const origTxt = scanBtn.textContent;
      scanBtn.textContent = isEn ? '⏳ Scanning LAN...' : '⏳ Đang quét mạng...';
      importBar.style.display = 'none';
      resArea.innerHTML = `<div class="muted" style="padding:32px;text-align:center">⏳ ${isEn ? `Scanning ${esc(target)} (ICMP + SNMP + TCP)... Please wait.` : `Đang quét dải ${esc(target)} (ICMP + SNMP + TCP)... Vui lòng đợi trong giây lát.`}</div>`;
      try {
        const res = await M.api('POST', '/api/discovery/scan', {
          target,
          communities: commInp.value.trim() || 'public',
        });
        renderScanResults(res);
      } catch (err) {
        resArea.innerHTML = `<div class="panel err" style="margin:0">⚠️ ${esc(M.trData(err.message))}</div>`;
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = origTxt;
      }
    };

    if (importBtn) {
      importBtn.onclick = async () => {
        const selected = [];
        $$('.disc-chk:checked', resArea).forEach((chk) => {
          const idx = Number(chk.dataset.idx);
          const host = discoveredHosts[idx];
          if (!host || host.already_exists) return;
          const nameInp = $(`.disc-name-inp[data-idx="${idx}"]`, resArea);
          const typeInp = $(`.disc-type-inp[data-idx="${idx}"]`, resArea);
          selected.push({
            ...host,
            address: host.ip,
            name: (nameInp && nameInp.value.trim()) || host.name,
            type: (typeInp && typeInp.value) || host.type,
          });
        });

        if (!selected.length) return;
        const groups = $$('input[name="disc_grp"]:checked', form).map((c) => Number(c.value));
        importBtn.disabled = true;
        const origTxt = importBtn.textContent;
        importBtn.textContent = isEn ? '⏳ Importing...' : '⏳ Đang thêm thiết bị...';

        try {
          const res = await M.api('POST', '/api/discovery/import', { devices: selected, groups });
          await M.loadGroups();
          M.toast(isEn
            ? `Successfully imported ${res.added_count} new device(s)!`
            : `Đã thêm thành công ${res.added_count} thiết bị mới vào hệ thống!`);
          close();
          if (M.current === M.views.devices && M.views.devices.paint) M.views.devices.paint();
        } catch (err) {
          M.toast(M.trData(err.message));
          importBtn.disabled = false;
          importBtn.textContent = origTxt;
        }
      };
    }
  };

  // ---- Non-Intrusive UI Hook into Devices Admin Page ------------------------
  function hookDevicesView() {
    if (M.views.devices && !M.views.devices._discHooked) {
      M.views.devices._discHooked = true;
      const origRender = M.views.devices.render;
      M.views.devices.render = function (el, ...args) {
        const res = origRender.call(this, el, ...args);
        try {
          const isAdmin = M.S.user && M.S.user.role === 'admin';
          const topRow = $('.row', el);
          if (isAdmin && topRow && !$('#dl-auto-disc')) {
            const isEn = M.S.lang === 'en';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn';
            btn.id = 'dl-auto-disc';
            btn.textContent = isEn ? '🔍 Scan LAN (Auto-Discovery)' : '🔍 Quét mạng LAN';
            btn.onclick = () => M.openDiscoveryModal();
            const addBtn = $('#dl-add', topRow);
            if (addBtn) topRow.insertBefore(btn, addBtn);
            else topRow.appendChild(btn);
          }
        } catch { /* keep core view safe */ }
        return res;
      };
    }
  }

  hookDevicesView();
})();
