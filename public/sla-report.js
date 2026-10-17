/* =============================================================================
 * Module 4: SLA Uptime/Downtime Report & CSV/PDF Export (UI Isolation Add-on)
 * -----------------------------------------------------------------------------
 * - Standalone script loaded after views.js & admin.js.
 * - Does NOT modify views.js, admin.js, or core.js.
 * - Hooks non-intrusively into Events view (`M.views.events`) and Admin Devices
 *   view (`M.views.devices`) to provide a "📈 Báo cáo SLA" button that opens
 *   a standalone Executive SLA Modal (`M.openSlaReportModal`).
 * ============================================================================= */
(() => {
  const M = window.M;
  if (!M) return;
  const { $, esc } = M;

  function fmtDurSec(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s === 0) return '0s';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const out = [];
    if (d > 0) out.push(`${d}d`);
    if (h > 0) out.push(`${h}h`);
    if (m > 0) out.push(`${m}m`);
    if (rem > 0 && d === 0) out.push(`${rem}s`);
    return out.join(' ') || '0s';
  }

  M.openSlaReportModal = async function openSlaReportModal(opts = {}) {
    const isEn = M.S && M.S.lang === 'en';
    let currentRange = opts.range || '7d';
    let currentTarget = opts.target || 99.5;
    let currentType = opts.type || '';
    let currentReport = null;

    const bodyHtml = `
      <div class="sla-modal-wrap" style="display:flex;flex-direction:column;gap:14px">
        <div class="row" style="flex-wrap:wrap;gap:10px;justify-content:space-between;background:rgba(15,23,42,0.55);padding:10px 12px;border-radius:8px;border:1px solid var(--border)">
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <label class="muted" style="font-size:12px">${isEn ? 'Period:' : 'Kỳ báo cáo:'}</label>
            <select class="sel" id="sla-range-sel">
              <option value="24h" ${currentRange === '24h' ? 'selected' : ''}>${isEn ? 'Last 24 Hours' : '24 giờ qua'}</option>
              <option value="7d" ${currentRange === '7d' ? 'selected' : ''}>${isEn ? 'Last 7 Days (Weekly)' : '7 ngày qua (Tuần)'}</option>
              <option value="30d" ${currentRange === '30d' ? 'selected' : ''}>${isEn ? 'Last 30 Days (Monthly)' : '30 ngày qua (Tháng)'}</option>
              <option value="90d" ${currentRange === '90d' ? 'selected' : ''}>${isEn ? 'Last 90 Days (Quarterly)' : '90 ngày qua (Quý)'}</option>
            </select>

            <label class="muted" style="font-size:12px;margin-left:6px">${isEn ? 'SLA Target:' : 'Mục tiêu SLA:'}</label>
            <select class="sel" id="sla-target-sel">
              <option value="99" ${currentTarget === 99 ? 'selected' : ''}>99.0% (Standard)</option>
              <option value="99.5" ${currentTarget === 99.5 ? 'selected' : ''}>99.5% (Business)</option>
              <option value="99.9" ${currentTarget === 99.9 ? 'selected' : ''}>99.9% (High Availability)</option>
              <option value="99.99" ${currentTarget === 99.99 ? 'selected' : ''}>99.99% (Mission Critical)</option>
            </select>

            <label class="muted" style="font-size:12px;margin-left:6px">${isEn ? 'Device Type:' : 'Loại thiết bị:'}</label>
            <select class="sel" id="sla-type-sel">
              <option value="">${isEn ? 'All types' : 'Tất cả loại'}</option>
              <option value="router">Router</option>
              <option value="firewall">Firewall</option>
              <option value="switch">Switch</option>
              <option value="server">Server</option>
              <option value="vm">VM</option>
              <option value="ap">WiFi AP</option>
              <option value="printer">Printer</option>
              <option value="ups">UPS</option>
            </select>

            <input class="inp" id="sla-search-inp" placeholder="${isEn ? 'Search device / IP...' : 'Tìm tên thiết bị / IP...'}" style="width:170px;padding:5px 10px" />
          </div>

          <div class="row" style="gap:8px">
            <button type="button" class="btn sm" id="btn-sla-refresh">🔄 ${isEn ? 'Refresh' : 'Làm mới'}</button>
            <button type="button" class="btn sm" id="btn-sla-csv" style="border-color:rgba(34,197,94,0.45);color:#4ade80">📥 ${isEn ? 'Export Excel (CSV)' : 'Xuất Excel (CSV)'}</button>
            <button type="button" class="btn sm primary" id="btn-sla-pdf">🖨️ ${isEn ? 'Print / Save PDF' : 'Xuất PDF / In báo cáo'}</button>
          </div>
        </div>

        <div id="sla-summary-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px"></div>

        <div id="sla-table-container" style="max-height:54vh;overflow:auto;border:1px solid var(--border);border-radius:8px">
          <div class="muted" style="padding:24px;text-align:center">⏳ ${isEn ? 'Calculating SLA metrics...' : 'Đang tổng hợp dữ liệu SLA...'}</div>
        </div>
      </div>
    `;

    const { form } = M.modal(
      isEn ? '📈 SLA Uptime & Availability Report' : '📈 Báo cáo SLA Uptime / Downtime & Hiệu năng',
      bodyHtml,
      async () => {},
      { submit: isEn ? 'Close' : 'Đóng', noCancel: true, wide: true }
    );
    const dialog = form.closest('.modal');
    if (dialog) dialog.style.maxWidth = '1180px';

    const renderSummary = (rep) => {
      const box = $('#sla-summary-cards', form);
      if (!box || !rep) return;
      const s = rep.summary || {};
      const upColor = s.fleet_uptime_pct >= rep.sla_target ? 'var(--c-ok)' : 'var(--c-crit)';
      const breachColor = s.breached_count > 0 ? 'var(--c-crit)' : 'var(--c-ok)';

      box.innerHTML = `
        <div class="panel" style="padding:12px 14px;margin:0;border-left:4px solid ${upColor}">
          <div class="muted" style="font-size:12px">${isEn ? 'Fleet SLA Availability' : 'SLA Uptime Toàn Hệ Thống'}</div>
          <div style="font-size:24px;font-weight:800;color:${upColor};margin-top:4px">${s.fleet_uptime_pct.toFixed(3)}%</div>
          <div class="muted" style="font-size:11px;margin-top:2px">${isEn ? 'Target:' : 'Mục tiêu:'} ≥ ${rep.sla_target}%</div>
        </div>
        <div class="panel" style="padding:12px 14px;margin:0;border-left:4px solid ${breachColor}">
          <div class="muted" style="font-size:12px">${isEn ? 'SLA Compliance' : 'Tỷ lệ thiết bị đạt SLA'}</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">
            <span style="color:var(--c-ok)">${s.met_count}</span> / ${s.total_devices}
          </div>
          <div style="font-size:11px;margin-top:2px;color:${breachColor}">
            ${s.breached_count > 0
              ? (isEn ? `⚠️ ${s.breached_count} device(s) breached SLA` : `⚠️ ${s.breached_count} thiết bị vi phạm SLA`)
              : (isEn ? '✅ 100% compliant' : '✅ Tất cả đạt chuẩn SLA')}
          </div>
        </div>
        <div class="panel" style="padding:12px 14px;margin:0;border-left:4px solid var(--c-high)">
          <div class="muted" style="font-size:12px">${isEn ? 'Total Downtime & Outages' : 'Tổng Downtime & Số lần sập'}</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtDurSec(s.total_downtime_sec)}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">
            ${s.total_outages} ${isEn ? 'outages' : 'lần mất kết nối'} · ${s.total_warnings} ${isEn ? 'warnings' : 'cảnh báo'}
          </div>
        </div>
        <div class="panel" style="padding:12px 14px;margin:0;border-left:4px solid var(--c-low)">
          <div class="muted" style="font-size:12px">${isEn ? 'Mean Time To Repair (MTTR)' : 'Thời gian khắc phục TB (MTTR)'}</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">${fmtDurSec(s.fleet_mttr_sec)}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">
            ${M.fmtTime(rep.from_ts)} → ${M.fmtTime(rep.to_ts)}
          </div>
        </div>
      `;
    };

    const renderTable = () => {
      const box = $('#sla-table-container', form);
      if (!box || !currentReport) return;
      const q = ($('#sla-search-inp', form)?.value || '').toLowerCase().trim();
      const rows = (currentReport.devices || []).filter((r) => {
        if (!q) return true;
        return (
          String(r.name || '').toLowerCase().includes(q) ||
          String(r.address || '').toLowerCase().includes(q) ||
          String(r.location || '').toLowerCase().includes(q) ||
          (r.groups || []).join(' ').toLowerCase().includes(q)
        );
      });

      if (!rows.length) {
        box.innerHTML = `<div class="muted" style="padding:24px;text-align:center">${isEn ? 'No matching devices.' : 'Không có thiết bị phù hợp bộ lọc.'}</div>`;
        return;
      }

      const bodyRows = rows.map((r) => {
        const m = r.metrics || {};
        const isBreached = r.sla_status === 'breached';
        const isMaint = r.sla_status === 'maint';
        const barColor = isMaint ? 'var(--c-maint)' : (isBreached ? 'var(--c-crit)' : 'var(--c-ok)');
        const badgeHtml = isMaint
          ? `<span class="sev-badge maint">${isEn ? 'MAINT' : 'BẢO TRÌ'}</span>`
          : (isBreached
            ? `<span class="sev-badge critical">${isEn ? 'BREACHED' : 'VI PHẠM'}</span>`
            : `<span class="sev-badge ok">${isEn ? 'MET' : 'ĐẠT SLA'}</span>`);

        const cpuTxt = m.avg_cpu != null ? `${m.avg_cpu}% <span class="muted" style="font-size:11px">(max ${m.max_cpu}%)</span>` : '—';
        const ramTxt = m.avg_ram != null ? `${m.avg_ram}% <span class="muted" style="font-size:11px">(max ${m.max_ram}%)</span>` : '—';
        const rttTxt = m.avg_rtt != null ? `${m.avg_rtt} ms` : '—';

        return `
          <tr>
            <td>
              <div style="font-weight:700"><a href="#/device/${r.device_id}" onclick="document.querySelector('.modal-bg')?.remove()">${esc(r.name)}</a></div>
              <div class="muted" style="font-size:11px">${esc(r.address)} · ${esc(r.type.toUpperCase())}${r.location ? ` · ${esc(r.location)}` : ''}</div>
            </td>
            <td style="min-width:145px">
              <div style="display:flex;justify-content:space-between;font-weight:700;font-size:13px;color:${barColor}">
                <span>${r.uptime_pct.toFixed(3)}%</span>
                ${badgeHtml}
              </div>
              <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;margin-top:4px">
                <div style="height:100%;width:${Math.max(2, Math.min(100, r.uptime_pct))}%;background:${barColor}"></div>
              </div>
            </td>
            <td style="font-weight:600;color:${r.downtime_sec > 0 ? 'var(--c-high)' : 'var(--muted)'}">${fmtDurSec(r.downtime_sec)}</td>
            <td>
              <b>${r.outage_count}</b> ${isEn ? 'down' : 'sập'}
              ${r.warning_count > 0 ? `<span class="muted" style="font-size:11px">(${r.warning_count} warn)</span>` : ''}
            </td>
            <td>${fmtDurSec(r.mttr_sec)}</td>
            <td>${cpuTxt}</td>
            <td>${ramTxt}</td>
            <td>${rttTxt}</td>
            <td style="max-width:210px;font-size:12px" class="muted" title="${esc(r.last_reason || '')}">
              ${r.last_reason ? esc(r.last_reason.slice(0, 65) + (r.last_reason.length > 65 ? '…' : '')) : '—'}
            </td>
          </tr>
        `;
      }).join('');

      box.innerHTML = `
        <table class="tbl" style="margin:0">
          <thead>
            <tr>
              <th>${isEn ? 'Device' : 'Thiết bị'}</th>
              <th>SLA Uptime (%)</th>
              <th>Downtime</th>
              <th>${isEn ? 'Incidents' : 'Sự cố'}</th>
              <th>MTTR</th>
              <th>CPU (TB / Max)</th>
              <th>RAM (TB / Max)</th>
              <th>Ping RTT</th>
              <th>${isEn ? 'Last Incident Reason' : 'Nguyên nhân gần nhất'}</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      `;
    };

    const loadReport = async () => {
      const box = $('#sla-table-container', form);
      if (box) {
        box.innerHTML = `<div class="muted" style="padding:24px;text-align:center">⏳ ${isEn ? 'Calculating SLA metrics...' : 'Đang tổng hợp dữ liệu SLA...'}</div>`;
      }
      const qs = new URLSearchParams({
        range: currentRange,
        target: String(currentTarget),
      });
      if (currentType) qs.set('type', currentType);
      try {
        currentReport = await M.api('GET', `/api/reports/sla?${qs.toString()}`);
        renderSummary(currentReport);
        renderTable();
      } catch (e) {
        if (box) {
          box.innerHTML = `<div style="padding:20px;color:var(--c-crit)">❌ ${esc(e.message)}</div>`;
        }
      }
    };

    $('#sla-range-sel', form)?.addEventListener('change', (e) => {
      currentRange = e.target.value;
      loadReport();
    });
    $('#sla-target-sel', form)?.addEventListener('change', (e) => {
      currentTarget = Number(e.target.value) || 99.5;
      loadReport();
    });
    $('#sla-type-sel', form)?.addEventListener('change', (e) => {
      currentType = e.target.value;
      loadReport();
    });
    $('#sla-search-inp', form)?.addEventListener('input', () => renderTable());
    $('#btn-sla-refresh', form)?.addEventListener('click', () => loadReport());

    $('#btn-sla-csv', form)?.addEventListener('click', () => {
      const qs = new URLSearchParams({
        range: currentRange,
        target: String(currentTarget),
      });
      if (currentType) qs.set('type', currentType);
      window.open(`/api/reports/sla/csv?${qs.toString()}`, '_blank');
    });

    $('#btn-sla-pdf', form)?.addEventListener('click', () => {
      if (!currentReport) return;
      const s = currentReport.summary || {};
      const win = window.open('', '_blank');
      if (!win) return;
      const rowsHtml = (currentReport.devices || []).map((r) => {
        const m = r.metrics || {};
        const stLabel = r.sla_status === 'breached' ? 'VI PHẠM' : (r.sla_status === 'maint' ? 'BẢO TRÌ' : 'ĐẠT SLA');
        const stColor = r.sla_status === 'breached' ? '#dc2626' : '#16a34a';
        return `<tr>
          <td><b>${esc(r.name)}</b><br><small>${esc(r.address)} (${esc(r.type)})</small></td>
          <td style="font-weight:700;color:${stColor}">${r.uptime_pct.toFixed(3)}% (${stLabel})</td>
          <td>${fmtDurSec(r.downtime_sec)}</td>
          <td>${r.outage_count}</td>
          <td>${fmtDurSec(r.mttr_sec)}</td>
          <td>${m.avg_cpu != null ? `${m.avg_cpu}%` : '—'}</td>
          <td>${m.avg_ram != null ? `${m.avg_ram}%` : '—'}</td>
          <td>${m.avg_rtt != null ? `${m.avg_rtt} ms` : '—'}</td>
        </tr>`;
      }).join('');

      win.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Báo cáo SLA Uptime/Downtime (${esc(currentReport.range)})</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; margin: 28px; }
    h1 { margin: 0 0 6px 0; font-size: 22px; }
    .sub { color: #475569; font-size: 13px; margin-bottom: 18px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .kpi { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 14px; }
    .kpi-label { font-size: 12px; color: #64748b; }
    .kpi-val { font-size: 20px; font-weight: 800; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 7px 9px; text-align: left; }
    th { background: #f1f5f9; font-weight: 700; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:16px">
    <button onclick="window.print()" style="padding:8px 16px;font-weight:700;cursor:pointer">🖨️ In hoặc Lưu thành PDF (Save as PDF)</button>
  </div>
  <h1>BÁO CÁO CAM KẾT CHẤT LƯỢNG DỊCH VỤ (SLA UPTIME / DOWNTIME)</h1>
  <div class="sub">
    Kỳ báo cáo: <b>${M.fmtTime(currentReport.from_ts)} → ${M.fmtTime(currentReport.to_ts)}</b> (${esc(currentReport.range.toUpperCase())})
    · Mục tiêu SLA: <b>≥ ${currentReport.sla_target}%</b>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">SLA Uptime Toàn Mạng</div><div class="kpi-val">${s.fleet_uptime_pct.toFixed(3)}%</div></div>
    <div class="kpi"><div class="kpi-label">Thiết bị Đạt / Tổng số</div><div class="kpi-val">${s.met_count} / ${s.total_devices}</div></div>
    <div class="kpi"><div class="kpi-label">Tổng Downtime / Số lần sập</div><div class="kpi-val">${fmtDurSec(s.total_downtime_sec)} (${s.total_outages})</div></div>
    <div class="kpi"><div class="kpi-label">MTTR Trung bình</div><div class="kpi-val">${fmtDurSec(s.fleet_mttr_sec)}</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Thiết bị</th>
        <th>SLA Uptime (%)</th>
        <th>Tổng Downtime</th>
        <th>Số lần sập</th>
        <th>MTTR</th>
        <th>CPU TB</th>
        <th>RAM TB</th>
        <th>Ping RTT TB</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`);
      win.document.close();
      setTimeout(() => {
        try { win.focus(); win.print(); } catch {}
      }, 250);
    });

    await loadReport();
  };

  // Non-intrusive hook into Events View (`M.views.events`)
  if (M.views && M.views.events && typeof M.views.events.render === 'function') {
    const origEventsRender = M.views.events.render;
    M.views.events.render = async function patchedEventsRender(el, sub) {
      const res = await origEventsRender.call(this, el, sub);
      try {
        const subtabs = el.querySelector('.ai-subtabs');
        if (subtabs && !el.querySelector('#btn-open-sla-report')) {
          const isEn = M.S && M.S.lang === 'en';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.id = 'btn-open-sla-report';
          btn.innerHTML = `📈 ${isEn ? 'SLA Report & Export' : 'Báo cáo SLA & Xuất File'}`;
          btn.onclick = () => M.openSlaReportModal();
          subtabs.appendChild(btn);
        }
      } catch {}
      return res;
    };
  }
})();
