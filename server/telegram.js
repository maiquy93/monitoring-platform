'use strict';

const DEFAULT_TELEGRAM_SETTINGS = {
  enabled: false,
  bot_token: '',
  chat_id: '',
  app_url: '',
  notify_down: true,
  notify_recovered: true,
  notify_threshold: true,
  cooldown_seconds: 30,
  max_per_minute: 20,
};

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTelegramTime(ts = Date.now(), lang = 'vi') {
  try {
    return new Date(ts).toLocaleString(lang === 'en' ? 'en-US' : 'vi-VN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

function resolveDeviceUrl(deviceId, appUrl) {
  const base = String(appUrl || 'http://localhost:8080').trim().replace(/\/+$/, '');
  if (!deviceId) return `${base}/#/`;
  return `${base}/#/device/${encodeURIComponent(deviceId)}`;
}

function formatTelegramMessage(ctx, settings = {}, lang = 'vi') {
  const isEn = lang === 'en';
  const tg = (settings && settings.telegram) || {};
  const orgName = (settings && settings.org_name) || 'Monitoring';
  const now = ctx.ts || Date.now();
  const timeStr = formatTelegramTime(now, lang);
  const devUrl = resolveDeviceUrl(ctx.device_id, ctx.app_url || tg.app_url);

  if (ctx.kind === 'test') {
    return isEn
      ? [
        `🔔 <b>[${escapeHtml(orgName)}] TELEGRAM ALERT TEST</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `✅ <b>Status:</b> Connection successful!`,
        `🖥 <b>Sample Device:</b> <b>Core-Router-01</b> (<code>192.168.1.1</code>)`,
        `🕒 <b>Time:</b> ${escapeHtml(timeStr)}`,
        `📝 <b>Details:</b> Telegram Bot alert channel is ready to deliver real-time incident &amp; recovery notifications.`,
        `🔗 <a href="${escapeHtml(devUrl)}">Open Monitoring Dashboard</a>`,
      ].join('\n')
      : [
        `🔔 <b>[${escapeHtml(orgName)}] TIN NHẮN THỬ NGHIỆM TELEGRAM</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `✅ <b>Trạng thái:</b> Kết nối thông suốt!`,
        `🖥 <b>Thiết bị mẫu:</b> <b>Core-Router-01</b> (<code>192.168.1.1</code>)`,
        `🕒 <b>Thời gian:</b> ${escapeHtml(timeStr)}`,
        `📝 <b>Mô tả:</b> Kênh cảnh báo Telegram Bot đã sẵn sàng gửi thông báo sự cố (🚨 Mất kết nối / ⚠️ Ngưỡng cao / ✅ Phục hồi) theo thời gian thực.`,
        `🔗 <a href="${escapeHtml(devUrl)}">Mở trang Giám sát Hệ thống</a>`,
      ].join('\n');
  }

  let headerIcon = '⚠️';
  let headerTitle = isEn ? 'THRESHOLD ALERT - WARNING' : 'CẢNH BÁO NGƯỠNG - WARNING';
  let statusBadge = 'WARNING';

  if (ctx.kind === 'down') {
    headerIcon = '🚨';
    headerTitle = isEn ? 'DEVICE OFFLINE - DISCONNECTED' : 'MẤT KẾT NỐI - OFFLINE';
    statusBadge = 'OFFLINE (DOWN)';
  } else if (ctx.kind === 'up') {
    headerIcon = '✅';
    headerTitle = isEn ? 'RECOVERED - BACK ONLINE' : 'PHỤC HỒI - ONLINE TRỞ LẠI';
    statusBadge = 'ONLINE (RECOVERED)';
  }

  const devName = escapeHtml(ctx.device_name || 'Unknown Device');
  const devType = ctx.device_type ? ` (${escapeHtml(ctx.device_type.toUpperCase())})` : '';
  const ipStr = escapeHtml(ctx.address || '—');
  const locStr = ctx.location ? `\n📍 <b>${isEn ? 'Location' : 'Vị trí'}:</b> ${escapeHtml(ctx.location)}` : '';
  const reasonStr = escapeHtml(ctx.reason || ctx.message || (ctx.kind === 'up' ? (isEn ? 'Device is back online' : 'Thiết bị đã hoạt động trở lại') : ''));

  const metricParts = [];
  if (ctx.cpu != null) metricParts.push(`CPU: ${Math.round(ctx.cpu)}%`);
  if (ctx.ram != null) metricParts.push(`RAM: ${Math.round(ctx.ram)}%`);
  if (ctx.disk != null) metricParts.push(`Disk: ${Math.round(ctx.disk)}%`);
  if (ctx.temp != null) metricParts.push(`Temp: ${Math.round(ctx.temp)}°C`);
  const metricsLine = metricParts.length
    ? `\n📊 <b>${isEn ? 'Metrics' : 'Thông số'}:</b> <code>${escapeHtml(metricParts.join(' | '))}</code>`
    : '';

  const suppressedNote = ctx.suppressed_before > 0
    ? `\n🛡 <i>${isEn ? `(Anti-spam: coalesced ${ctx.suppressed_before} rapid events)` : `(Chống spam: đã gộp ${ctx.suppressed_before} tin nhắn dồn dập trước đó)`}</i>`
    : '';

  return [
    `${headerIcon} <b>[${escapeHtml(orgName)}] ${headerTitle}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🖥 <b>${isEn ? 'Device' : 'Thiết bị'}:</b> <b>${devName}</b>${devType}`,
    `🌐 <b>IP / Host:</b> <code>${ipStr}</code>${locStr}`,
    `📌 <b>${isEn ? 'State' : 'Trạng thái'}:</b> <b>${statusBadge}</b>`,
    `🕒 <b>${isEn ? 'Time' : 'Thời gian'}:</b> ${escapeHtml(timeStr)}`,
    `📝 <b>${isEn ? 'Details' : 'Mô tả'}:</b> ${reasonStr}${metricsLine}${suppressedNote}`,
    `🔗 <a href="${escapeHtml(devUrl)}">${isEn ? 'View Device Details' : 'Xem chi tiết thiết bị'}</a>`,
  ].join('\n');
}

class TelegramService {
  constructor(db, opts = {}) {
    this.db = db;
    this.fetchFn = opts.fetchFn || global.fetch;
    this.deviceCooldowns = new Map(); // `${deviceId}:${kind}` -> ts
    this.windowTimestamps = [];       // sliding 60s window for anti-storm rate limiting
    this.rateLimitedUntil = 0;
    this.suppressedSinceLastSend = 0;
    this.stats = {
      day: '',
      sent_today: 0,
      suppressed_today: 0,
      total_sent: 0,
      last_sent_at: null,
      last_error: null,
    };
  }

  _syncDay(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.stats.day !== day) {
      this.stats.day = day;
      this.stats.sent_today = 0;
      this.stats.suppressed_today = 0;
    }
  }

  getStats(now = Date.now()) {
    this._syncDay(now);
    return { ...this.stats };
  }

  isConfigured(settings) {
    const tg = (settings && settings.telegram) || {};
    return Boolean(tg.enabled && String(tg.bot_token || '').trim() && String(tg.chat_id || '').trim());
  }

  async sendRawMessage({ bot_token, chat_id, text, timeoutMs = 8000 }) {
    const token = String(bot_token || '').trim();
    const chatId = String(chat_id || '').trim();
    if (!token) throw new Error('Thiếu Bot Token Telegram');
    if (!chatId) throw new Error('Thiếu Chat ID / Group ID Telegram');
    if (typeof this.fetchFn !== 'function') {
      throw new Error('Môi trường máy chủ không hỗ trợ fetch HTTP');
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    let res;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err && err.name === 'AbortError'
        ? 'Kết nối tới Telegram API quá thời gian chờ (Timeout)'
        : `Không thể kết nối tới Telegram API: ${err.message || err}`;
      this.stats.last_error = msg;
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (res.status === 429 || data.error_code === 429) {
      const retryAfter = (data.parameters && Number(data.parameters.retry_after)) || 30;
      this.rateLimitedUntil = Date.now() + retryAfter * 1000;
      const errMsg = `Telegram Rate Limit (HTTP 429): Vui lòng thử lại sau ${retryAfter}s`;
      this.stats.last_error = errMsg;
      const err = new Error(errMsg);
      err.status = 429;
      err.retry_after = retryAfter;
      throw err;
    }

    if (!res.ok || data.ok === false) {
      const desc = data.description || `HTTP ${res.status}`;
      const errMsg = `Lỗi từ Telegram API: ${desc}`;
      this.stats.last_error = errMsg;
      const err = new Error(errMsg);
      err.status = res.status || 400;
      throw err;
    }

    const now = Date.now();
    this._syncDay(now);
    this.stats.sent_today++;
    this.stats.total_sent++;
    this.stats.last_sent_at = now;
    this.stats.last_error = null;
    return data;
  }

  async sendTestMessage({ bot_token, chat_id, app_url, lang = 'vi', org_name = 'Monitoring' }) {
    const text = formatTelegramMessage(
      { kind: 'test', app_url, ts: Date.now() },
      { org_name, telegram: { app_url } },
      lang
    );
    const result = await this.sendRawMessage({ bot_token, chat_id, text });
    return { ok: true, text, telegram: result };
  }

  async notifyDeviceEvent(ctx, settings = {}, opts = {}) {
    const now = opts.now || Date.now();
    this._syncDay(now);

    const tg = (settings && settings.telegram) || {};
    const token = String(tg.bot_token || '').trim();
    const chatId = String(tg.chat_id || '').trim();
    if (!tg.enabled || !token || !chatId) {
      return { sent: false, reason: 'disabled_or_unconfigured' };
    }

    // Check per-device toggle
    if (ctx.telegram_enabled === false || ctx.telegram_enabled === 0) {
      return { sent: false, reason: 'device_muted' };
    }

    // Check event type checkboxes (supports both flat flags and nested events object)
    const evCfg = tg.events || {};
    const allowDown = tg.notify_down !== undefined ? !!tg.notify_down : (evCfg.down !== false);
    const allowRecovered = tg.notify_recovered !== undefined ? !!tg.notify_recovered : (evCfg.recovered !== false);
    const allowThreshold = tg.notify_threshold !== undefined ? !!tg.notify_threshold : (evCfg.threshold !== false);

    if (ctx.kind === 'down' && !allowDown) return { sent: false, reason: 'down_disabled' };
    if (ctx.kind === 'up' && !allowRecovered) return { sent: false, reason: 'recovered_disabled' };
    if (['warning', 'dos', 'thermal', 'smart', 'power'].includes(ctx.kind) && !allowThreshold) {
      return { sent: false, reason: 'threshold_disabled' };
    }

    // 1. Respect Telegram HTTP 429 retry_after backoff
    if (!opts.force && now < this.rateLimitedUntil) {
      this.stats.suppressed_today++;
      this.suppressedSinceLastSend++;
      return { sent: false, reason: 'rate_limited_backoff' };
    }

    // 2. Per-device + kind flapping debounce
    const cooldownSec = Number.isFinite(Number(tg.cooldown_seconds)) ? Math.max(0, Number(tg.cooldown_seconds)) : 30;
    const cooldownMs = cooldownSec * 1000;
    const devKey = `${ctx.device_id || 0}:${ctx.kind}`;
    if (!opts.force && cooldownMs > 0) {
      const lastDevTs = this.deviceCooldowns.get(devKey);
      if (lastDevTs != null && (now - lastDevTs) < cooldownMs) {
        this.stats.suppressed_today++;
        this.suppressedSinceLastSend++;
        return { sent: false, reason: 'device_flapping_debounced' };
      }
    }

    // 3. Global sliding window rate limit (60s) to prevent mass-outage spam / HTTP 429
    const maxPerMin = Number.isFinite(Number(tg.max_per_minute)) && Number(tg.max_per_minute) > 0
      ? Number(tg.max_per_minute)
      : 20;
    this.windowTimestamps = this.windowTimestamps.filter((ts) => now - ts < 60000);
    if (!opts.force && this.windowTimestamps.length >= maxPerMin) {
      this.stats.suppressed_today++;
      this.suppressedSinceLastSend++;
      return { sent: false, reason: 'global_rate_limit' };
    }

    // Record send timestamps before async dispatch to prevent concurrent race bursts
    this.deviceCooldowns.set(devKey, now);
    this.windowTimestamps.push(now);
    const suppressedBefore = this.suppressedSinceLastSend;
    this.suppressedSinceLastSend = 0;

    const lang = opts.lang || (settings && settings.default_lang) || 'vi';
    const text = formatTelegramMessage(
      { ...ctx, ts: now, suppressed_before: suppressedBefore },
      settings,
      lang
    );

    const result = await this.sendRawMessage({ bot_token: token, chat_id: chatId, text });
    return { sent: true, text, telegram: result };
  }
}

module.exports = {
  TelegramService,
  DEFAULT_TELEGRAM_SETTINGS,
  escapeHtml,
  formatTelegramMessage,
  resolveDeviceUrl,
};
