'use strict';
// AI Incident Diagnosis & End-of-Day Predictive Digest Engine.
// Designed for maximum token efficiency: server-side pre-aggregation, fingerprint deduplication,
// strict compact JSON templates (VI / EN), daily budget cap, and zero agent modifications.

const PROVIDER_PRESETS = {
  openai: {
    name: 'OpenAI (gpt-4o-mini)',
    api_url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
  },
  gemini: {
    name: 'Google Gemini (gemini-3.8-flash)',
    api_url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.8-flash',
  },
  deepseek: {
    name: 'DeepSeek (deepseek-chat)',
    api_url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
  groq: {
    name: 'Groq (openai/gpt-oss-120b)',
    api_url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
  },
  ollama: {
    name: 'Local Ollama (qwen2.5 / llama3.2)',
    api_url: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
  },
  custom: {
    name: 'Custom OpenAI-Compatible Endpoint',
    api_url: '',
    model: '',
  },
};

// Normalize dynamic numbers out of reason strings so minor fluctuations (e.g. CPU 91% vs 93%)
// share the same deduplication fingerprint and do not waste tokens.
function buildFingerprint(deviceId, kind, reasons, lang = 'vi') {
  const norm = String(reasons || '')
    .replace(/\d+([.,]\d+)?/g, '#')
    .slice(0, 120);
  return `${deviceId || 0}:${kind}:${norm}:${lang}`;
}

// Smart Incident Filter (BA & Dev specification):
// Strictly filters which incidents genuinely require AI root-cause & predictive analysis.
// EXCLUDES (for automatic background triggers):
// 1. Disconnection / Ping failure / ICMP / Agent / SNMP reachability loss ('down' or ping/timeout warnings)
// 2. Printer devices & printer consumables/mechanical events (toner, drum, paper jam, cover open)
// 3. Recovery ('up' / severity 'ok') and system audit ('audit') events
// 4. Low / Medium severity devices (for automatic background triggers)
// INCLUDES only complex technical anomalies (CPU/RAM/Disk > threshold, SMART Bad Sector, Thermal, UPS Power, Flood/DoS).
function isAiAnalyzableIncident(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object') return false;
  const force = !!opts.force;
  const allowLiveDevice = !!opts.allowLiveDevice;
  const kind = String(ctx.kind || '').toLowerCase();
  const devType = String(ctx.device_type || '').toLowerCase();
  const reason = String(ctx.reason || ctx.message || '');
  const evSev = String(ctx.event_severity || '').toLowerCase();
  const devSev = String(ctx.device_severity || ctx.severity || '').toLowerCase();

  // 1. Manual on-demand inspection (Force or Live Device Telemetry Analysis)
  // When an engineer or operator explicitly clicks "Phân tích AI", "Gửi AI phân tích ngay",
  // or "Chẩn đoán AI", always allow the analysis (unless it is a pure non-technical system audit event).
  if (force || allowLiveDevice) {
    if (kind === 'audit') return false;
    return true;
  }

  // 2. Never analyze recovery or audit events for automatic background triggers
  if (kind === 'up' || kind === 'audit') return false;
  if (evSev === 'ok' || devSev === 'ok' || devSev === 'none') return false;
  if (/trở lại bình thường|hoạt động bình thường|mức an toàn|có điện lưới trở lại|hoạt động trở lại|recovered|returned to normal/i.test(reason)) {
    return false;
  }

  // 3. Never analyze Printer devices or printer consumable/mechanical alerts (toner, drum, paper jam)
  if (devType === 'printer') return false;
  if (/hết mực|mực còn|no toner|low toner|drum|trống hình|kẹt giấy|paper jam|cửa máy in|cover open|fuser|waste toner|sự cố máy in/i.test(reason)) {
    return false;
  }

  // 4. Never automatically trigger on Disconnection ('down') or pure Ping/ICMP/Agent/SNMP reachability loss
  if (kind === 'down' || (!kind && String(ctx.status || '').toLowerCase() === 'down')) return false;
  if (/mất kết nối|không ping được|không phản hồi icmp|icmp.*fail|ping.*timeout|agent không gửi dữ liệu|agent mất kết nối|mất tín hiệu agent|snmp không phản hồi|snmp lỗi/i.test(reason)) {
    const hasTechAlso = /cpu cao|ram cao|ổ đĩa cao|high cpu|high ram|high disk|smart|bad sector|nhiệt độ|quá nhiệt|flood|dos|mất điện lưới|on battery/i.test(reason);
    if (!hasTechAlso) return false;
  }

  // 5. For automatic triggers, require the device's configured severity to be 'critical' or 'high'
  if (devSev !== 'critical' && devSev !== 'high') return false;

  // 6. Positive Technical Whitelist: must be a complex hardware, capacity, thermal, power, or security anomaly
  if (['smart', 'dos', 'thermal', 'power'].includes(kind)) return true;
  if (/cpu cao|ram cao|ổ đĩa cao|high cpu|high ram|high disk|smart|bad sector|nhiệt độ|quá nhiệt|thermal|overheat|flood|dos|tấn công|mất điện lưới|on battery|chạy pin ups/i.test(reason)) {
    return true;
  }
  if (
    (ctx.cpu != null && ctx.cpu >= 80) ||
    (ctx.ram != null && ctx.ram >= 80) ||
    (ctx.disk != null && ctx.disk >= 80) ||
    (ctx.temp != null && ctx.temp >= 75) ||
    (ctx.pkt_rate != null && ctx.pkt_rate >= 5000) ||
    (ctx.smart && ctx.smart.ok === false) ||
    (ctx.power && ctx.power.on_battery)
  ) {
    return true;
  }

  return false;
}

function fmtBytesHuman(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return 'N/A';
  const b = Number(bytes);
  if (b >= 1024 ** 4) return `${(b / (1024 ** 4)).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / (1024 ** 3)).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / (1024 ** 2)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}

function fmtDurHuman(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return 'N/A';
  const s = Math.max(0, Math.floor(Number(sec)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// Compute 24h predictive trend summary from SQLite metrics & events in ~15 tokens
// instead of sending raw time-series arrays.
function computeDeviceTrendSummary(db, deviceId, now = Date.now()) {
  if (!deviceId) return 'N/A';
  const since24h = now - 86400e3;
  const stats = db.prepare(`
    SELECT COUNT(*) AS n,
           ROUND(AVG(cpu), 1) AS avg_cpu, ROUND(MAX(cpu), 1) AS max_cpu,
           ROUND(AVG(ram), 1) AS avg_ram, ROUND(MAX(ram), 1) AS max_ram,
           ROUND(MIN(disk), 1) AS min_disk, ROUND(MAX(disk), 1) AS max_disk,
           ROUND(MAX(temp), 1) AS max_temp
    FROM metrics WHERE device_id = ? AND ts >= ?
  `).get(deviceId, since24h);

  const firstDisk = db.prepare(
    'SELECT ts, disk FROM metrics WHERE device_id = ? AND ts >= ? AND disk IS NOT NULL ORDER BY ts ASC LIMIT 1',
  ).get(deviceId, since24h);
  const lastDisk = db.prepare(
    'SELECT ts, disk FROM metrics WHERE device_id = ? AND ts >= ? AND disk IS NOT NULL ORDER BY ts DESC LIMIT 1',
  ).get(deviceId, since24h);

  let diskSlopePerDay = 0;
  let daysToFull = null;
  if (firstDisk && lastDisk && lastDisk.ts > firstDisk.ts) {
    const hours = Math.max(0.5, (lastDisk.ts - firstDisk.ts) / 3600e3);
    diskSlopePerDay = Math.round(((lastDisk.disk - firstDisk.disk) / hours) * 24 * 10) / 10;
    if (diskSlopePerDay > 0.2 && lastDisk.disk < 100) {
      daysToFull = Math.round(((100 - lastDisk.disk) / diskSlopePerDay) * 10) / 10;
    }
  }

  const downEvents = db.prepare(
    "SELECT COUNT(*) AS c FROM events WHERE device_id = ? AND ts >= ? AND kind = 'down'",
  ).get(deviceId, since24h);

  const parts = [];
  if (stats && stats.n > 0) {
    if (stats.max_cpu != null) parts.push(`CPU_avg=${stats.avg_cpu}%/max=${stats.max_cpu}%`);
    if (stats.max_ram != null) parts.push(`RAM_avg=${stats.avg_ram}%/max=${stats.max_ram}%`);
    if (lastDisk && lastDisk.disk != null) {
      parts.push(`Disk=${lastDisk.disk}%(slope=${diskSlopePerDay >= 0 ? '+' : ''}${diskSlopePerDay}%/d${daysToFull ? `,full_in~${daysToFull}d` : ''})`);
    }
    if (stats.max_temp != null) parts.push(`MaxTemp=${stats.max_temp}C`);
  }
  parts.push(`Down24h=${downEvents ? downEvents.c : 0}`);
  return parts.join(', ');
}

// Collect deep technical telemetry & time-series metric logs for a device/incident.
// Used BOTH when fetching AI analysis (compact technical context) AND when user clicks
// "Copy Technical Logs" to paste into external AI chatboxes (ChatGPT, Claude, Gemini, DeepSeek).
function collectDeviceTechnicalLogs(monitor, { eventId, deviceId, lang = 'vi', now = Date.now() } = {}) {
  const db = monitor.db;
  const isEn = lang === 'en';
  let ev = null;
  if (eventId) {
    ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(eventId));
  }
  const targetDevId = Number(deviceId || (ev && ev.device_id) || 0);
  const d = targetDevId ? monitor.devices.get(targetDevId) : null;
  const v = d ? monitor.view(d, true) : null;
  const a = (v && v.agent) || {};
  const snmp = (v && v.snmp) || {};
  const th = (monitor.settings && monitor.settings.thresholds) || { cpu: 90, ram: 90, disk: 90, temp: 85, dos_packet_rate: 10000 };

  const devName = (v && v.name) || (ev && ev.device_name) || 'Unknown-Device';
  const devType = (v && v.type) || (d && d.type) || 'server';
  const address = (v && v.address) || (d && d.address) || 'N/A';
  const devSev = (v && v.severity) || (ev && ev.severity) || 'high';
  const hostname = a.hostname || snmp.sysName || devName;
  const osInfo = a.os || snmp.sysDescr || 'N/A';
  const uptimeSec = v ? v.uptime : null;
  const cores = a.cores || (a.cpu && a.cpu.cores) || null;
  const load1 = a.load1 != null ? Number(a.load1).toFixed(2) : (a.cpu && a.cpu.load1 != null ? Number(a.cpu.load1).toFixed(2) : null);
  const loadRatio = (load1 != null && cores > 0) ? `${Math.round((Number(load1) / cores) * 100)}%` : null;
  const snmpProfile = (snmp.profile && snmp.profile.id) || (v && v.snmp_profile) || null;

  // Storage partitions breakdown
  const disks = Array.isArray(a.disks) ? a.disks : [];
  const diskLines = disks.map((dk) => {
    const flag = dk.percent >= th.disk ? ' [CRITICAL >= THRESHOLD]' : (dk.percent >= 80 ? ' [HIGH]' : '');
    return `  * ${dk.mount || '/'} : ${dk.percent ?? '?'}% (Used: ${fmtBytesHuman(dk.used)} / Total: ${fmtBytesHuman(dk.total)})${flag}`;
  });
  const compactMounts = disks.slice(0, 4).map((dk) => `${dk.mount}:${Math.round(dk.percent || 0)}%`).join(',');

  // Network & packet forensics
  const netIn = v ? v.net_in : null;
  const netOut = v ? v.net_out : null;
  const pktRate = v ? v.pkt_rate : null;
  const avgPktBytes = (pktRate && pktRate > 0 && ((netIn || 0) + (netOut || 0)) > 0)
    ? Math.round(((netIn || 0) + (netOut || 0)) / pktRate)
    : null;

  // Recent time-series metric samples from SQLite
  const rawSamples = targetDevId
    ? db.prepare('SELECT ts, cpu, ram, disk, temp, rtt, net_in, net_out FROM metrics WHERE device_id = ? ORDER BY ts DESC LIMIT 12').all(targetDevId)
    : [];

  const sampleTrajectoryCompact = rawSamples.length
    ? rawSamples.slice(0, 5).map((r) => {
      const p = [];
      if (r.cpu != null) p.push(`C:${Math.round(r.cpu)}%`);
      if (r.ram != null) p.push(`R:${Math.round(r.ram)}%`);
      if (r.disk != null) p.push(`D:${Math.round(r.disk)}%`);
      if (r.temp != null) p.push(`T:${Math.round(r.temp)}C`);
      return p.join('/');
    }).join(' -> ')
    : 'N/A';

  const trend24h = targetDevId ? computeDeviceTrendSummary(db, targetDevId, now) : 'N/A';

  // Compact technical telemetry string (~25-35 tokens) injected into AI API prompt
  const techSummaryParts = [
    osInfo !== 'N/A' ? `OS="${String(osInfo).slice(0, 48)}"` : null,
    cores ? `Cores=${cores}` : null,
    load1 ? `Load1=${load1}${loadRatio ? `(${loadRatio})` : ''}` : null,
    a.ram && a.ram.total ? `RAM_Used=${fmtBytesHuman(a.ram.used)}/${fmtBytesHuman(a.ram.total)}` : null,
    compactMounts ? `Mounts=[${compactMounts}]` : null,
    netIn != null || netOut != null ? `Net_IO=RX:${fmtBytesHuman(netIn)}/s,TX:${fmtBytesHuman(netOut)}/s` : null,
    avgPktBytes != null ? `AvgPktSize=${avgPktBytes}B` : null,
    uptimeSec != null ? `Uptime=${fmtDurHuman(uptimeSec)}` : null,
    rawSamples.length > 1 ? `Recent5Polls=[${sampleTrajectoryCompact}]` : null,
  ].filter(Boolean).join(' | ');

  // Full tabular time-series rows for engineer/AI chatbox inspection
  const sampleTableRows = rawSamples.length
    ? rawSamples.map((r) => {
      const iso = new Date(r.ts).toISOString();
      const cpuS = r.cpu != null ? `${Number(r.cpu).toFixed(1)}%`.padEnd(6) : 'N/A   ';
      const ramS = r.ram != null ? `${Number(r.ram).toFixed(1)}%`.padEnd(6) : 'N/A   ';
      const dskS = r.disk != null ? `${Number(r.disk).toFixed(1)}%`.padEnd(6) : 'N/A   ';
      const tmpS = r.temp != null ? `${Number(r.temp).toFixed(1)}°C`.padEnd(7) : 'N/A    ';
      const rttS = r.rtt != null ? `${Number(r.rtt).toFixed(1)}ms`.padEnd(8) : 'N/A     ';
      const rxS = r.net_in != null ? `${fmtBytesHuman(r.net_in)}/s`.padEnd(11) : 'N/A        ';
      const txS = r.net_out != null ? `${fmtBytesHuman(r.net_out)}/s` : 'N/A';
      return `${iso} | ${cpuS} | ${ramS} | ${dskS} | ${tmpS} | ${rttS} | ${rxS} | ${txS}`;
    }).join('\n')
    : (isEn ? '(No time-series samples recorded in metrics table yet)' : '(Chưa có mẫu chuỗi thời gian trong bảng metrics)');

  const incidentReason = (ev && ev.message) || (v && v.reasons && v.reasons.join('; ')) || (isEn ? 'On-demand technical inspection' : 'Kiểm tra kỹ thuật chuyên sâu');
  const incidentKind = (ev && ev.kind) || (v && v.status) || 'warning';
  const incidentTs = ev ? new Date(ev.ts).toISOString() : new Date(now).toISOString();

  const smartStr = v && v.smart
    ? (v.smart.ok === false ? `FAIL (Status: ${v.smart.status || 'BAD_SECTOR'} | Details: ${v.smart.details || 'Hardware error'})` : `OK (${v.smart.status || 'HEALTHY'})`)
    : 'N/A';
  const upsStr = v && v.power
    ? (v.power.on_battery ? `ON_BATTERY (Battery: ${v.power.battery_percent ?? '?'}% | Status: ${v.power.status || 'DISCHARGING'})` : `AC_ONLINE (Battery: ${v.power.battery_percent ?? 100}%)`)
    : 'N/A';

  const logText = isEn
    ? `=== TECHNICAL DIAGNOSTIC TELEMETRY & LOGS FOR AI ANALYSIS ===
[1. DEVICE & SYSTEM ENVIRONMENT]
- Device Name   : ${devName} (Type: ${devType} | Configured Severity: ${devSev.toUpperCase()})
- IP / Hostname : ${address} (Hostname: ${hostname})
- OS / Firmware : ${osInfo}
- Uptime        : ${fmtDurHuman(uptimeSec)}${snmpProfile ? ` | SNMP Profile: ${snmpProfile}` : ''}${a.version ? ` | Agent: v${a.version}` : ''}
- CPU Hardware  : ${cores ? `${cores} Cores` : 'N/A'} | LoadAvg(1m): ${load1 || 'N/A'}${loadRatio ? ` (Core Saturation: ${loadRatio})` : ''}

[2. TRIGGERING TECHNICAL INCIDENT & ACTIVE HARDWARE FLAGS]
- Timestamp     : ${incidentTs}
- Incident Kind : ${incidentKind.toUpperCase()}
- Alert Detail  : ${incidentReason}
- Active Flags  : SMART_ERR=${Boolean(v && v.alerts && v.alerts.smart)} | THERMAL_ERR=${Boolean(v && v.alerts && v.alerts.thermal)} | DOS_FLOOD=${Boolean(v && v.alerts && v.alerts.dos)} | UPS_BATTERY=${Boolean(v && v.alerts && v.alerts.power)}

[3. REAL-TIME RESOURCE, STORAGE PARTITIONS & NETWORK TELEMETRY]
- CPU & Thermal : CPU=${v && v.cpu != null ? `${Math.round(v.cpu)}%` : 'N/A'} (Threshold: ${th.cpu}%) | Temp=${v && v.temperature != null ? `${Math.round(v.temperature)}°C` : 'N/A'} (Threshold: ${th.temp}°C)
- Memory (RAM)  : ${v && v.ram != null ? `${Math.round(v.ram)}%` : 'N/A'} (Threshold: ${th.ram}%)${a.ram && a.ram.total ? ` — Used: ${fmtBytesHuman(a.ram.used)} / Total: ${fmtBytesHuman(a.ram.total)} (Free: ${fmtBytesHuman(Math.max(0, a.ram.total - (a.ram.used || 0)))})` : ''}
- Disk Usage    : Max Partition=${v && v.disk != null ? `${Math.round(v.disk)}%` : 'N/A'} (Threshold: ${th.disk}%)
${diskLines.length ? diskLines.join('\n') : '  * (Single volume / SNMP storage metric)'}
- SMART Health  : ${smartStr}
- Power / UPS   : ${upsStr}
- Network & PPS : Ping RTT=${v && v.rtt != null ? `${v.rtt} ms` : 'N/A'} | RX=${netIn != null ? `${fmtBytesHuman(netIn)}/s` : 'N/A'} | TX=${netOut != null ? `${fmtBytesHuman(netOut)}/s` : 'N/A'} | Packet Rate=${pktRate != null ? `${pktRate} pkt/s` : 'N/A'} (DoS Threshold: ${th.dos_packet_rate} pkt/s)${avgPktBytes != null ? ` | Avg Packet Size: ~${avgPktBytes} B/pkt` : ''}${v && v.dos_details ? ` | Attack Signature: ${v.dos_details}` : ''}

[4. 24-HOUR STATISTICAL BASELINE & LINEAR REGRESSION FORECAST]
- 24h Telemetry : ${trend24h}

[5. RECENT RAW TIME-SERIES METRIC SAMPLES (NEWEST FIRST)]
TIMESTAMP (ISO)          | CPU%   | RAM%   | DISK%  | TEMP°C  | RTT(ms)  | RX_RATE     | TX_RATE
${sampleTableRows}

[6. AI DIAGNOSTIC PROMPT]
Act as a Senior SRE / Network & Systems Architect. Based on the technical telemetry, partition metrics, hardware flags, and time-series progression above, provide a rigorous technical analysis:
1. Issue Summary & Immediate Operational Risk.
2. Root Cause Analysis (correlating CPU/Load1, RAM headroom, Disk partition growth, SMART status, Thermal, or Packet Size/PPS).
3. Step-by-step Diagnostic & Remediation CLI Commands (Linux/Windows/RouterOS/Cisco/Firewall as applicable).
4. Capacity & Reliability Prediction for the next 24–72 hours.`
    : `=== LOGS KỸ THUẬT CHẨN ĐOÁN HỆ THỐNG & MẠNG (TECHNICAL TELEMETRY DUMP) ===
[1. THÔNG SỐ MÔI TRƯỜNG, PHẦN CỨNG & HỆ ĐIỀU HÀNH]
- Thiết bị       : ${devName} (Loại: ${devType} | Mức ưu tiên: ${devSev.toUpperCase()})
- IP / Hostname  : ${address} (Hostname: ${hostname})
- Hệ điều hành   : ${osInfo}
- Uptime         : ${fmtDurHuman(uptimeSec)}${snmpProfile ? ` | Hồ sơ SNMP: ${snmpProfile}` : ''}${a.version ? ` | Agent: v${a.version}` : ''}
- Cấu hình CPU   : ${cores ? `${cores} nhân (Cores)` : 'N/A'} | LoadAvg(1m): ${load1 || 'N/A'}${loadRatio ? ` (Độ bão hòa tải/nhân: ${loadRatio})` : ''}

[2. SỰ CỐ KỸ THUẬT KÍCH HOẠT & CỜ TRẠNG THÁI PHẦN CỨNG]
- Thời điểm      : ${incidentTs}
- Phân loại lỗi  : ${incidentKind.toUpperCase()}
- Chi tiết kỹ thuật: ${incidentReason}
- Cờ phần cứng   : SMART_DISK_ERR=${Boolean(v && v.alerts && v.alerts.smart)} | THERMAL_THROTTLE=${Boolean(v && v.alerts && v.alerts.thermal)} | DOS_FLOOD=${Boolean(v && v.alerts && v.alerts.dos)} | UPS_ON_BATTERY=${Boolean(v && v.alerts && v.alerts.power)}

[3. SỐ LIỆU TELEMETRY TÀI NGUYÊN, PHÂN VÙNG Ổ ĐĨA & LƯU LƯỢNG MẠNG THỰC TẾ]
- CPU & Nhiệt độ : CPU=${v && v.cpu != null ? `${Math.round(v.cpu)}%` : 'N/A'} (Ngưỡng: ${th.cpu}%) | Nhiệt độ=${v && v.temperature != null ? `${Math.round(v.temperature)}°C` : 'N/A'} (Ngưỡng: ${th.temp}°C)
- Bộ nhớ RAM     : ${v && v.ram != null ? `${Math.round(v.ram)}%` : 'N/A'} (Ngưỡng: ${th.ram}%)${a.ram && a.ram.total ? ` — Đã dùng: ${fmtBytesHuman(a.ram.used)} / Tổng: ${fmtBytesHuman(a.ram.total)} (Còn trống: ${fmtBytesHuman(Math.max(0, a.ram.total - (a.ram.used || 0)))})` : ''}
- Phân vùng Đĩa  : Cao nhất=${v && v.disk != null ? `${Math.round(v.disk)}%` : 'N/A'} (Ngưỡng: ${th.disk}%)
${diskLines.length ? diskLines.join('\n') : '  * (Đo qua SNMP hoặc 1 phân vùng mặc định)'}
- Đĩa cứng SMART : ${smartStr}
- Nguồn / UPS    : ${upsStr}
- Mạng & Gói tin : Ping RTT=${v && v.rtt != null ? `${v.rtt} ms` : 'N/A'} | Tải xuống (RX)=${netIn != null ? `${fmtBytesHuman(netIn)}/s` : 'N/A'} | Tải lên (TX)=${netOut != null ? `${fmtBytesHuman(netOut)}/s` : 'N/A'} | Tốc độ gói (PPS)=${pktRate != null ? `${pktRate} gói/s` : 'N/A'} (Ngưỡng DoS: ${th.dos_packet_rate} gói/s)${avgPktBytes != null ? ` | Kích thước gói TB: ~${avgPktBytes} B/gói` : ''}${v && v.dos_details ? ` | Dấu hiệu tấn công: ${v.dos_details}` : ''}

[4. THỐNG KÊ CƠ SỞ 24H & HỒI QUY TUYẾN TÍNH DỰ ĐOÁN DUNG LƯỢNG]
- Xu hướng 24h   : ${trend24h}

[5. CHUỖI MẪU METRIC KỸ THUẬT GẦN NHẤT (TỪ MỚI ĐẾN CŨ)]
THỜI GIAN (ISO)          | CPU%   | RAM%   | DISK%  | NHIỆT   | RTT(ms)  | BĂNG THÔNG RX | BĂNG THÔNG TX
${sampleTableRows}

[6. YÊU CẦU CHẨN ĐOÁN DÀNH CHO AI CHATBOX]
Hãy đóng vai Chuyên gia Quản trị Hạ tầng Hệ thống & Mạng (Senior SRE / NOC Architect). Dựa trên toàn bộ Logs Kỹ thuật, Bảng phân vùng, Cờ phần cứng và Chuỗi mẫu Metric ở trên, hãy phân tích chuyên sâu:
1. Tóm tắt vấn đề kỹ thuật cốt lõi & mức độ nguy cấp hiện tại.
2. Phân tích nguyên nhân gốc rễ (Root Cause Analysis) dựa trên mối tương quan giữa các thông số (CPU/LoadAvg, RAM còn trống, tốc độ tăng phân vùng Disk, mã lỗi SMART, nhiệt độ hoặc kích thước gói tin/PPS).
3. Đề xuất các câu lệnh kiểm tra chuyên sâu (CLI trên Linux/Windows/Router/Switch/Firewall) và hướng khắc phục từng bước.
4. Dự báo xu hướng tài nguyên & rủi ro ngừng dịch vụ trong 24–72 giờ tới.`;

  return {
    device_id: targetDevId || null,
    device_name: devName,
    device_type: devType,
    address,
    severity: devSev,
    event_id: ev ? ev.id : null,
    kind: incidentKind,
    reason: incidentReason,
    tech_summary: techSummaryParts,
    trend_24h: trend24h,
    log_text: logText,
  };
}

// Unified ultra-compact incident prompt template (Vietnamese & English)
function buildIncidentPrompt(ctx, lang = 'vi') {
  const isEn = lang === 'en';
  const m = [
    ctx.cpu != null ? `CPU=${Math.round(ctx.cpu)}%` : null,
    ctx.ram != null ? `RAM=${Math.round(ctx.ram)}%` : null,
    ctx.disk != null ? `Disk=${Math.round(ctx.disk)}%` : null,
    ctx.temp != null ? `Temp=${Math.round(ctx.temp)}C` : null,
    ctx.rtt != null ? `RTT=${ctx.rtt}ms` : null,
    ctx.pkt_rate != null ? `Pkt=${Math.round(ctx.pkt_rate)}pps` : null,
    ctx.smart && ctx.smart.ok === false ? `SMART=FAIL(${ctx.smart.details || 'bad_sector'})` : null,
    ctx.power && ctx.power.on_battery ? `UPS=ON_BATTERY(${ctx.power.battery_percent ?? '?'}%)` : null,
  ].filter(Boolean).join(' ') || 'N/A';

  const techLine = ctx.tech_summary ? `\nTech_Logs: ${ctx.tech_summary}` : '';

  if (isEn) {
    return {
      system: 'You are a senior NOC/SRE AI assistant. Analyze the infrastructure technical telemetry and respond with ONLY a single valid JSON object (no markdown fences) matching this exact schema: {"issue":"Concise problem description","cause":"Most likely technical root cause","solution":"Step-by-step CLI/remediation actions","prediction":"Predictive impact/trend if left unresolved"}. Keep total output under 120 words.',
      user: `[INCIDENT_TEMPLATE_V1]
Lang: en
Device: ${ctx.device_name} (Type: ${ctx.device_type} | IP: ${ctx.address || 'N/A'})
Severity: ${ctx.severity} | Status: ${ctx.status}
Incident_Kind: ${ctx.kind}
Reason: ${ctx.reason}
Metrics: ${m}${techLine}
Trend_24h: ${ctx.trend || 'N/A'}`,
    };
  }

  return {
    system: 'Bạn là chuyên gia AI quản trị hạ tầng mạng & máy chủ (NOC/SRE). Hãy phân tích log kỹ thuật của sự cố và trả về DUY NHẤT 1 chuỗi JSON hợp lệ (không bọc markdown) theo đúng mẫu: {"issue":"Tóm tắt vấn đề kỹ thuật","cause":"Nguyên nhân gốc rễ khả dĩ","solution":"Đề xuất lệnh kiểm tra & bước xử lý cụ thể","prediction":"Dự đoán rủi ro/xu hướng nếu không xử lý"}. Ngắn gọn, chính xác, tổng cộng dưới 130 từ.',
    user: `[TEMPLATE_SU_CO_V1]
Lang: vi
Thiet_bi: ${ctx.device_name} (Loai: ${ctx.device_type} | IP: ${ctx.address || 'N/A'})
Muc_canh_bao: ${ctx.severity} | Trang_thai: ${ctx.status}
Loai_su_co: ${ctx.kind}
Chi_tiet: ${ctx.reason}
Chi_so: ${m}${techLine}
Xu_huong_24h: ${ctx.trend || 'N/A'}`,
  };
}

// Unified ultra-compact End-of-Day Digest prompt template (Vietnamese & English)
function buildDailyDigestPrompt(digest, lang = 'vi') {
  const isEn = lang === 'en';
  if (isEn) {
    return {
      system: 'You are a senior NOC/SRE AI analyst. Analyze the 24-hour infrastructure summary and return ONLY a single valid JSON object (no markdown) matching this exact schema: {"issue":"24h executive health summary & key incidents","cause":"Primary bottleneck or instability patterns","solution":"Actionable optimization & maintenance checklist","prediction":"Capacity & failure prediction for the next 3-7 days"}. Keep total output under 140 words.',
      user: `[DAILY_DIGEST_TEMPLATE_V1]
Lang: en
Fleet: total=${digest.total_devices}, online=${digest.online_devices}, down=${digest.down_devices}, warning=${digest.warning_devices}
Events_24h: total=${digest.total_events}, critical=${digest.critical_events}, high=${digest.high_events}, down=${digest.down_events}, dos=${digest.dos_events}, smart=${digest.smart_events}, thermal=${digest.thermal_events}
Top_Problem_Devices: ${digest.top_devices || 'None'}
Resource_Risks: ${digest.resource_risks || 'None'}`,
    };
  }

  return {
    system: 'Bạn là chuyên gia AI phân tích vận hành hệ thống (NOC/SRE). Phân tích báo cáo tổng hợp 24h và trả về DUY NHẤT 1 JSON hợp lệ (không bọc markdown) theo đúng mẫu: {"issue":"Tóm tắt tình trạng vận hành & sự cố nổi bật 24h qua","cause":"Nguyên nhân chính gây mất ổn định hoặc nghẽn cổ chai","solution":"Đề xuất lịch bảo trì & tối ưu cấu hình","prediction":"Dự báo dung lượng & nguy cơ lỗi trong 3-7 ngày tới"}. Ngắn gọn, tổng cộng dưới 150 từ.',
    user: `[TEMPLATE_BAO_CAO_CUOI_NGAY_V1]
Lang: vi
Tong_quan_thiet_bi: tong=${digest.total_devices}, online=${digest.online_devices}, mat_ket_noi=${digest.down_devices}, canh_bao=${digest.warning_devices}
Su_kien_24h: tong=${digest.total_events}, nghiem_trong=${digest.critical_events}, cao=${digest.high_events}, mat_ket_noi=${digest.down_events}, dos=${digest.dos_events}, smart=${digest.smart_events}, qua_nhiet=${digest.thermal_events}
Thiet_bi_hay_loi_nhat: ${digest.top_devices || 'Không có'}
Rui_ro_tai_nguyen: ${digest.resource_risks || 'Ổn định'}`,
  };
}

// Parse JSON returned by LLM safely, tolerating markdown code fences, array wrappers, and key variations.
function parseAiJsonResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    let obj = JSON.parse(cleaned);
    if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') obj = obj[0];
    if (!obj || typeof obj !== 'object') return null;

    const normObj = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k && v != null) {
        normObj[k.toLowerCase().replace(/[\s_-]+/g, '')] = v;
      }
    }
    const str = (...keys) => {
      for (const k of keys) {
        if (obj[k] != null && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
        if (obj[k] != null && typeof obj[k] !== 'object') return String(obj[k]).trim();
        const normKey = k.toLowerCase().replace(/[\s_-]+/g, '');
        if (normObj[normKey] != null) {
          const val = normObj[normKey];
          if (typeof val === 'string' && val.trim()) return val.trim();
          if (typeof val !== 'object') return String(val).trim();
        }
      }
      return '';
    };

    const issue = str('issue', 'problem', 'van_de', 'vande', 'su_co', 'suco', 'tinh_trang', 'tinhtrang', 'summary', 'tom_tat', 'tomtat', 'detail', 'mota', 'diagnosis', 'chandoan', 'alert');
    const cause = str('cause', 'root_cause', 'rootcause', 'nguyen_nhan', 'nguyennhan', 'ly_do', 'lydo', 'nguyennhangocre', 'rootcauseanalysis');
    const solution = str('solution', 'recommendation', 'remediation', 'action', 'actions', 'steps', 'giai_phap', 'giaiphap', 'khac_phuc', 'khacphuc', 'xu_ly', 'xuly', 'de_xuat', 'dexuat', 'cacbuocxuly');
    const prediction = str('prediction', 'forecast', 'trend', 'du_doan', 'dudoan', 'du_bao', 'dubao', 'xu_huong', 'xuhuong', 'risk', 'impact', 'ruiro', 'dubaoxuhuong');

    if (!issue && !cause && !solution) return null;
    return { issue, cause, solution, prediction };
  } catch {
    return null;
  }
}

// Deterministic local expert fallback (0 external tokens) used when testing without an API key
// or if the external AI endpoint fails/times out, ensuring the JSON template contract is always met.
function generateLocalExpertFallback(ctx, lang = 'vi') {
  const isEn = lang === 'en';
  const r = String(ctx.reason || '').toLowerCase();
  const k = ctx.kind || 'warning';

  if (k === 'smart' || r.includes('smart') || r.includes('bad sector')) {
    return isEn ? {
      issue: `Physical storage degradation (SMART / Bad Sector) on ${ctx.device_name}.`,
      cause: 'Disk media wear, bad sectors, or storage controller I/O errors.',
      solution: '1. Verify backup integrity immediately. 2. Run smartctl -a / chkdsk. 3. Schedule hot-swap disk replacement.',
      prediction: 'High risk of unrecoverable data loss or OS crash within 24–72 hours if disk is not replaced.',
    } : {
      issue: `Ổ đĩa vật lý trên ${ctx.device_name} báo lỗi SMART / Bad Sector.`,
      cause: 'Lão hóa bề mặt đĩa từ/NAND SSD, xuất hiện khối lỗi (Bad Sector) hoặc lỗi cáp/controller lưu trữ.',
      solution: '1. Sao lưu khẩn cấp dữ liệu quan trọng. 2. Kiểm tra chi tiết bằng smartctl -a. 3. Lên lịch thay thế ổ cứng ngay.',
      prediction: 'Nguy cơ rất cao mất dữ liệu hoặc treo hệ điều hành trong 24–72 giờ tới nếu tiếp tục ghi đọc nặng.',
    };
  }

  if (k === 'dos' || r.includes('flood') || r.includes('dos')) {
    return isEn ? {
      issue: `Abnormal packet rate spike (${ctx.pkt_rate || 'high'} pps) on ${ctx.device_name} indicating a Flood/DoS attack.`,
      cause: 'UDP/SYN flood from external/internal sources or a broadcast loop on a switch port.',
      solution: '1. Inspect top talkers & firewall connection table. 2. Enable rate-limiting / SYN cookies / drop invalid packets. 3. Check switch STP loop protection.',
      prediction: 'Sustained packet flood can exhaust router CPU/conntrack tables and drop legitimate LAN/WAN traffic.',
    } : {
      issue: `Lưu lượng gói tin tăng đột biến (${ctx.pkt_rate || 'cao'} gói/s) trên ${ctx.device_name}, nghi ngờ tấn công Flood/DoS.`,
      cause: 'Tấn công UDP/SYN Flood từ mạng ngoài/máy trạm nhiễm mã độc, hoặc vòng lặp mạng (Switching Loop).',
      solution: '1. Kiểm tra bảng kết nối (Conntrack/Torch) trên Router/Firewall. 2. Bật giới hạn tốc độ gói tin (Rate Limit / SYN Flood protection) và cô lập IP nguồn bất thường.',
      prediction: 'Nếu kéo dài sẽ làm đầy bảng NAT/Session, gây nghẽn toàn bộ đường truyền và rớt gói diện rộng.',
    };
  }

  if (k === 'thermal' || r.includes('nhiệt độ') || r.includes('overheat') || (ctx.temp != null && ctx.temp >= 85)) {
    return isEn ? {
      issue: `CPU temperature on ${ctx.device_name} reached ${ctx.temp ?? '>85'}°C (Thermal Throttling zone).`,
      cause: 'Cooling fan failure, dried thermal paste, dust buildup, or rack HVAC malfunction.',
      solution: '1. Check server room AC and chassis fan RPM. 2. Inspect runaway CPU processes. 3. Clean heatsink/air filters.',
      prediction: 'Hardware will throttle clock speed (degrading performance) and may trigger thermal shutdown at >100°C.',
    } : {
      issue: `Nhiệt độ CPU của ${ctx.device_name} vượt ngưỡng an toàn (${ctx.temp ?? '>85'}°C – Thermal Throttling).`,
      cause: 'Quạt tản nhiệt hỏng/quay chậm, khô keo tản nhiệt, bụi bẩn bít khe gió hoặc điều hòa phòng server gặp sự cố.',
      solution: '1. Kiểm tra ngay nhiệt độ phòng máy & quạt tản nhiệt. 2. Rà soát tiến trình chiếm CPU 100%. 3. Vệ sinh tản nhiệt phần cứng.',
      prediction: 'CPU sẽ tự hạ xung nhịp làm chậm dịch vụ và có nguy cơ tự tắt nguồn bảo vệ phần cứng nếu vượt 100°C.',
    };
  }

  if (k === 'power' || r.includes('ups') || r.includes('mất điện') || r.includes('battery')) {
    return isEn ? {
      issue: `${ctx.device_name} lost AC utility power and is running on UPS battery.`,
      cause: 'Grid power outage, tripped circuit breaker, or loose PDU power cord.',
      solution: '1. Check main breaker and generator auto-start. 2. Stop non-essential VMs to extend battery runtime. 3. Prepare graceful shutdown if battery < 20%.',
      prediction: 'Abrupt power loss when UPS battery depletes will cause unclean filesystem shutdown and DB corruption.',
    } : {
      issue: `${ctx.device_name} mất nguồn điện lưới AC và đang chạy bằng pin dự phòng UPS.`,
      cause: 'Cúp điện lưới khu vực, nhảy CB tủ điện hoặc lỏng dây nguồn từ thanh PDU vào UPS.',
      solution: '1. Kiểm tra nguồn điện tổng và máy phát dự phòng. 2. Tắt bớt dịch vụ/VM phụ để kéo dài pin. 3. Chuẩn bị tắt máy an toàn nếu pin < 20%.',
      prediction: 'Khi cạn pin UPS mà chưa có điện lưới, máy chủ sẽ sập nguồn đột ngột gây nguy cơ lỗi filesystem và hỏng Database.',
    };
  }

  if (r.includes('ổ đĩa') || r.includes('disk') || (ctx.disk != null && ctx.disk >= 90)) {
    return isEn ? {
      issue: `Disk utilization on ${ctx.device_name} is critically high (${ctx.disk ?? '>90'}%).`,
      cause: 'Unrotated application/system logs, growing database WAL/backups, or temporary files.',
      solution: '1. Run du -sh /* | sort -hr to locate large directories. 2. Clean old logs/journald/temp files. 3. Expand volume or enable logrotate.',
      prediction: `Trend (${ctx.trend || 'rising'}): once disk hits 100%, databases and services will fail with ENOSPC I/O errors.`,
    } : {
      issue: `Dung lượng ổ đĩa trên ${ctx.device_name} vượt ngưỡng báo động (${ctx.disk ?? '>90'}%).`,
      cause: 'Log hệ thống/ứng dụng chưa xoay vòng (logrotate), file backup tạm hoặc dữ liệu Database phình to.',
      solution: '1. Kiểm tra thư mục chiếm dung lượng lớn (du -sh /*). 2. Dọn dẹp log cũ, cache, journald. 3. Mở rộng phân vùng hoặc cấu hình tự dọn log.',
      prediction: `Xu hướng (${ctx.trend || 'đang tăng'}): khi đầy 100%, dịch vụ và Database sẽ ngừng ghi và phát sinh lỗi Disk I/O.`,
    };
  }

  if (r.includes('cpu') || r.includes('ram') || (ctx.cpu != null && ctx.cpu >= 90) || (ctx.ram != null && ctx.ram >= 90)) {
    return isEn ? {
      issue: `Sustained high resource utilization on ${ctx.device_name} (CPU: ${ctx.cpu ?? '—'}%, RAM: ${ctx.ram ?? '—'}%).`,
      cause: 'Traffic surge, unoptimized query/cronjob, or memory leak in a background worker.',
      solution: '1. Inspect top/htop processes by CPU/MEM. 2. Check slow database queries or stuck workers. 3. Restart leaking service or scale resources.',
      prediction: 'Continued saturation can trigger Linux OOM Killer or cause request timeouts across dependent services.',
    } : {
      issue: `Tài nguyên máy chủ ${ctx.device_name} quá tải kéo dài (CPU: ${ctx.cpu ?? '—'}%, RAM: ${ctx.ram ?? '—'}%).`,
      cause: 'Đột biến truy cập, truy vấn Database chưa tối ưu, tiến trình cronjob treo hoặc rò rỉ bộ nhớ (Memory Leak).',
      solution: '1. Kiểm tra tiến trình chiếm dụng cao bằng top/htop. 2. Rà soát truy vấn chậm và giới hạn worker. 3. Khởi động lại dịch vụ rò rỉ RAM hoặc nâng cấp tài nguyên.',
      prediction: 'Nếu duy trì trên 95%, hệ điều hành có thể kích hoạt OOM Killer tự hủy tiến trình quan trọng hoặc gây timeout toàn hệ thống.',
    };
  }

  if (k === 'down' || ctx.status === 'down') {
    return isEn ? {
      issue: `${ctx.device_name} (${ctx.device_type}) is unreachable (${ctx.reason}).`,
      cause: 'Network link/switch port down, power loss, firewall block, or OS/daemon crash.',
      solution: '1. Check physical link LEDs and upstream switch/router port. 2. Verify power/IPMI/iLO console. 3. Check VLAN routing and firewall rules.',
      prediction: `Trend (${ctx.trend || 'N/A'}): downstream devices or services depending on ${ctx.device_name} will experience outage until restored.`,
    } : {
      issue: `Thiết bị ${ctx.device_name} (${ctx.device_type}) mất kết nối hoàn toàn (${ctx.reason}).`,
      cause: 'Đứt cáp mạng/rớt cổng Switch, mất nguồn thiết bị, treo hệ điều hành hoặc chặn bởi tường lửa.',
      solution: '1. Kiểm tra đèn tín hiệu cổng mạng & Switch/Router kế cận. 2. Kiểm tra nguồn điện hoặc truy cập console IPMI/iLO/Hypervisor. 3. Kiểm tra định tuyến VLAN.',
      prediction: `Xu hướng (${ctx.trend || 'N/A'}): các dịch vụ và nhánh mạng phụ thuộc vào ${ctx.device_name} sẽ bị gián đoạn cho đến khi khôi phục.`,
    };
  }

  return isEn ? {
    issue: `Warning detected on ${ctx.device_name}: ${ctx.reason}.`,
    cause: 'Operating metric exceeded configured safety threshold.',
    solution: 'Inspect device logs, verify network/hardware health, and remediate the reported warning.',
    prediction: 'Early intervention prevents escalation into a full service outage.',
  } : {
    issue: `Phát hiện cảnh báo trên ${ctx.device_name}: ${ctx.reason}.`,
    cause: 'Chỉ số vận hành vượt ngưỡng an toàn hoặc dịch vụ giám sát phản hồi bất thường.',
    solution: 'Kiểm tra chi tiết chỉ số trên trang Thiết bị, rà soát log hệ thống và xử lý nguyên nhân gây cảnh báo.',
    prediction: 'Xử lý sớm giúp ngăn ngừa cảnh báo leo thang thành sự cố ngừng dịch vụ.',
  };
}

function generateLocalDailyDigestFallback(digest, lang = 'vi') {
  const isEn = lang === 'en';
  if (isEn) {
    return {
      issue: `24h Summary: ${digest.online_devices}/${digest.total_devices} devices online (${digest.down_devices} down, ${digest.warning_devices} warning). Recorded ${digest.total_events} events (${digest.critical_events} critical, ${digest.high_events} high).`,
      cause: digest.top_devices !== 'None'
        ? `Primary incidents concentrated on: ${digest.top_devices}.`
        : 'No major recurring outages recorded in the last 24 hours.',
      solution: '1. Review top alerting devices and resolve unacknowledged High/Critical incidents. 2. Check disk growth and thermal trends.',
      prediction: digest.resource_risks !== 'None'
        ? `Capacity warning: ${digest.resource_risks}. Proactive cleanup recommended within 3 days.`
        : 'System capacity and network stability trends are within normal operating bounds for the next 7 days.',
    };
  }
  return {
    issue: `Tổng kết 24h: ${digest.online_devices}/${digest.total_devices} thiết bị hoạt động (${digest.down_devices} mất kết nối, ${digest.warning_devices} cảnh báo). Ghi nhận ${digest.total_events} sự kiện (${digest.critical_events} nghiêm trọng, ${digest.high_events} cao).`,
    cause: digest.top_devices !== 'Không có'
      ? `Các sự cố tập trung chủ yếu tại: ${digest.top_devices}.`
      : 'Hệ thống vận hành ổn định, không có điểm nghẽn nghiêm trọng lặp lại trong 24h qua.',
    solution: '1. Rà soát các thiết bị có số lần cảnh báo cao nhất. 2. Kiểm tra định kỳ dung lượng đĩa, nhiệt độ CPU và pin UPS.',
    prediction: digest.resource_risks !== 'Ổn định'
      ? `Cảnh báo xu hướng tài nguyên: ${digest.resource_risks}. Cần dọn dẹp hoặc mở rộng trong 3 ngày tới.`
      : 'Dự báo xu hướng tải và dung lượng toàn hệ thống an toàn trong 3–7 ngày tới.',
  };
}

class AiService {
  constructor(db, opts = {}) {
    this.db = db;
    this.fetchFn = opts.fetchFn || globalThis.fetch;
    this.lastDailyDate = null;
    this.inFlight = new Map();
    this.purgeUnworthyAiReports();
  }

  // Purge any legacy unworthy AI reports (disconnection/ping down, printer toner/drum)
  purgeUnworthyAiReports() {
    try {
      this.db.prepare(`
        DELETE FROM ai_reports
        WHERE kind = 'down'
           OR fingerprint LIKE '%:down:%'
           OR device_id IN (SELECT id FROM devices WHERE type = 'printer')
           OR issue LIKE '%mất kết nối%'
           OR issue LIKE '%không phản hồi icmp%'
           OR issue LIKE '%không ping được%'
           OR issue LIKE '%máy in%'
           OR issue LIKE '%mực%'
           OR issue LIKE '%drum%'
           OR issue LIKE '%printer%'
      `).run();
    } catch { /* ignore */ }
  }

  // Count how many real external AI API calls were made today (UTC/local day)
  callsToday(now = Date.now()) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tok FROM ai_reports WHERE ts >= ? AND source = 'ai' AND cached = 0",
    ).get(startOfDay.getTime());
    const allRow = this.db.prepare(
      'SELECT COUNT(*) AS total_reports, COALESCE(SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END), 0) AS total_cached FROM ai_reports WHERE ts >= ?',
    ).get(startOfDay.getTime());
    return {
      calls_today: row ? row.c : 0,
      tokens_today: row ? row.tok : 0,
      cached_today: allRow ? allRow.total_cached : 0,
      cached_hits: allRow ? allRow.total_cached : 0,
      reports_today: allRow ? allRow.total_reports : 0,
      total_reports: allRow ? allRow.total_reports : 0,
    };
  }

  // Call external OpenAI-compatible Chat Completions API with ultra-compact prompt
  async _callLlm(aiConfig, messages, maxTokens = 450) {
    const url = aiConfig.api_url || (PROVIDER_PRESETS[aiConfig.provider] && PROVIDER_PRESETS[aiConfig.provider].api_url);
    const model = aiConfig.model || (PROVIDER_PRESETS[aiConfig.provider] && PROVIDER_PRESETS[aiConfig.provider].model) || 'gpt-4o-mini';
    if (!url) throw new Error('Chưa cấu hình URL API AI');

    const headers = { 'Content-Type': 'application/json' };
    if (aiConfig.api_key) headers.Authorization = `Bearer ${aiConfig.api_key}`;

    const isGroq = aiConfig.provider === 'groq' || (url && url.includes('api.groq.com'));
    const isGemini = aiConfig.provider === 'gemini'
      || (url && url.includes('generativelanguage.googleapis.com'))
      || (model && model.toLowerCase().includes('gemini'));
    const isReasoning = /(?:gpt-oss|r1|reasoner|o1|o3|thinking|qwq)/i.test(model);

    // Modern reasoning models (e.g. Gemini Flash, openai/gpt-oss-120b on Groq, DeepSeek-R1)
    // require adequate token headroom for thinking tokens + structured output.
    const minTokens = (isGemini || isReasoning || isGroq) ? 800 : 450;
    const effectiveMaxTokens = Math.min(3000, Math.max(100, Number(maxTokens || aiConfig.max_tokens || minTokens)));

    const reqBody = {
      model,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      temperature: 0.2,
      max_tokens: effectiveMaxTokens,
    };

    if (isGemini) {
      // Modern Gemini models enable internal thinking/reasoning by default on Google's OpenAI-compatible endpoint.
      // Setting reasoning_effort='none' eliminates thinking tokens, delivering 5x faster speed and zero truncation.
      reqBody.reasoning_effort = 'none';
      reqBody.response_format = { type: 'json_object' };
    } else if (isGroq) {
      if (isReasoning) {
        // openai/gpt-oss-120b and other OSS reasoning models on Groq generate reasoning tokens that count
        // towards max_tokens. Setting 'low' minimizes thinking tokens so JSON output is never starved.
        reqBody.reasoning_effort = 'low';
      }
      reqBody.response_format = { type: 'json_object' };
    } else if (aiConfig.provider === 'openai' || aiConfig.provider === 'deepseek') {
      reqBody.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      let res = await this.fetchFn(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(reqBody),
      });

      // Resilience: If a model rejects reasoning_effort (e.g. non-reasoning Groq model), retry once without it
      if (!res.ok && reqBody.reasoning_effort && res.status === 400) {
        const errClone = await res.clone().text().catch(() => '');
        if (/reasoning_effort/i.test(errClone)) {
          delete reqBody.reasoning_effort;
          res = await this.fetchFn(url, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify(reqBody),
          });
        }
      }

      // Resilience: If a custom model rejects response_format, retry once without it
      if (!res.ok && reqBody.response_format && res.status === 400) {
        const errClone = await res.clone().text().catch(() => '');
        if (/response_format/i.test(errClone)) {
          delete reqBody.response_format;
          res = await this.fetchFn(url, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify(reqBody),
          });
        }
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`AI HTTP ${res.status}: ${errText.slice(0, 160)}`);
      }
      const data = await res.json();
      const choice = data && data.choices && data.choices[0];
      const finishReason = choice && choice.finish_reason;
      const content = choice && choice.message && choice.message.content;
      const usage = data && data.usage ? data.usage : {};

      if (finishReason === 'length') {
        throw new Error(`AI response was truncated (finish_reason=length, token budget exhausted). Increase max_tokens in settings or disable thinking. Snippet: ${String(content || '').slice(0, 100)}`);
      }
      if (!content || typeof content !== 'string' || !content.trim()) {
        throw new Error('AI returned an empty response content');
      }

      const parsed = parseAiJsonResponse(content);
      if (!parsed) {
        throw new Error(`AI response did not match JSON template: ${String(content).slice(0, 140)}`);
      }

      return {
        ...parsed,
        prompt_tokens: Number(usage.prompt_tokens) || Math.ceil((messages.system.length + messages.user.length) / 4),
        completion_tokens: Number(usage.completion_tokens) || Math.ceil(String(content || '').length / 4),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Analyze a High/Critical device incident (with fingerprint deduplication cache to save tokens)
  async analyzeIncident(ctx, settings, opts = {}) {
    const aiCfg = (settings && settings.ai) || {};
    const lang = opts.lang || (settings && settings.default_lang) || 'vi';
    const force = !!opts.force;

    if (!force && !aiCfg.enabled) return null;
    if (!force && aiCfg.auto_incident === false) return null;

    // Smart Filter: strictly reject down/ping, printer, and non-technical reachability alerts
    if (!isAiAnalyzableIncident(ctx, opts)) return null;

    const now = opts.now || Date.now();
    const fp = buildFingerprint(ctx.device_id, ctx.kind, ctx.reason, lang);
    const cooldownMs = Math.max(1, Number(aiCfg.cooldown_minutes ?? 60)) * 60 * 1000;

    // Deduplicate in-flight parallel calls for identical event in the same tick
    const inFlightKey = `${fp}:${force ? '1' : '0'}`;
    if (this.inFlight.has(inFlightKey)) {
      return await this.inFlight.get(inFlightKey);
    }

    const task = (async () => {
      // 1. Check deduplication cache within cooldown window -> 0 tokens spent!
      if (!force) {
        const cached = this.db.prepare(
          'SELECT * FROM ai_reports WHERE fingerprint = ? AND lang = ? AND ts >= ? ORDER BY ts DESC LIMIT 1',
        ).get(fp, lang, now - cooldownMs);
        if (cached) {
          const info = this.db.prepare(`
            INSERT INTO ai_reports(ts,kind,device_id,device_name,event_id,severity,lang,fingerprint,issue,cause,solution,prediction,prompt_tokens,completion_tokens,cached,source)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0,1,?)
          `).run(
            now, 'incident', ctx.device_id || null, ctx.device_name || '', ctx.event_id || null,
            ctx.severity || 'high', lang, fp, cached.issue, cached.cause, cached.solution, cached.prediction, cached.source,
          );
          return this.getReport(Number(info.lastInsertRowid));
        }
      }

      const trend = computeDeviceTrendSummary(this.db, ctx.device_id, now);
      const fullCtx = { ...ctx, trend };
      const prompt = buildIncidentPrompt(fullCtx, lang);

      // 2. Check daily budget cap and whether an external API key/endpoint is configured
      const stats = this.callsToday(now);
      const limit = Number(aiCfg.daily_call_limit || 50);
      const hasEndpoint = Boolean(aiCfg.api_key || aiCfg.provider === 'ollama' || (aiCfg.provider === 'custom' && aiCfg.api_url));

      let result = null;
      let source = 'heuristic';
      if (aiCfg.enabled && hasEndpoint && (force || stats.calls_today < limit)) {
        try {
          result = await this._callLlm(aiCfg, prompt, aiCfg.max_tokens);
          source = 'ai';
        } catch (err) {
          console.error('[ai] analyzeIncident external LLM error:', err.message);
          result = null;
        }
      }

      if (!result) {
        const fb = generateLocalExpertFallback(fullCtx, lang);
        result = { ...fb, prompt_tokens: 0, completion_tokens: 0 };
        source = 'heuristic';
      }

      const info = this.db.prepare(`
        INSERT INTO ai_reports(ts,kind,device_id,device_name,event_id,severity,lang,fingerprint,issue,cause,solution,prediction,prompt_tokens,completion_tokens,cached,source)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
      `).run(
        now, 'incident', ctx.device_id || null, ctx.device_name || '', ctx.event_id || null,
        ctx.severity || 'high', lang, fp,
        result.issue, result.cause, result.solution, result.prediction,
        result.prompt_tokens || 0, result.completion_tokens || 0, source,
      );

      return this.getReport(Number(info.lastInsertRowid));
    })();

    this.inFlight.set(inFlightKey, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  // Collect 24h logs & metrics from server SQLite (ZERO agent changes needed!) and generate Daily AI Digest
  collectDailyDigestData(monitor, now = Date.now()) {
    const since24h = now - 86400e3;
    const snap = monitor.snapshot();
    const s = snap.summary;

    const evCounts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
             SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) AS high,
             SUM(CASE WHEN kind = 'down' THEN 1 ELSE 0 END) AS down_cnt,
             SUM(CASE WHEN kind = 'dos' THEN 1 ELSE 0 END) AS dos_cnt,
             SUM(CASE WHEN kind = 'smart' THEN 1 ELSE 0 END) AS smart_cnt,
             SUM(CASE WHEN kind = 'thermal' THEN 1 ELSE 0 END) AS thermal_cnt
      FROM events WHERE ts >= ?
    `).get(since24h) || {};

    const topDevs = this.db.prepare(`
      SELECT device_name, COUNT(*) AS c
      FROM events
      WHERE ts >= ? AND device_id IS NOT NULL AND severity IN ('critical', 'high', 'medium')
      GROUP BY device_id, device_name
      ORDER BY c DESC LIMIT 5
    `).all(since24h);

    const risks = [];
    for (const d of snap.devices) {
      if (d.maintenance || d.type === 'printer') continue;
      if (d.disk != null && d.disk >= 80) risks.push(`${d.name}:Disk=${Math.round(d.disk)}%`);
      if (d.cpu != null && d.cpu >= 85) risks.push(`${d.name}:CPU=${Math.round(d.cpu)}%`);
      if (d.temperature != null && d.temperature >= 80) risks.push(`${d.name}:Temp=${Math.round(d.temperature)}C`);
      if (d.alerts && d.alerts.smart) risks.push(`${d.name}:SMART_ERR`);
    }

    return {
      total_devices: s.total,
      online_devices: s.alive,
      down_devices: s.down,
      warning_devices: s.warning,
      total_events: evCounts.total || 0,
      critical_events: evCounts.critical || 0,
      high_events: evCounts.high || 0,
      down_events: evCounts.down_cnt || 0,
      dos_events: evCounts.dos_cnt || 0,
      smart_events: evCounts.smart_cnt || 0,
      thermal_events: evCounts.thermal_cnt || 0,
      top_devices: topDevs.map((x) => `${x.device_name}(${x.c})`).join(', ') || (snap.lang === 'en' ? 'None' : 'Không có'),
      resource_risks: risks.slice(0, 6).join(', ') || (snap.lang === 'en' ? 'None' : 'Ổn định'),
    };
  }

  async generateDailyDigest(monitor, settings, opts = {}) {
    const aiCfg = (settings && settings.ai) || {};
    const lang = opts.lang || (settings && settings.default_lang) || 'vi';
    const now = opts.now || Date.now();
    const digestData = this.collectDailyDigestData(monitor, now);
    const prompt = buildDailyDigestPrompt(digestData, lang);

    const stats = this.callsToday(now);
    const limit = Number(aiCfg.daily_call_limit || 50);
    const hasEndpoint = Boolean(aiCfg.api_key || aiCfg.provider === 'ollama' || (aiCfg.provider === 'custom' && aiCfg.api_url));

    let result = null;
    let source = 'heuristic';
    if (aiCfg.enabled && hasEndpoint && stats.calls_today < limit) {
      try {
        result = await this._callLlm(aiCfg, prompt, aiCfg.max_tokens || 350);
        source = 'ai';
      } catch {
        result = null;
      }
    }

    if (!result) {
      const fb = generateLocalDailyDigestFallback(digestData, lang);
      result = { ...fb, prompt_tokens: 0, completion_tokens: 0 };
      source = 'heuristic';
    }

    const labelName = lang === 'en' ? 'End-of-Day System Digest (24h)' : 'Báo cáo tổng hợp cuối ngày (24h)';
    const info = this.db.prepare(`
      INSERT INTO ai_reports(ts,kind,device_id,device_name,event_id,severity,lang,fingerprint,issue,cause,solution,prediction,prompt_tokens,completion_tokens,cached,source)
      VALUES(?,'daily',NULL,?,NULL,'high',?,'daily_digest',?,?,?,?,?,?,0,?)
    `).run(
      now, labelName, lang,
      result.issue, result.cause, result.solution, result.prediction,
      result.prompt_tokens || 0, result.completion_tokens || 0, source,
    );

    return this.getReport(Number(info.lastInsertRowid));
  }

  // Called periodically by Monitor.tick() to trigger End-of-Day digest automatically at configured HH:MM
  checkScheduledDailyDigest(monitor, settings, now = Date.now()) {
    const aiCfg = (settings && settings.ai) || {};
    if (!aiCfg.enabled || !aiCfg.daily_digest_enabled) return false;
    const targetTime = String(aiCfg.daily_digest_time || '23:55');
    const [hh, mm] = targetTime.split(':').map((x) => parseInt(x, 10));
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return false;

    const d = new Date(now);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (this.lastDailyDate === dateKey) return false;

    if (d.getHours() === hh && d.getMinutes() === mm) {
      this.lastDailyDate = dateKey;
      this.generateDailyDigest(monitor, settings, { now }).catch(() => {});
      return true;
    }
    return false;
  }

  getReport(id) {
    return this.db.prepare('SELECT * FROM ai_reports WHERE id = ?').get(id) || null;
  }

  listReports({ kind, deviceId, limit = 100 } = {}) {
    let sql = 'SELECT * FROM ai_reports WHERE 1=1';
    const params = [];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    if (deviceId) { sql += ' AND device_id = ?'; params.push(Number(deviceId)); }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    return this.db.prepare(sql).all(...params);
  }
}

module.exports = {
  AiService,
  PROVIDER_PRESETS,
  buildFingerprint,
  isAiAnalyzableIncident,
  collectDeviceTechnicalLogs,
  fmtBytesHuman,
  fmtDurHuman,
  computeDeviceTrendSummary,
  buildIncidentPrompt,
  buildDailyDigestPrompt,
  parseAiJsonResponse,
  generateLocalExpertFallback,
  generateLocalDailyDigestFallback,
};
