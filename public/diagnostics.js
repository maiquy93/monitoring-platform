'use strict';
// Isolated Frontend Module: Quick Diagnostic Toolkit (Popup Modal + Trigger Buttons).
// Zero Impact Core & UI Isolation: hooks non-intrusively into Device Detail & Devices table without modifying core views.
(() => {
  if (typeof window === 'undefined' || !window.M) return;
  const { esc, $, $$ } = M;

  const DEFAULT_PORTS_BY_TYPE = {
    printer: '80, 443, 515, 631, 9100',
    router: '22, 53, 80, 161, 443, 8080, 8291, 8728',
    switch: '22, 23, 80, 161, 443, 8080',
    firewall: '22, 80, 161, 443, 4443, 8443, 10443',
    ap: '22, 80, 443, 8080',
    server: '22, 53, 80, 161, 443, 3306, 3389, 5432, 6379, 8080',
    vm: '22, 53, 80, 161, 443, 3306, 3389, 5432, 8080',
    ups: '22, 80, 443, 3493',
    pc: '22, 80, 445, 3389, 5900',
  };

  function injectDiagStyles() {
    if (document.getElementById('diag-module-styles')) return;
    const style = document.createElement('style');
    style.id = 'diag-module-styles';
    style.textContent = `
      .diag-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 12px; border-bottom:1px solid var(--border); padding-bottom:10px; }
      .diag-tab-btn { padding:6px 12px; border-radius:6px; border:1px solid var(--border); background:var(--panel2); color:var(--text); cursor:pointer; font-weight:600; font-size:13px; transition:all .15s ease; }
      .diag-tab-btn:hover { border-color:var(--c-low); }
      .diag-tab-btn.active { background:var(--c-low); color:#04120a; border-color:var(--c-low); }
      .diag-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:var(--panel2); padding:10px 12px; border-radius:8px; border:1px solid var(--border); margin-bottom:12px; }
      .diag-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px; margin-bottom:12px; }
      .diag-kpi { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:8px 10px; text-align:center; }
      .diag-kpi .dk-lbl { font-size:11px; color:var(--muted); text-transform:uppercase; }
      .diag-kpi .dk-val { font-size:18px; font-weight:700; margin-top:2px; }
      .diag-term { background:#050b08; color:#8ef5a2; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; line-height:1.5; padding:12px; border-radius:8px; border:1px solid var(--border); max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin-top:8px; }
      .diag-tbl-wrap { max-height:280px; overflow:auto; border:1px solid var(--border); border-radius:8px; }
      .diag-port-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(165px, 1fr)); gap:8px; margin-top:8px; }
      .diag-port-card { padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--panel2); display:flex; align-items:center; justify-content:space-between; gap:6px; }
      .diag-port-card.open { border-color:var(--c-ok); background:rgba(34,197,94,0.08); }
      .diag-port-card.closed { opacity:0.75; }
    `;
    document.head.appendChild(style);
  }

  M.openDiagnosticsModal = (deviceOrId, initialTool = 'ping') => {
    injectDiagStyles();
    const isEn = M.S.lang === 'en';
    const allDevs = (M.S.snap && M.S.snap.devices ? M.S.snap.devices : []).filter((d) => d.address);
    let curDev = null;
    if (deviceOrId && typeof deviceOrId === 'object') {
      curDev = deviceOrId;
    } else if (deviceOrId) {
      curDev = allDevs.find((x) => x.id === Number(deviceOrId)) || null;
    }
    if (!curDev && allDevs.length) curDev = allDevs[0];
    if (!curDev) {
      M.toast(isEn ? 'No device with an IP address available for diagnostics' : 'Không có thiết bị nào có địa chỉ IP để chẩn đoán');
      return;
    }

    let activeTool = ['ping', 'traceroute', 'tcp', 'snmp'].includes(initialTool) ? initialTool : 'ping';
    let lastCopyText = '';

    const devOptionsHtml = allDevs.map((d) =>
      `<option value="${d.id}" ${d.id === curDev.id ? 'selected' : ''}>${esc(d.name)} (${esc(d.address)})</option>`
    ).join('');

    const html = `
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <label class="muted" style="font-size:13px">${isEn ? 'Target Device:' : 'Thiết bị mục tiêu:'}</label>
        <select class="sel inp" id="diag-dev-sel" style="min-width:240px;flex:1">${devOptionsHtml}</select>
        <span class="chip" id="diag-target-ip">🌐 ${esc(curDev.address)}</span>
      </div>

      <div class="diag-tabs">
        <button type="button" class="diag-tab-btn" data-diag-tab="ping">📡 Ping ICMP</button>
        <button type="button" class="diag-tab-btn" data-diag-tab="traceroute">🧭 Traceroute</button>
        <button type="button" class="diag-tab-btn" data-diag-tab="tcp">🔌 ${isEn ? 'Port Scanner (TCP/UDP)' : 'Kiểm tra Cổng (TCP/UDP)'}</button>
        <button type="button" class="diag-tab-btn" data-diag-tab="snmp">🔍 SNMP Live Walk</button>
      </div>

      <div id="diag-panel-controls" class="diag-controls"></div>
      <div id="diag-panel-output">
        <div class="muted" style="padding:28px;text-align:center">
          ${isEn ? 'Select parameters above and click "Run Diagnostic" to inspect live network status.' : 'Chọn thông số phía trên và bấm "Chạy kiểm tra" để chẩn đoán trực tiếp thiết bị.'}
        </div>
      </div>
      <div class="row" style="margin-top:10px;justify-content:space-between">
        <button type="button" class="btn sm" id="diag-copy-btn" style="display:none">📋 ${isEn ? 'Copy Output' : 'Sao chép kết quả'}</button>
        <span class="muted" id="diag-duration" style="font-size:12px"></span>
      </div>
    `;

    const { form } = M.modal(
      isEn ? `🛠️ Quick Diagnostic Toolkit — ${curDev.name}` : `🛠️ Công cụ Chẩn đoán Nhanh — ${curDev.name}`,
      html,
      async () => {},
      { submit: isEn ? 'Close' : 'Đóng', noCancel: true, wide: true }
    );

    const devSel = $('#diag-dev-sel', form);
    const ipBadge = $('#diag-target-ip', form);
    const ctrlBox = $('#diag-panel-controls', form);
    const outBox = $('#diag-panel-output', form);
    const copyBtn = $('#diag-copy-btn', form);
    const durSpan = $('#diag-duration', form);

    const renderControls = () => {
      $$('.diag-tab-btn', form).forEach((b) => b.classList.toggle('active', b.dataset.diagTab === activeTool));
      if (activeTool === 'ping') {
        ctrlBox.innerHTML = `
          <label style="font-size:13px">${isEn ? 'Packets:' : 'Số gói tin:'}</label>
          <select class="sel" id="diag-ping-count">
            <option value="4" selected>4 ${isEn ? 'packets' : 'gói (tiêu chuẩn)'}</option>
            <option value="8">8 ${isEn ? 'packets' : 'gói (kiểm tra rớt gói)'}</option>
            <option value="1">1 ${isEn ? 'packet (fast)' : 'gói (siêu nhanh)'}</option>
          </select>
          <span class="spacer"></span>
          <button type="button" class="btn primary" id="diag-run-btn">▶️ ${isEn ? 'Run Ping' : 'Chạy Ping'}</button>
        `;
      } else if (activeTool === 'traceroute') {
        ctrlBox.innerHTML = `
          <label style="font-size:13px">${isEn ? 'Max Hops:' : 'Số trạm tối đa (Max Hops):'}</label>
          <select class="sel" id="diag-trace-hops">
            <option value="10">10 hops</option>
            <option value="15" selected>15 hops</option>
            <option value="20">20 hops</option>
          </select>
          <span class="spacer"></span>
          <button type="button" class="btn primary" id="diag-run-btn">▶️ ${isEn ? 'Run Traceroute' : 'Chạy Traceroute'}</button>
        `;
      } else if (activeTool === 'tcp') {
        const isServer = curDev.type === 'server';
        if (isServer) {
          ctrlBox.innerHTML = `
            <div style="font-size:13px;display:flex;align-items:center;gap:6px">
              <span class="chip" style="background:rgba(59,130,246,0.15);color:#60a5fa;font-weight:600">🤖 Agent-based</span>
              <span>${isEn ? 'Direct OS listening ports query via Agent' : 'Thu thập cổng đang mở trực tiếp từ OS qua Agent'}</span>
            </div>
            <span class="spacer"></span>
            <button type="button" class="btn primary" id="diag-run-btn">🔄 ${isEn ? 'Fetch Listening Services' : 'Tải danh sách dịch vụ thực tế'}</button>
          `;
        } else {
          const defPorts = DEFAULT_PORTS_BY_TYPE[curDev.type] || '22, 53, 80, 443, 3389, 8080, 8291, 9100';
          ctrlBox.innerHTML = `
            <label style="font-size:13px">${isEn ? 'Ports (list / range):' : 'Cổng (danh sách / dải):'}</label>
            <input class="inp" id="diag-tcp-ports" value="${esc(defPorts)}" style="flex:1;min-width:240px" placeholder="${isEn ? 'e.g. 22, 80/tcp, 161/udp, 53, 22-8000' : 'vd: 22, 80/tcp, 161/udp, 53, 22-8000'}">
            <button type="button" class="btn primary" id="diag-run-btn">▶️ ${isEn ? 'Scan Ports' : 'Quét Cổng'}</button>
          `;
        }
      } else if (activeTool === 'snmp') {
        ctrlBox.innerHTML = `
          <label style="font-size:13px">${isEn ? 'MIB Branch:' : 'Nhánh MIB:'}</label>
          <select class="sel" id="diag-snmp-preset">
            <option value="system">${isEn ? 'System Info (1.3.6.1.2.1.1)' : 'Thông tin chung System (1.3.6.1.2.1.1)'}</option>
            <option value="interfaces">${isEn ? 'Interfaces IF-MIB (1.3.6.1.2.1.2.2.1)' : 'Cổng mạng IF-MIB (1.3.6.1.2.1.2.2.1)'}</option>
            <option value="ifx">${isEn ? 'High-Speed Ports ifXTable (1.3.6.1.2.1.31.1.1.1)' : 'Cổng tốc độ cao 64-bit (1.3.6.1.2.1.31.1.1.1)'}</option>
            <option value="storage">${isEn ? 'Storage / RAM / Disk (1.3.6.1.2.1.25.2.3.1)' : 'Bộ nhớ RAM & Ổ đĩa (1.3.6.1.2.1.25.2.3.1)'}</option>
            <option value="cpu">${isEn ? 'CPU Processor Load (1.3.6.1.2.1.25.3.3.1)' : 'Tải nhân CPU (1.3.6.1.2.1.25.3.3.1)'}</option>
            <option value="printer">${isEn ? 'Printer Supplies (1.3.6.1.2.1.43.11.1.1)' : 'Vật tư Máy in Mực/Drum (1.3.6.1.2.1.43.11.1.1)'}</option>
            <option value="arp">${isEn ? 'ARP Cache Table (1.3.6.1.2.1.4.22.1)' : 'Bảng ARP (1.3.6.1.2.1.4.22.1)'}</option>
            <option value="custom">${isEn ? 'Custom OID...' : 'Tự nhập OID...'}</option>
          </select>
          <input class="inp" id="diag-snmp-oid" placeholder="1.3.6.1.2.1.1" style="width:180px;display:none">
          <span class="spacer"></span>
          <button type="button" class="btn primary" id="diag-run-btn">▶️ ${isEn ? 'Walk SNMP' : 'Đọc SNMP trực tiếp'}</button>
        `;
        const presetSel = $('#diag-snmp-preset', ctrlBox);
        const oidInp = $('#diag-snmp-oid', ctrlBox);
        if (presetSel && oidInp) {
          presetSel.onchange = () => {
            oidInp.style.display = presetSel.value === 'custom' ? '' : 'none';
            if (presetSel.value === 'custom') oidInp.focus();
          };
        }
      }

      const runBtn = $('#diag-run-btn', ctrlBox);
      if (runBtn) runBtn.onclick = runCurrentDiagnostic;
    };

    const renderResult = (tool, data) => {
      const r = data.result || {};
      durSpan.textContent = r.duration_ms != null
        ? (isEn ? `Completed in ${r.duration_ms} ms` : `Hoàn tất sau ${r.duration_ms} ms`)
        : '';

      if (tool === 'ping') {
        const lossCol = r.loss_percent === 0 ? 'var(--c-ok)' : (r.loss_percent >= 50 ? 'var(--c-critical)' : 'var(--c-medium)');
        lastCopyText = r.raw_output || '';
        copyBtn.style.display = lastCopyText ? '' : 'none';
        outBox.innerHTML = `
          <div class="diag-kpis">
            <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Status' : 'Trạng thái'}</div><div class="dk-val" style="color:${r.ok ? 'var(--c-ok)' : 'var(--c-critical)'}">${r.ok ? 'ONLINE' : 'TIMEOUT'}</div></div>
            <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Sent / Recv' : 'Gửi / Nhận'}</div><div class="dk-val">${r.transmitted} / ${r.received}</div></div>
            <div class="diag-kpi"><div class="dk-lbl">Packet Loss</div><div class="dk-val" style="color:${lossCol}">${r.loss_percent}%</div></div>
            <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Avg RTT' : 'Độ trễ TB'}</div><div class="dk-val">${r.avg_ms != null ? `${r.avg_ms} ms` : '—'}</div></div>
            <div class="diag-kpi"><div class="dk-lbl">Min / Max / Jitter</div><div class="dk-val" style="font-size:14px">${r.min_ms != null ? `${r.min_ms}/${r.max_ms}/${r.jitter_ms}ms` : '—'}</div></div>
          </div>
          <div class="diag-term">${esc(r.raw_output || '')}</div>
        `;
      } else if (tool === 'traceroute') {
        lastCopyText = r.raw_output || '';
        copyBtn.style.display = lastCopyText ? '' : 'none';
        const hops = Array.isArray(r.hops) ? r.hops : [];
        const rowsHtml = hops.map((h) => `
          <tr>
            <td><b>#${h.hop}</b></td>
            <td><code>${esc(h.ip)}</code></td>
            <td>${h.timeout ? `<span class="muted">* (Timeout)</span>` : `<b style="color:var(--c-ok)">${h.rtt_ms != null ? `${h.rtt_ms} ms` : 'OK'}</b>`}</td>
          </tr>
        `).join('');
        outBox.innerHTML = `
          ${hops.length ? `<div class="diag-tbl-wrap"><table class="tbl" style="margin:0"><thead><tr><th>Hop</th><th>${isEn ? 'Router / Node IP' : 'Địa chỉ IP Trạm'}</th><th>${isEn ? 'Latency (RTT)' : 'Độ trễ (RTT)'}</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : ''}
          <div class="diag-term">${esc(r.raw_output || '')}</div>
        `;
      } else if (tool === 'tcp') {
        const isAgentServer = curDev.type === 'server' || r.mode === 'agent' || Array.isArray(r.services);
        if (isAgentServer) {
          const list = Array.isArray(r.services) ? r.services : (r.open_ports || []);
          const tcpCount = r.tcp_count != null ? r.tcp_count : (r.tcp_open_count || 0);
          const udpCount = r.udp_count != null ? r.udp_count : (r.udp_open_count || 0);
          const totalCount = r.total_count != null ? r.total_count : (r.open_count || list.length);

          lastCopyText = list.map((s) => `${(s.proto || 'tcp').toUpperCase()}\t${s.port}\t${s.service || '-'}\tLISTEN`).join('\n');
          copyBtn.style.display = list.length ? '' : 'none';

          const rowsHtml = list.map((s) => {
            const proto = (s.proto || 'tcp').toUpperCase();
            const protoCol = proto === 'TCP' ? '#60a5fa' : '#c084fc';
            const protoBg = proto === 'TCP' ? 'rgba(59,130,246,0.15)' : 'rgba(192,132,252,0.15)';
            return `
              <tr>
                <td><span class="chip" style="background:${protoBg};color:${protoCol};font-weight:700;font-size:11px;padding:2px 8px">${esc(proto)}</span></td>
                <td><code style="font-size:13px;font-weight:700">Port ${s.port}</code></td>
                <td><b style="color:var(--text)">${esc(s.service || '-')}</b></td>
                <td><span class="sev-badge ok" style="font-weight:700;letter-spacing:0.5px">LISTEN</span></td>
              </tr>
            `;
          }).join('');

          outBox.innerHTML = `
            <div class="diag-kpis">
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Total Services' : 'Tổng dịch vụ'}</div><div class="dk-val" style="color:var(--c-ok)">${totalCount}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'TCP Listening' : 'Dịch vụ TCP (LISTEN)'}</div><div class="dk-val" style="color:#60a5fa">${tcpCount}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'UDP Listening' : 'Dịch vụ UDP (LISTEN)'}</div><div class="dk-val" style="color:#c084fc">${udpCount}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Status' : 'Trạng thái'}</div><div class="dk-val" style="color:var(--c-ok);font-size:15px">🟢 ACTIVE</div></div>
            </div>
            <div style="margin:8px 0 6px;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between">
              <span>${isEn ? 'Real Listening Services (Agent OS direct query):' : 'Danh sách dịch vụ thực tế đang lắng nghe (OS Agent):'}</span>
              <span class="muted" style="font-size:12px">${list.length} ${isEn ? 'services' : 'dịch vụ'}</span>
            </div>
            <div class="diag-tbl-wrap">
              <table class="tbl" style="margin:0">
                <thead>
                  <tr>
                    <th style="width:120px">${isEn ? 'Protocol' : 'Giao thức'}</th>
                    <th style="width:140px">${isEn ? 'Port' : 'Số Cổng'}</th>
                    <th>${isEn ? 'Service Name' : 'Tên Dịch Vụ'}</th>
                    <th style="width:130px">${isEn ? 'Status' : 'Trạng thái'}</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">${isEn ? 'No listening services detected on this server.' : 'Không phát hiện dịch vụ nào đang mở (LISTEN) trên máy chủ này.'}</td></tr>`}
                </tbody>
              </table>
            </div>
          `;
          return;
        }

        const isSummary = r.mode === 'summary' || !r.results;
        const list = Array.isArray(r.results) ? r.results : (r.open_ports || []);

        if (isSummary) {
          lastCopyText = [
            `Port Scan Summary for ${r.host}:`,
            `Total Checked: ${r.total_count}`,
            `Open TCP: ${r.tcp_open_count || 0}`,
            `Open UDP: ${r.udp_open_count || 0}`,
            `Total Open: ${r.open_count || 0}`,
            list.length ? `Open Ports:\n` + list.map((x) => `Port ${x.port}/${(x.protocol || 'TCP').toUpperCase()} (${x.service || 'Service'})${x.rtt_ms ? ` - ${x.rtt_ms}ms` : ''}`).join('\n') : 'No open ports found',
          ].join('\n');
          copyBtn.style.display = '';

          const openCardsHtml = list.length ? list.map((x) => `
            <div class="diag-port-card open">
              <div>
                <div style="font-weight:700;font-size:14px">
                  🟢 Port ${x.port}
                  <span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(34,197,94,0.18);color:var(--c-ok);text-transform:uppercase;margin-left:4px">${esc((x.protocol || 'TCP').toUpperCase())}</span>
                </div>
                <div class="muted" style="font-size:12px">${esc(x.service || 'Service')}</div>
              </div>
              <div style="text-align:right">
                <span class="sev-badge ok">OPEN</span>
                ${x.rtt_ms != null ? `<div class="muted" style="font-size:11px;margin-top:2px">${x.rtt_ms} ms</div>` : ''}
              </div>
            </div>
          `).join('') : `<div class="muted" style="padding:14px;text-align:center;grid-column:1/-1">${isEn ? 'No open ports detected in this range.' : 'Không phát hiện cổng mở nào trong khoảng này.'}</div>`;

          outBox.innerHTML = `
            <div class="diag-kpis">
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Total Checked' : 'Tổng cổng quét'}</div><div class="dk-val">${r.total_count}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Open TCP' : 'Cổng TCP Mở'}</div><div class="dk-val" style="color:var(--c-ok)">${r.tcp_open_count || 0}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Open UDP' : 'Cổng UDP Mở'}</div><div class="dk-val" style="color:var(--c-ok)">${r.udp_open_count || 0}</div></div>
              <div class="diag-kpi"><div class="dk-lbl">${isEn ? 'Total Open' : 'Tổng Cổng Mở'}</div><div class="dk-val" style="color:${r.open_count ? 'var(--c-ok)' : 'var(--muted)'}">${r.open_count || 0}</div></div>
            </div>
            <div style="margin:8px 0 6px;font-size:13px;font-weight:600">
              ${isEn ? 'Open Ports Found:' : 'Danh sách cổng mở phát hiện:'}
            </div>
            <div class="diag-port-grid">${openCardsHtml}</div>
          `;
        } else {
          lastCopyText = list.map((x) => `Port ${x.port}/${(x.protocol || 'TCP').toUpperCase()} (${x.service}): ${x.open ? `OPEN (${x.rtt_ms}ms)` : x.state.toUpperCase()}`).join('\n');
          copyBtn.style.display = list.length ? '' : 'none';
          const cardsHtml = list.map((x) => `
            <div class="diag-port-card ${x.open ? 'open' : 'closed'}">
              <div>
                <div style="font-weight:700;font-size:14px">
                  ${x.open ? '🟢' : '🔴'} Port ${x.port}
                  <span style="font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px;background:var(--border);color:var(--text);text-transform:uppercase;margin-left:4px">${esc((x.protocol || 'TCP').toUpperCase())}</span>
                </div>
                <div class="muted" style="font-size:12px">${esc(x.service)}</div>
              </div>
              <div style="text-align:right">
                <span class="sev-badge ${x.open ? 'ok' : 'critical'}">${x.open ? 'OPEN' : esc(x.state.toUpperCase())}</span>
                ${x.rtt_ms != null ? `<div class="muted" style="font-size:11px;margin-top:2px">${x.rtt_ms} ms</div>` : ''}
              </div>
            </div>
          `).join('');
          outBox.innerHTML = `
            <div style="margin-bottom:8px;font-size:13px">
              <b>${isEn ? 'Summary:' : 'Tổng kết:'}</b>
              <span style="color:var(--c-ok);font-weight:700">${r.open_count} ${isEn ? 'open' : 'cổng mở'}</span>
              (${r.tcp_open_count || 0} TCP, ${r.udp_open_count || 0} UDP) /
              ${r.total_count} ${isEn ? 'checked on' : 'cổng kiểm tra trên'} <code>${esc(r.host)}</code>
            </div>
            <div class="diag-port-grid">${cardsHtml}</div>
          `;
        }
      } else if (tool === 'snmp') {
        const rows = Array.isArray(r.rows) ? r.rows : [];
        lastCopyText = rows.map((x) => `${x.oid}${x.label ? ` (${x.label})` : ''} [${x.type}] = ${x.value}`).join('\n');
        copyBtn.style.display = rows.length ? '' : 'none';
        if (r.error && !rows.length) {
          outBox.innerHTML = `<div class="panel err" style="margin:0">⚠️ ${esc(M.trData(r.error))}</div>`;
          return;
        }
        const rowsHtml = rows.map((x) => `
          <tr class="diag-snmp-row" data-q="${esc(`${x.oid} ${x.label} ${x.value}`.toLowerCase())}">
            <td><code>${esc(x.oid)}</code>${x.label ? `<br><span style="color:var(--c-low);font-size:11px;font-weight:600">${esc(x.label)}</span>` : ''}</td>
            <td><span class="muted" style="font-size:11px">${esc(x.type)}</span></td>
            <td style="word-break:break-word"><b>${esc(x.value)}</b></td>
          </tr>
        `).join('');
        outBox.innerHTML = `
          <div class="row" style="margin-bottom:8px;gap:8px">
            <span style="font-size:13px"><b>${rows.length}</b> OIDs (<code>${esc(r.root_oid)}</code>)</span>
            <span class="spacer"></span>
            <input class="inp" id="diag-snmp-filter" placeholder="${isEn ? '🔍 Filter OID / label / value...' : '🔍 Lọc nhanh OID / tên / giá trị...'}" style="width:240px">
          </div>
          <div class="diag-tbl-wrap">
            <table class="tbl" style="margin:0">
              <thead><tr><th>OID / MIB</th><th>Type</th><th>${isEn ? 'Value' : 'Giá trị'}</th></tr></thead>
              <tbody>${rowsHtml || `<tr><td colspan="3" class="muted">${isEn ? 'No OIDs returned' : 'Không có dữ liệu OID trả về'}</td></tr>`}</tbody>
            </table>
          </div>
        `;
        const filterInp = $('#diag-snmp-filter', outBox);
        if (filterInp) {
          filterInp.oninput = () => {
            const q = filterInp.value.toLowerCase().trim();
            $$('.diag-snmp-row', outBox).forEach((tr) => {
              tr.style.display = (!q || (tr.dataset.q || '').includes(q)) ? '' : 'none';
            });
          };
        }
      }
    };

    const runCurrentDiagnostic = async () => {
      const runBtn = $('#diag-run-btn', ctrlBox);
      if (!runBtn || !curDev) return;
      const origText = runBtn.textContent;
      runBtn.disabled = true;
      runBtn.textContent = isEn ? '⏳ Running...' : '⏳ Đang kiểm tra...';
      copyBtn.style.display = 'none';
      durSpan.textContent = '';

      if (activeTool === 'tcp' && curDev.type === 'server') {
        outBox.innerHTML = `<div class="muted" style="padding:28px;text-align:center">⏳ ${isEn ? `Fetching real listening services from Agent on ${curDev.name}...` : `Đang tải danh sách dịch vụ thực tế từ Agent trên ${curDev.name}...`}</div>`;
        try {
          const res = await M.api('GET', `/api/devices/${curDev.id}/listening-services`);
          renderResult(activeTool, { result: res });
        } catch (err) {
          outBox.innerHTML = `<div class="panel err" style="margin:0">⚠️ ${esc(M.trData(err.message))}</div>`;
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = origText;
        }
        return;
      }

      const payload = { tool: activeTool };
      if (activeTool === 'ping') {
        payload.count = Number($('#diag-ping-count', ctrlBox)?.value || 4);
      } else if (activeTool === 'traceroute') {
        payload.max_hops = Number($('#diag-trace-hops', ctrlBox)?.value || 15);
      } else if (activeTool === 'tcp') {
        payload.ports = $('#diag-tcp-ports', ctrlBox)?.value || '';
      } else if (activeTool === 'snmp') {
        const preset = $('#diag-snmp-preset', ctrlBox)?.value || 'system';
        const customOid = $('#diag-snmp-oid', ctrlBox)?.value || '';
        payload.oid = preset === 'custom' ? customOid : preset;
      }

      outBox.innerHTML = `<div class="muted" style="padding:28px;text-align:center">⏳ ${isEn ? `Running ${activeTool.toUpperCase()} on ${curDev.name} (${curDev.address})...` : `Đang chạy ${activeTool.toUpperCase()} tới ${curDev.name} (${curDev.address})...`}</div>`;

      try {
        const res = await M.api('POST', `/api/devices/${curDev.id}/diag`, payload);
        renderResult(activeTool, res);
      } catch (err) {
        outBox.innerHTML = `<div class="panel err" style="margin:0">⚠️ ${esc(M.trData(err.message))}</div>`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = origText;
      }
    };

    $$('.diag-tab-btn', form).forEach((btn) => {
      btn.onclick = () => {
        activeTool = btn.dataset.diagTab;
        renderControls();
      };
    });

    if (devSel) {
      devSel.onchange = () => {
        const found = allDevs.find((x) => x.id === Number(devSel.value));
        if (found) {
          curDev = found;
          ipBadge.textContent = `🌐 ${curDev.address}`;
          renderControls();
        }
      };
    }

    if (copyBtn) {
      copyBtn.onclick = async () => {
        if (!lastCopyText) return;
        try {
          await navigator.clipboard.writeText(lastCopyText);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = lastCopyText;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        M.toast(isEn ? 'Copied diagnostic result!' : 'Đã sao chép kết quả chẩn đoán!');
      };
    }

    renderControls();
  };

  // ---- Non-Intrusive UI Hooks into Device Detail & Devices List -------------
  function hookViews() {
    if (M.views.device && !M.views.device._diagHooked) {
      M.views.device._diagHooked = true;
      const origPaint = M.views.device.paint;
      M.views.device.paint = function (...args) {
        const res = origPaint.apply(this, args);
        try {
          const d = this.D;
          const canOp = M.S.user && M.S.user.role !== 'viewer';
          const heroRow = $('#d-hero .hero > .row');
          if (d && d.address && canOp && heroRow && !$('#d-quick-diag')) {
            const isEn = M.S.lang === 'en';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn';
            btn.id = 'd-quick-diag';
            btn.title = isEn ? 'Ping, Traceroute, TCP Port Check & Live SNMP Walk' : 'Chẩn đoán nhanh: Ping, Traceroute, Cổng TCP & SNMP Live Walk';
            btn.textContent = isEn ? '🛠️ Quick Diag' : '🛠️ Chẩn đoán';
            btn.onclick = () => M.openDiagnosticsModal(d, 'ping');
            const backBtn = $('#d-back', heroRow);
            if (backBtn) heroRow.insertBefore(btn, backBtn);
            else heroRow.appendChild(btn);
          }
        } catch { /* keep core view safe */ }
        return res;
      };
    }

    if (M.views.devices && !M.views.devices._diagHooked) {
      M.views.devices._diagHooked = true;
      const origRender = M.views.devices.render;
      M.views.devices.render = function (el, ...args) {
        const res = origRender.call(this, el, ...args);
        try {
          const canOp = M.S.user && M.S.user.role !== 'viewer';
          const topRow = $('.row', el);
          if (canOp && topRow && !$('#dl-quick-diag')) {
            const isEn = M.S.lang === 'en';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn';
            btn.id = 'dl-quick-diag';
            btn.textContent = isEn ? '🛠️ Quick Diagnostics' : '🛠️ Công cụ Chẩn đoán';
            btn.onclick = () => M.openDiagnosticsModal(null, 'ping');
            const qInp = $('#dl-q', topRow);
            if (qInp && qInp.nextSibling) topRow.insertBefore(btn, qInp.nextSibling);
            else topRow.appendChild(btn);
          }
        } catch { /* keep core view safe */ }
        return res;
      };
    }
  }

  hookViews();
})();
