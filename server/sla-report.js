'use strict';
// =============================================================================
// Module 4: SLA Uptime/Downtime Report & CSV/PDF Export (Zero-Impact Add-on)
// -----------------------------------------------------------------------------
// - Completely standalone service. Does NOT modify monitor.js, snmp-engine.js,
//   or db.js schema.
// - Reconstructs per-device and fleet-wide SLA Uptime %, Downtime duration,
//   Outage count, MTTR (Mean Time To Repair), and average resource metrics
//   from `events`, `metrics`, and live monitor state.
// - Provides JSON API (`GET /api/reports/sla`) and UTF-8 BOM CSV export
//   (`GET /api/reports/sla/csv`) for Excel.
// =============================================================================

const RANGE_PRESETS_MS = {
  '1h': 3600 * 1000,
  '6h': 6 * 3600 * 1000,
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
  '90d': 90 * 24 * 3600 * 1000,
};

function parseRange(query = {}, now = Date.now()) {
  const rangeKey = String(query.range || '7d').trim().toLowerCase();
  let fromTs;
  let toTs = Number(query.to) || now;
  if (toTs > now + 60000) toTs = now;

  if (query.from && Number.isFinite(Number(query.from)) && Number(query.from) > 0) {
    fromTs = Number(query.from);
  } else {
    const span = RANGE_PRESETS_MS[rangeKey] || RANGE_PRESETS_MS['7d'];
    fromTs = toTs - span;
  }

  if (fromTs >= toTs) {
    fromTs = toTs - RANGE_PRESETS_MS['24h'];
  }

  const slaTarget = Math.min(100, Math.max(50, Number(query.target) || 99.5));
  const groupId = query.group_id ? Number(query.group_id) : null;
  const typeFilter = query.type ? String(query.type).trim().toLowerCase() : '';

  return { rangeKey, fromTs, toTs, slaTarget, groupId, typeFilter };
}

/**
 * Compute SLA statistics for all matching devices within [fromTs, toTs].
 */
function buildSlaReport(db, monitor, query = {}, now = Date.now()) {
  const { rangeKey, fromTs, toTs, slaTarget, groupId, typeFilter } = parseRange(query, now);

  const devices = db.prepare('SELECT * FROM devices ORDER BY name ASC').all();
  const groups = db.prepare('SELECT id, name FROM groups ORDER BY name ASC').all();
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));
  const devGroups = new Map();
  for (const r of db.prepare('SELECT device_id, group_id FROM device_groups').all()) {
    if (!devGroups.has(r.device_id)) devGroups.set(r.device_id, []);
    devGroups.get(r.device_id).push(r.group_id);
  }

  // Filter devices by group or type if requested
  const filteredDevices = devices.filter((d) => {
    const gids = devGroups.get(d.id) || [];
    if (groupId && !gids.includes(groupId)) return false;
    if (typeFilter && String(d.type || '').toLowerCase() !== typeFilter) return false;
    return true;
  });

  // Fetch all state-transition events up to toTs so we know state entering fromTs
  const allEvents = db.prepare(`
    SELECT id, ts, device_id, kind, severity, message
    FROM events
    WHERE ts <= ? AND device_id IS NOT NULL AND kind IN ('down', 'up', 'warning')
    ORDER BY ts ASC, id ASC
  `).all(toTs);

  const eventsByDevice = new Map();
  for (const ev of allEvents) {
    if (!eventsByDevice.has(ev.device_id)) eventsByDevice.set(ev.device_id, []);
    eventsByDevice.get(ev.device_id).push(ev);
  }

  // Aggregated metrics per device within [fromTs, toTs]
  const metricAggRows = db.prepare(`
    SELECT
      device_id,
      COUNT(*) AS samples,
      AVG(cpu) AS avg_cpu,
      MAX(cpu) AS max_cpu,
      AVG(ram) AS avg_ram,
      MAX(ram) AS max_ram,
      AVG(disk) AS avg_disk,
      MAX(disk) AS max_disk,
      AVG(rtt) AS avg_rtt,
      MAX(rtt) AS max_rtt,
      AVG(net_in) AS avg_net_in,
      AVG(net_out) AS avg_net_out
    FROM metrics
    WHERE ts >= ? AND ts <= ?
    GROUP BY device_id
  `).all(fromTs, toTs);
  const metricsByDevice = new Map(metricAggRows.map((r) => [r.device_id, r]));

  const rows = [];
  let totalMonitoredSec = 0;
  let totalDowntimeSec = 0;
  let totalOutages = 0;
  let totalWarnings = 0;
  let totalRecoveredOutages = 0;
  let totalRecoveredDurationSec = 0;

  for (const d of filteredDevices) {
    const gids = devGroups.get(d.id) || [];
    const groupNames = gids.map((id) => groupMap.get(id)).filter(Boolean);
    const liveState = monitor && monitor.state ? monitor.state.get(d.id) : null;
    const currentStatus = d.maintenance
      ? 'maint'
      : (liveState ? liveState.status : 'unknown');

    // Effective monitoring start time for this device
    // If the device has events before created_at (e.g., seeded/simulated history), include from the earliest event
    const devEvents = eventsByDevice.get(d.id) || [];
    const earliestEventTs = devEvents.length > 0 ? devEvents[0].ts : null;
    const deviceCreatedTs = d.created_at && d.created_at > 0 ? d.created_at : fromTs;
    const effectiveStartBase = earliestEventTs != null
      ? Math.min(deviceCreatedTs, earliestEventTs)
      : deviceCreatedTs;
    const effectiveFrom = Math.min(toTs - 1000, Math.max(fromTs, effectiveStartBase));
    const windowSec = Math.max(1, Math.round((toTs - effectiveFrom) / 1000));

    // Reconstruct outage intervals
    let stateAtCursor = 'up';
    let downStartTs = null;
    let outageCount = 0;
    let warningCount = 0;
    let downtimeMs = 0;
    let recoveredCount = 0;
    let recoveredMs = 0;
    let lastOutageAt = null;
    let lastReason = '';

    for (const ev of devEvents) {
      if (ev.ts < effectiveFrom) {
        if (ev.kind === 'down') {
          stateAtCursor = 'down';
          downStartTs = effectiveFrom;
          lastReason = ev.message || '';
        } else if (ev.kind === 'up' || ev.kind === 'warning') {
          stateAtCursor = ev.kind;
          downStartTs = null;
        }
        continue;
      }

      // Inside [effectiveFrom, toTs]
      if (ev.kind === 'warning') {
        warningCount += 1;
        if (stateAtCursor === 'down' && downStartTs != null) {
          // Transitioned from down -> warning (device reachable again)
          const dur = Math.max(0, ev.ts - downStartTs);
          downtimeMs += dur;
          recoveredCount += 1;
          recoveredMs += dur;
          downStartTs = null;
        }
        stateAtCursor = 'warning';
      } else if (ev.kind === 'down') {
        outageCount += 1;
        lastOutageAt = ev.ts;
        lastReason = ev.message || '';
        if (stateAtCursor !== 'down') {
          stateAtCursor = 'down';
          downStartTs = ev.ts;
        }
      } else if (ev.kind === 'up') {
        if (stateAtCursor === 'down' && downStartTs != null) {
          const dur = Math.max(0, ev.ts - downStartTs);
          downtimeMs += dur;
          recoveredCount += 1;
          recoveredMs += dur;
          downStartTs = null;
        }
        stateAtCursor = 'up';
      }
    }

    // If still down at toTs (or live state is currently down with no events)
    if (stateAtCursor === 'down' && downStartTs != null) {
      downtimeMs += Math.max(0, toTs - downStartTs);
    } else if (devEvents.length === 0 && currentStatus === 'down' && liveState && liveState.since) {
      const start = Math.max(effectiveFrom, liveState.since);
      if (toTs > start) {
        outageCount = 1;
        lastOutageAt = liveState.since;
        lastReason = (liveState.reasons || []).join('; ');
        downtimeMs += (toTs - start);
      }
    }

    const downtimeSec = Math.min(windowSec, Math.round(downtimeMs / 1000));
    const uptimeSec = Math.max(0, windowSec - downtimeSec);
    const uptimePct = Number(((uptimeSec / windowSec) * 100).toFixed(3));
    const mttrSec = recoveredCount > 0 ? Math.round((recoveredMs / 1000) / recoveredCount) : (outageCount > 0 ? downtimeSec : 0);

    const m = metricsByDevice.get(d.id) || {};
    const round1 = (v) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);

    let slaStatus = 'met';
    if (d.maintenance) slaStatus = 'maint';
    else if (uptimePct < slaTarget) slaStatus = 'breached';
    else if (uptimePct < Math.min(99.9, slaTarget + 0.3)) slaStatus = 'at_risk';

    totalMonitoredSec += windowSec;
    totalDowntimeSec += downtimeSec;
    totalOutages += outageCount;
    totalWarnings += warningCount;
    totalRecoveredOutages += recoveredCount;
    totalRecoveredDurationSec += Math.round(recoveredMs / 1000);

    rows.push({
      device_id: d.id,
      name: d.name,
      type: d.type,
      address: d.address,
      location: d.location || '',
      groups: groupNames,
      group_ids: gids,
      current_status: currentStatus,
      maintenance: !!d.maintenance,
      monitored_sec: windowSec,
      uptime_sec: uptimeSec,
      downtime_sec: downtimeSec,
      uptime_pct: uptimePct,
      sla_target: slaTarget,
      sla_status: slaStatus,
      outage_count: outageCount,
      warning_count: warningCount,
      mttr_sec: mttrSec,
      last_outage_at: lastOutageAt,
      last_reason: lastReason,
      metrics: {
        samples: Number(m.samples) || 0,
        avg_cpu: round1(m.avg_cpu),
        max_cpu: round1(m.max_cpu),
        avg_ram: round1(m.avg_ram),
        max_ram: round1(m.max_ram),
        avg_disk: round1(m.avg_disk),
        max_disk: round1(m.max_disk),
        avg_rtt: round1(m.avg_rtt),
        max_rtt: round1(m.max_rtt),
        avg_net_in: m.avg_net_in != null ? Math.round(Number(m.avg_net_in)) : null,
        avg_net_out: m.avg_net_out != null ? Math.round(Number(m.avg_net_out)) : null,
      },
    });
  }

  // Sort worst uptime first so breached devices are immediately visible
  rows.sort((a, b) => {
    if (a.uptime_pct !== b.uptime_pct) return a.uptime_pct - b.uptime_pct;
    if (b.downtime_sec !== a.downtime_sec) return b.downtime_sec - a.downtime_sec;
    return a.name.localeCompare(b.name);
  });

  const fleetUptimePct = totalMonitoredSec > 0
    ? Number((((totalMonitoredSec - totalDowntimeSec) / totalMonitoredSec) * 100).toFixed(3))
    : 100;
  const fleetMttrSec = totalRecoveredOutages > 0
    ? Math.round(totalRecoveredDurationSec / totalRecoveredOutages)
    : 0;
  const metCount = rows.filter((r) => r.sla_status === 'met' || r.sla_status === 'at_risk').length;
  const breachedCount = rows.filter((r) => r.sla_status === 'breached').length;

  return {
    generated_at: now,
    range: rangeKey,
    from_ts: fromTs,
    to_ts: toTs,
    sla_target: slaTarget,
    summary: {
      total_devices: rows.length,
      met_count: metCount,
      breached_count: breachedCount,
      fleet_uptime_pct: fleetUptimePct,
      total_downtime_sec: totalDowntimeSec,
      total_outages: totalOutages,
      total_warnings: totalWarnings,
      fleet_mttr_sec: fleetMttrSec,
    },
    devices: rows,
  };
}

function formatDurationHuman(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s === 0) return '0s';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (rem > 0 && d === 0) parts.push(`${rem}s`);
  return parts.join(' ') || '0s';
}

function csvCell(val) {
  if (val == null) return '';
  let str = String(val);
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildSlaCsv(report) {
  const headers = [
    'Device ID',
    'Tên thiết bị (Device Name)',
    'Loại (Type)',
    'Địa chỉ IP (Address)',
    'Vị trí (Location)',
    'Nhóm (Groups)',
    'Trạng thái hiện tại (Status)',
    'SLA Uptime (%)',
    'Mục tiêu SLA (%)',
    'Đánh giá SLA (SLA Status)',
    'Tổng thời gian lỗi (Downtime Sec)',
    'Tổng thời gian lỗi (Định dạng)',
    'Số lần sập (Outages)',
    'Số cảnh báo (Warnings)',
    'MTTR (Giây)',
    'CPU TB (%)',
    'CPU Đỉnh (%)',
    'RAM TB (%)',
    'RAM Đỉnh (%)',
    'Disk TB (%)',
    'Ping RTT TB (ms)',
    'Ping RTT Đỉnh (ms)',
    'Sự cố gần nhất (Last Reason)',
  ];

  const lines = [headers.map(csvCell).join(',')];
  for (const r of report.devices) {
    const m = r.metrics || {};
    const slaLabel = r.sla_status === 'breached'
      ? 'VI PHẠM (BREACHED)'
      : (r.sla_status === 'maint' ? 'BẢO TRÌ (MAINT)' : 'ĐẠT CHUẨN (MET)');
    const row = [
      r.device_id,
      r.name,
      r.type,
      r.address,
      r.location,
      (r.groups || []).join('; '),
      r.current_status,
      r.uptime_pct,
      r.sla_target,
      slaLabel,
      r.downtime_sec,
      formatDurationHuman(r.downtime_sec),
      r.outage_count,
      r.warning_count,
      r.mttr_sec,
      m.avg_cpu ?? '',
      m.max_cpu ?? '',
      m.avg_ram ?? '',
      m.max_ram ?? '',
      m.avg_disk ?? '',
      m.avg_rtt ?? '',
      m.max_rtt ?? '',
      r.last_reason || '',
    ];
    lines.push(row.map(csvCell).join(','));
  }

  // Prepend UTF-8 BOM (\uFEFF) so Microsoft Excel opens Vietnamese characters properly
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function registerRoutes({ route, db, monitor, send, SEC_HEADERS = {} }) {
  route('GET', '/api/reports/sla', 'any', (ctx) => {
    const query = Object.fromEntries(ctx.query.entries());
    const report = buildSlaReport(db, monitor, query);
    send(ctx.res, 200, report);
  });

  route('GET', '/api/reports/sla/csv', 'any', (ctx) => {
    const query = Object.fromEntries(ctx.query.entries());
    const report = buildSlaReport(db, monitor, query);
    const csv = buildSlaCsv(report);
    const dateTag = new Date(report.to_ts).toISOString().slice(0, 10);
    const filename = `sla-report-${report.range}-${dateTag}.csv`;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      ...SEC_HEADERS,
    });
    ctx.res.end(csv);
  });
}

module.exports = {
  registerRoutes,
  buildSlaReport,
  buildSlaCsv,
  formatDurationHuman,
};
