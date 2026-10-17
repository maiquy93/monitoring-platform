'use strict';
// Admin screens: device list/editor, group editor, settings, users.
(() => {
  const { esc, $, t } = M;
  const isAdmin = () => M.S.user.role === 'admin';
  const sevOptions = (sel, withDefault) => `${withDefault ? `<option value="">${withDefault}</option>` : ''}${Object.entries(M.SEV_NAME)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('')}`;
  const typeOptions = (sel) => Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  const chk = (name, label, on) => `<div class="field inline"><input type="checkbox" name="${name}" id="f-${name}" ${on ? 'checked' : ''}><label for="f-${name}">${label}</label></div>`;
  const randKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const byTypeLabel = (sevKey) => (M.S.lang === 'en' ? `By device type (${M.SEV_NAME[sevKey]})` : `Theo loại thiết bị (${M.SEV_NAME[sevKey]})`);

  M.isTelegramConfigured = () => {
    const s = M.S.settings || {};
    if (s.telegram_configured) return true;
    const tg = s.telegram || {};
    return Boolean(tg.enabled && (tg.bot_token || tg.has_bot_token) && tg.chat_id);
  };

  M.showTelegramUnconfiguredPopup = () => {
    const isEn = M.S.lang === 'en';
    const existing = document.getElementById('tg-warn-popup');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'tg-warn-popup';
    wrap.className = 'tg-popup-overlay';
    wrap.innerHTML = `
      <div class="tg-popup-card" role="dialog" aria-modal="true">
        <h3>⚠️ ${isEn ? 'Telegram Bot API Not Configured' : 'Chưa cấu hình kết nối Telegram Bot API'}</h3>
        <p>${isEn
          ? 'The system has not been connected to a Telegram Bot API or the Telegram alert channel is currently disabled in <b>General Settings</b>.'
          : 'Hệ thống chưa có kết nối API Telegram hoặc chưa cấu hình <b>Bot Token / Chat ID</b> tại mục Cài đặt chung.'}</p>
        <p class="muted">${isEn
          ? 'Please configure your Bot Token, Chat ID / Group ID, and enable Telegram notifications in <b>Settings → Notifications &amp; Alerts</b> first.'
          : 'Vui lòng vào <b>Cài đặt → Thông báo &amp; Cảnh báo (Alert Channels)</b> để nhập Bot Token, Chat ID và bật kênh thông báo trước khi kích hoạt cảnh báo cho thiết bị.'}</p>
        <div class="tg-popup-actions">
          <button type="button" class="btn" id="tg-popup-close">${isEn ? 'Close' : 'Đóng'}</button>
          ${isAdmin() ? `<button type="button" class="btn primary" id="tg-popup-goto">⚙️ ${isEn ? 'Go to Telegram Settings' : 'Đi tới Cài đặt Telegram'}</button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    const closePopup = () => wrap.remove();
    $('#tg-popup-close', wrap).onclick = closePopup;
    wrap.onclick = (e) => { if (e.target === wrap) closePopup(); };
    const gotoBtn = $('#tg-popup-goto', wrap);
    if (gotoBtn) {
      gotoBtn.onclick = () => {
        closePopup();
        M.closeModal();
        location.hash = '#/settings';
        setTimeout(() => {
          const panel = document.getElementById('st-telegram-panel');
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
      };
    }
  };

  // ---------- device editor ----------
  M.editDevice = async (id) => {
    const d = id ? await M.api('GET', `/api/devices/${id}`) : { name: '', type: 'server', address: '', check_icmp: true, check_agent: false, snmp_enabled: false, snmp_port: 161, severity_override: '', location: '', notes: '', maintenance: false, mute_local_alerts: false, telegram_enabled: true, groups: [] };
    if (!M.S.groups.length) await M.loadGroups();
    if (!M.profiles) M.profiles = await M.api('GET', '/api/snmp/profiles').then((r) => r.profiles).catch(() => []);
    const def = M.S.settings.type_severity;
    const tgConfigured = M.isTelegramConfigured();
    const tgChecked = d.telegram_enabled !== false && tgConfigured;
    const isEn = M.S.lang === 'en';
    const { form } = M.modal(id ? (isEn ? `Edit device: ${d.name}` : `Sửa thiết bị: ${d.name}`) : t('Thêm thiết bị'), `
      <div class="field-grid">
        <div class="field"><label>${t('Tên thiết bị *')}</label><input class="inp" name="name" maxlength="100" required value="${esc(d.name)}"></div>
        <div class="field"><label>${t('Loại')}</label><select class="sel inp" name="type" id="f-type">${typeOptions(d.type)}</select></div>
        <div class="field"><label>${t('IP / hostname')}</label><input class="inp" name="address" placeholder="192.168.1.10" value="${esc(d.address)}"></div>
        <div class="field"><label>${t('Mức cảnh báo khi mất kết nối')}</label><select class="sel inp" name="severity" id="f-sev">${sevOptions(d.severity_override, byTypeLabel(def[d.type]))}</select></div>
        <div class="field"><label>${t('Vị trí')}</label><input class="inp" name="location" maxlength="200" value="${esc(d.location)}"></div>
        <div class="field"><label>${t('Ghi chú')}</label><input class="inp" name="notes" maxlength="500" value="${esc(d.notes)}"></div>
      </div>
      <div class="row">${chk('check_icmp', t('Kiểm tra ICMP ping'), d.check_icmp)}${chk('check_agent', t('Có cài Agent'), d.check_agent)}${chk('snmp_enabled', t('Giám sát SNMP'), d.snmp_enabled)}</div>
      <div class="field-grid" id="snmp-box" style="margin-top:4px">
        <div class="field"><label>SNMP community (v2c)</label><input class="inp" name="snmp_community" value="${esc(d.snmp_community || 'public')}"></div>
        <div class="field"><label>SNMP port</label><input class="inp" name="snmp_port" type="number" min="1" max="65535" value="${d.snmp_port || 161}"></div>
        <div class="field full" style="grid-column:1 / -1"><label>${t('Hồ sơ SNMP')}</label><select class="sel inp" style="width:100%" name="snmp_profile"><option value="">${t('Tự nhận diện (khuyến nghị)')}</option>${(M.profiles || []).map((p) => `<option value="${esc(p.id)}" ${p.id === d.snmp_profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>${t('Thuộc nhóm')}</label><div class="row">${M.S.groups.map((g) => `<span class="field inline"><input type="checkbox" name="grp" value="${g.id}" id="g${g.id}" ${d.groups.includes(g.id) ? 'checked' : ''}><label for="g${g.id}">${esc(g.name)}</label></span>`).join('') || `<span class="muted">${t('Chưa có nhóm')}</span>`}</div></div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap">
        ${chk('maintenance', t('Chế độ bảo trì (tắt cảnh báo)'), d.maintenance)}
        ${chk('mute_local_alerts', t('Tắt cảnh báo trên thẻ thiết bị (Ẩn huy hiệu local)'), d.mute_local_alerts)}
        ${chk('telegram_enabled', isEn ? '🔔 Send Telegram alerts (Offline / Recovered / Threshold)' : '🔔 Cảnh báo qua Telegram Bot (Báo khi Mất kết nối & ONLINE trở lại)', tgChecked)}
      </div>
      ${id ? `<div class="field" style="margin-top:10px"><button type="button" class="btn danger" id="f-del">${t('Xóa thiết bị')}</button></div>` : ''}`,
    async (f) => {
      const fd = new FormData(f);
      const body = {
        name: fd.get('name'), type: fd.get('type'), address: fd.get('address'), severity: fd.get('severity') || null,
        location: fd.get('location'), notes: fd.get('notes'), snmp_community: fd.get('snmp_community'), snmp_port: Number(fd.get('snmp_port')), snmp_profile: fd.get('snmp_profile') || '',
        check_icmp: f.check_icmp.checked, check_agent: f.check_agent.checked, snmp_enabled: f.snmp_enabled.checked,
        maintenance: f.maintenance.checked, mute_local_alerts: f.mute_local_alerts.checked,
        telegram_enabled: f.telegram_enabled ? f.telegram_enabled.checked : true,
        groups: fd.getAll('grp').map(Number),
      };
      if (id) await M.api('PUT', `/api/devices/${id}`, body); else await M.api('POST', '/api/devices', body);
      await M.loadGroups();
      M.toast(t('Đã lưu thiết bị'));
      if (M.current === M.views.devices) M.views.devices.paint();
    });
    const tgChk = $('#f-telegram_enabled', form);
    if (tgChk) {
      tgChk.onchange = () => {
        if (tgChk.checked && !M.isTelegramConfigured()) {
          tgChk.checked = false;
          M.showTelegramUnconfiguredPopup();
        }
      };
    }
    $('#f-type', form).onchange = (e) => {
      const tp = e.target.value;
      $('#f-sev', form).options[0].text = byTypeLabel(def[tp]);
      if (!id && ['switch', 'router', 'ap', 'printer', 'nas'].includes(tp)) {
        form.snmp_enabled.checked = true;
      }
    };
    const snmpBox = $('#snmp-box', form);
    if (snmpBox) {
      snmpBox.addEventListener('input', () => { form.snmp_enabled.checked = true; });
      snmpBox.addEventListener('change', () => { form.snmp_enabled.checked = true; });
    }
    const del = $('#f-del', form);
    if (del) del.onclick = () => M.confirm(M.S.lang === 'en' ? `Delete device "${d.name}" and all its history?` : `Xóa thiết bị "${d.name}" cùng toàn bộ lịch sử?`, async () => {
      await M.api('DELETE', `/api/devices/${id}`);
      M.closeModal();
      if (M.current === M.views.devices) M.views.devices.paint();
      else location.hash = '#/devices';
    });
  };

  // ---------- group editor ----------
  M.editGroup = (g) => {
    const members = new Set(g ? g.device_ids : []);
    const { form } = M.modal(g ? t('Sửa nhóm') : t('Thêm nhóm'), `
      <div class="field"><label>${t('Tên nhóm *')}</label><input class="inp" name="name" maxlength="80" required value="${esc(g ? g.name : '')}"></div>
      <div class="field"><label>${t('Mô tả')}</label><input class="inp" name="description" maxlength="300" value="${esc(g ? g.description : '')}"></div>
      <div class="field"><label>${t('Thiết bị trong nhóm')}</label><div style="max-height:240px;overflow:auto" class="panel">
      ${(M.S.snap ? M.S.snap.devices : []).map((d) => `<div class="field inline" style="margin:4px 0"><input type="checkbox" name="dev" value="${d.id}" id="d${d.id}" ${members.has(d.id) ? 'checked' : ''}><label for="d${d.id}">${M.ICON[d.type] || ''} ${esc(d.name)}</label></div>`).join('') || `<span class="muted">${t('Chưa có thiết bị')}</span>`}</div></div>
      ${g ? `<button type="button" class="btn danger" id="g-del">${t('Xóa nhóm')}</button>` : ''}`,
    async (f) => {
      const fd = new FormData(f);
      const body = { name: fd.get('name'), description: fd.get('description'), device_ids: fd.getAll('dev').map(Number) };
      if (g) await M.api('PUT', `/api/groups/${g.id}`, body); else await M.api('POST', '/api/groups', body);
      await M.loadGroups();
      M.toast(t('Đã lưu nhóm'));
      M.route();
    });
    const del = $('#g-del', form);
    if (del) del.onclick = () => M.confirm(M.S.lang === 'en' ? `Delete group "${g.name}"? (devices will not be deleted)` : `Xóa nhóm "${g.name}"? (thiết bị không bị xóa)`, async () => {
      await M.api('DELETE', `/api/groups/${g.id}`);
      await M.loadGroups();
      M.closeModal();
      location.hash = '#/groups';
    });
  };

  // ---------- devices page ----------
  M.views.devices = {
    q: '',
    render(el) {
      el.innerHTML = `<div class="row"><h1>${t('Thiết bị')}</h1><span class="spacer"></span>
        <input class="inp" id="dl-q" placeholder="${t('Tìm…')}" style="width:200px" value="${esc(this.q)}">
        ${isAdmin() ? `<button class="btn" id="dl-install">${t('+ Thêm máy mới')}</button><button class="btn primary" id="dl-add">${t('+ Thêm thiết bị')}</button>` : ''}</div>
        <div class="panel" style="overflow:auto"><table class="tbl"><thead><tr><th>${t('Trạng thái')}</th><th>${t('Tên')}</th><th>${t('Loại')}</th><th>${t('Địa chỉ')}</th><th>${t('Nhóm')}</th><th>${t('Mức cảnh báo')}</th><th>${t('Kiểm tra')}</th><th></th></tr></thead><tbody id="dl-body"></tbody></table></div>`;
      $('#dl-q').oninput = (e) => { this.q = e.target.value; this.paint(); };
      const add = $('#dl-add');
      if (add) add.onclick = () => M.editDevice(null);
      const install = $('#dl-install');
      if (install) install.onclick = () => M.showAgentInstall();
      $('#dl-body').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) M.editDevice(Number(b.dataset.edit)); };
    },
    update() { this.paint(); },
    paint() {
      const body = $('#dl-body');
      if (!body || !M.S.snap) return;
      const q = this.q.toLowerCase();
      const list = M.S.snap.devices.filter((d) => !q || (d.name + d.address + d.location).toLowerCase().includes(q));
      body.innerHTML = list.map((d) => `<tr><td><span class="dot ${M.statusClass(d).split(' ')[0] === 'down' ? `sev-${d.severity}` : M.statusClass(d)}"></span>${M.STATE_NAME[d.status]}</td>
        <td><a href="#/device/${d.id}">${M.ICON[d.type] || ''} ${esc(d.name)}</a></td><td>${M.TYPE_NAME[d.type]}</td><td>${esc(d.address)}</td>
        <td>${d.groups.map((id) => esc((M.S.groups.find((g) => g.id === id) || {}).name || '')).join(', ')}</td>
        <td><span class="sev-badge ${d.severity}">${M.SEV_NAME[d.severity]}</span></td>
        <td class="muted">${[d.checks.icmp && 'ICMP', d.checks.agent && 'Agent', d.checks.snmp && 'SNMP'].filter(Boolean).join(' · ')}</td>
        <td>${isAdmin() ? `<button class="btn sm" data-edit="${d.id}">${t('Sửa')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${t('Chưa có thiết bị')}</td></tr>`;
    },
  };

  M.showAgentInstall = () => {
    const key = M.S.settings && M.S.settings.enroll_key;
    const server = location.origin;
    if (!key) {
      M.modal(t('Cần tạo enroll key'), `<p>${t('Vào Cài đặt → Đăng ký agent tự động, tạo một khóa dài ít nhất 16 ký tự rồi lưu trước khi cài máy mới.')}</p>`, async () => {}, { submit: t('Đã hiểu') });
      return;
    }
    const commands = [
      ['Linux', `curl -fsSL ${server}/agent/install.sh | sudo bash -s -- --key ${key}`],
      ['macOS', `curl -fsSL ${server}/agent/install-macos.sh | sudo bash -s -- --key ${key}`],
      ['Windows PowerShell (Administrator)', `& ([scriptblock]::Create((Invoke-RestMethod ${server}/agent/install.ps1))) -Key '${key}' -Server '${server}'`],
    ];
    const html = `<p class="muted">${t('Chạy trên đúng máy cần giám sát. Linux/macOS sẽ hỏi enroll key; Windows dùng khóa trong lệnh bên dưới.')}</p>
      ${commands.map(([label, command], i) => `<div class="field"><label>${esc(label)}</label><div class="row"><code class="install-command" id="agent-cmd-${i}">${esc(command)}</code><button type="button" class="btn sm" data-copy-agent="${i}">${t('Sao chép')}</button></div></div>`).join('')}
      <p class="muted">${t('Sau khi cài, máy sẽ tự xuất hiện trong dashboard với loại Máy chủ hoặc Máy ảo tùy agent báo cáo.')}</p>`;
    M.modal(t('+ Thêm máy mới'), html, async () => {}, { submit: t('Đóng') });
    document.querySelectorAll('[data-copy-agent]').forEach((button) => {
      button.onclick = async () => {
        const text = document.querySelector(`#agent-cmd-${button.dataset.copyAgent}`).textContent;
        await navigator.clipboard.writeText(text);
        M.toast(t('Đã sao chép lệnh cài'));
      };
    });
  };

  // ---------- settings ----------
  M.views.settings = {
    async render(el) {
      const s = await M.api('GET', '/api/settings');
      M.S.settings = { ...M.S.settings, ...s };
      const tm = s.timing;
      const isEn = M.S.lang === 'en';
      el.innerHTML = `<h1>${t('Cài đặt')}</h1>
      <div class="panel"><h2 style="margin-top:0">${t('Chung')}</h2><form id="st-general" class="field-grid">
        <div class="field"><label>${t('Tên hệ thống')}</label><input class="inp" name="org" maxlength="60" value="${esc(s.org_name)}"></div>
        <div class="field"><label>${t('Giao diện mặc định')}</label><select class="sel inp" name="theme"><option value="neon">Neon</option><option value="dark">${t('Tối')}</option><option value="light">${t('Sáng')}</option></select></div>
        <div class="field"><label>${t('Ngôn ngữ mặc định')} / ${t('Ngôn ngữ hiển thị')}</label><select class="sel inp" name="lang"><option value="vi">🇻🇳 Tiếng Việt</option><option value="en">🇬🇧 English</option></select></div>
        <div style="display:flex;align-items:flex-end"><button class="btn primary">${t('Lưu')}</button></div></form></div>

      <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">${t('Mức cảnh báo mặc định theo loại thiết bị')}</h2>
        <p class="muted">${isEn
    ? `Determines alert color and urgency on disconnect: <span class="sev-badge critical">${t('Nghiêm trọng')}</span> red · <span class="sev-badge high">${t('Cao')}</span> orange · <span class="sev-badge medium">${t('Trung bình')}</span> yellow · <span class="sev-badge low">${t('Thấp')}</span> blue. Note: <span class="sev-badge critical">${t('Nghiêm trọng')}</span> and <span class="sev-badge high">${t('Cao')}</span> trigger a continuous alarm bell until acknowledged.`
    : 'Quyết định màu và độ khẩn cấp khi thiết bị mất kết nối: <span class="sev-badge critical">Nghiêm trọng</span> đỏ · <span class="sev-badge high">Cao</span> cam · <span class="sev-badge medium">Trung bình</span> vàng · <span class="sev-badge low">Thấp</span> xanh dương. Với mức <span class="sev-badge critical">Nghiêm trọng</span> và <span class="sev-badge high">Cao</span>, chuông cảnh báo sẽ kêu liên tục cho đến khi bấm "Đã biết". Từng thiết bị vẫn có thể ghi đè riêng.'}</p>
        <form id="st-sev"><div class="field-grid">${s.types.map((k) => `<div class="field"><label>${M.ICON[k]} ${M.TYPE_NAME[k]}</label><select class="sel inp" name="${k}">${sevOptions(s.type_severity[k])}</select></div>`).join('')}</div>
        <button class="btn primary">${t('Lưu mức cảnh báo')}</button></form></div>

      <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">${t('Ngưỡng tài nguyên & phát hiện mất kết nối')}</h2>
        <form id="st-th" class="field-grid">
          ${['cpu', 'ram', 'disk'].map((k) => `<div class="field"><label>${isEn ? `${k.toUpperCase()} warning threshold (%) – sustained over 15s` : `Cảnh báo ${k.toUpperCase()} từ (%) – kéo dài trên 15 giây`}</label><input class="inp" type="number" min="1" max="100" name="${k}" value="${s.thresholds[k] || 90}"></div>`).join('')}
          <div class="field"><label>${t('Báo động quá nhiệt CPU (°C)')}</label><input class="inp" type="number" min="30" max="120" name="temp" value="${s.thresholds.temp || 85}"></div>
          <div class="field"><label>${t('Cảnh báo DoS / Flood (gói tin/giây)')}</label><input class="inp" type="number" min="100" max="1000000" name="dos_packet_rate" value="${s.thresholds.dos_packet_rate || 10000}"></div>
          <div><button class="btn primary">${t('Lưu ngưỡng')}</button></div></form>
        <p class="muted">${isEn
    ? `Disconnected: ICMP ping fails ${tm.ping_fail_limit} consecutive times (interval ${tm.ping_interval_ms / 1000}s, detected in ~${Math.round(tm.ping_interval_ms * tm.ping_fail_limit / 1000)}–${Math.round((tm.ping_interval_ms * tm.ping_fail_limit + 1000) / 1000)}s) or agent stops reporting for over ${tm.agent_timeout_ms / 1000}s. Multi-check devices are marked down only when all enabled checks fail. Timing parameters are configured via environment variables (see README).`
    : `Mất kết nối: ICMP ping không phản hồi ${tm.ping_fail_limit} lần liên tiếp (chu kỳ ${tm.ping_interval_ms / 1000}s, phát hiện sau khoảng ${Math.round(tm.ping_interval_ms * tm.ping_fail_limit / 1000)}–${Math.round((tm.ping_interval_ms * tm.ping_fail_limit + 1000) / 1000)}s) hoặc agent không gửi dữ liệu quá ${tm.agent_timeout_ms / 1000}s. Thiết bị có nhiều kiểu kiểm tra chỉ bị coi là mất kết nối khi tất cả đều thất bại. Các giá trị này cấu hình qua biến môi trường (xem README).`}</p></div>

      <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">${t('Đăng ký agent tự động')}</h2>
        <p class="muted">${t('Agent mới có thể tự tạo thiết bị khi gửi dữ liệu kèm khóa này (token = enroll key). Để trống để tắt. Tối thiểu 16 ký tự.')}</p>
        <form id="st-enroll" class="row"><input class="inp" name="key" style="flex:1" value="${esc(s.enroll_key || '')}" placeholder="${t('(đang tắt)')}">
          <button type="button" class="btn" id="st-gen">${t('Tạo ngẫu nhiên')}</button><button class="btn primary">${t('Lưu')}</button></form></div>

      ${this.telegramPanel(s)}

      ${this.aiPanel(s)}

      <div class="panel" style="margin-top:14px"><h2 style="margin-top:0">${t('Hệ thống')}</h2>${this.systemPanel(s)}</div>

      <div class="panel" style="margin-top:14px"><div class="row"><h2 style="margin:0">${t('Người dùng')}</h2><span class="spacer"></span><button class="btn primary" id="us-add">${t('+ Thêm')}</button></div>
        <table class="tbl"><thead><tr><th>${t('Tên đăng nhập')}</th><th>${t('Vai trò')}</th><th></th></tr></thead><tbody id="us-body"></tbody></table>
        <p class="muted">${t('Admin: toàn quyền · Operator: xác nhận cảnh báo, chỉnh sơ đồ · Viewer: chỉ xem.')}</p></div>`;
      $('select[name=theme]', el).value = s.default_theme;
      $('select[name=lang]', el).value = M.S.lang || s.default_lang || 'vi';
      const save = async (body, msg) => { await M.api('PUT', '/api/settings', body); M.S.settings = { ...M.S.settings, ...(await M.api('GET', '/api/settings')) }; M.toast(msg); };
      const guard = (fn) => async (e) => { e.preventDefault(); try { await fn(new FormData(e.target)); } catch (err) { M.toast(err.message); } };
      $('#st-general').onsubmit = guard(async (f) => {
        const chosenLang = f.get('lang') === 'en' ? 'en' : 'vi';
        await save({ org_name: f.get('org'), default_theme: f.get('theme'), default_lang: chosenLang }, chosenLang === 'en' ? 'Saved successfully' : 'Đã lưu');
        $('#brand').textContent = `◉ ${M.S.settings.org_name}`;
        if (chosenLang !== M.S.lang) {
          M.applyLang(chosenLang);
          M.api('PUT', '/api/auth/lang', { lang: chosenLang }).catch(() => {});
        }
      });
      $('#st-sev').onsubmit = guard((f) => save({ type_severity: Object.fromEntries(f) }, t('Đã lưu mức cảnh báo')));
      $('#st-th').onsubmit = guard((f) => save({ thresholds: Object.fromEntries([...f].map(([k, v]) => [k, Number(v)])) }, t('Đã lưu ngưỡng')));
      $('#st-enroll').onsubmit = guard((f) => save({ enroll_key: f.get('key') }, t('Đã lưu enroll key')));
      $('#st-gen').onclick = () => { $('#st-enroll input').value = randKey(); };
      this.bindTelegramPanel(el, s, save, guard);
      this.bindAiPanel(el, s, save, guard);
      $('#us-add').onclick = () => this.userForm();
      $('#us-body').onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const u = this.users.find((x) => x.id === Number(b.dataset.id));
        if (b.dataset.act === 'pw') this.userForm(u);
        else M.confirm(M.S.lang === 'en' ? `Delete user "${u.username}"?` : `Xóa người dùng "${u.username}"?`, async () => { await M.api('DELETE', `/api/users/${u.id}`); this.loadUsers(); });
      };
      this.loadUsers();
    },
    telegramPanel(s) {
      const tg = s.telegram || {};
      const st = tg.stats || {};
      const isEn = M.S.lang === 'en';
      const isActive = Boolean(tg.enabled && (tg.bot_token || tg.has_bot_token) && tg.chat_id);
      const defaultAppUrl = tg.app_url || (typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost:8080');
      return `<div class="panel" id="st-telegram-panel" style="margin-top:14px">
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">🔔 ${isEn ? 'Notifications & Alert Channels — Telegram Bot' : 'Thông báo & Cảnh báo (Alert Channels) — Telegram Bot'}</h2>
          <span class="spacer"></span>
          <span class="ai-badge ${isActive ? '' : 'cached'}">${isActive
            ? (isEn ? '🟢 Telegram Active & Connected' : '🟢 Đang bật cảnh báo Telegram')
            : (isEn ? '⚪ Telegram Disabled / Unconfigured' : '⚪ Đang tắt hoặc chưa cấu hình')}</span>
        </div>
        <p class="muted" style="margin:6px 0 12px">${isEn
          ? 'Automatically pushes real-time HTML notifications (🚨 Offline, ✅ Recovered, ⚠️ High CPU/RAM Threshold) to your Telegram chat or NOC group with built-in anti-spam & flapping protection.'
          : 'Tự động đẩy tin nhắn cảnh báo định dạng HTML trực quan (🚨 Mất kết nối, ✅ Phục hồi ONLINE trở lại, ⚠️ Cảnh báo ngưỡng CPU/RAM cao) vào nhóm trực NOC qua Telegram Bot kèm cơ chế chống Spam / Flapping.'}</p>

        <div class="ai-stats-bar" style="margin-bottom:12px">
          <div class="stat">${isEn ? 'Messages Sent Today' : 'Tin nhắn đã gửi hôm nay'}: <b>${st.sent_today || 0}</b></div>
          <div class="stat">${isEn ? 'Total Sent' : 'Tổng tin đã gửi'}: <b>${st.total_sent || 0}</b></div>
          <div class="stat">${isEn ? 'Anti-Spam Coalesced Today' : 'Đã chặn Spam/Flapping hôm nay'}: <b>${st.suppressed_today || 0}</b></div>
        </div>

        <form id="st-telegram">
          <div class="row" style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:var(--panel2);border:1px solid var(--border)">
            <label class="toggle-switch" for="f-tg_enabled">
              <input type="checkbox" name="telegram_enabled" id="f-tg_enabled" ${tg.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
              <span>${isEn ? 'Enable Telegram Bot Notifications' : 'Bật tính năng thông báo cảnh báo qua Telegram Bot'}</span>
            </label>
          </div>

          <div class="field-grid">
            <div class="field">
              <label>${isEn ? 'Bot Token (from @BotFather)' : 'Bot Token (Lấy từ @BotFather)'} ${tg.has_bot_token ? `<span class="ai-badge" style="margin-left:4px">${isEn ? 'Saved' : 'Đã lưu'}</span>` : ''}</label>
              <div class="inp-with-action">
                <input class="inp" type="password" name="bot_token" id="tg-bot-token" autocomplete="new-password" value="${esc(tg.bot_token || '')}" placeholder="${isEn ? 'Paste your bot token here...' : 'Dán mã Bot Token vào đây...'}">
                <button type="button" class="btn-eye" id="btn-tg-eye" title="${isEn ? 'Show / Hide Bot Token' : 'Hiện / Ẩn Bot Token'}" aria-label="Toggle Bot Token visibility">👁️</button>
              </div>
              <span class="muted" style="font-size:11.5px;display:block;margin-top:4px">${isEn
                ? 'Format: <code>123456789:ABCdefGHIjklMNO...</code> (Chat with @BotFather → /newbot)'
                : 'Định dạng chuẩn: <code>123456789:ABCdefGHIjklMNO...</code> (Tạo bot qua @BotFather → /newbot)'}</span>
            </div>

            <div class="field">
              <label>${isEn ? 'Chat ID / Group ID' : 'Chat ID / Group ID (ID cá nhân hoặc Nhóm NOC)'}</label>
              <input class="inp" type="text" name="chat_id" id="tg-chat-id" value="${esc(tg.chat_id || '')}" placeholder="-1001987654321 hoặc 987654321">
              <span class="muted" style="font-size:11.5px;display:block;margin-top:4px">${isEn
                ? '💡 Note: Group IDs start with a minus sign (e.g. <code>-100123456789</code>). Add your bot to the group, send a message, or use <code>@userinfobot</code> / <code>/getUpdates</code> to get the ID.'
                : '💡 Ghi chú: ID nhóm (Group/Supergroup) bắt đầu bằng dấu trừ <code>-</code> hoặc <code>-100...</code>. Hãy thêm Bot vào nhóm, gõ 1 tin nhắn bất kỳ rồi lấy ID qua <code>@userinfobot</code> hoặc nút Hướng dẫn bên dưới.'}</span>
            </div>

            <div class="field">
              <label>${isEn ? 'Dashboard Base URL (for direct device link in message)' : 'Địa chỉ Web hệ thống (Link mở nhanh thiết bị trong tin nhắn)'}</label>
              <input class="inp" type="text" name="app_url" id="tg-app-url" value="${esc(defaultAppUrl)}" placeholder="http://192.168.1.10:8080">
            </div>

            <div class="field">
              <label>${isEn ? 'Anti-Spam / Flapping Debounce Cooldown (seconds)' : 'Thời gian chống Spam / Flapping trên mỗi thiết bị (giây)'}</label>
              <input class="inp" type="number" min="0" max="3600" name="cooldown_seconds" id="tg-cooldown" value="${tg.cooldown_seconds != null ? tg.cooldown_seconds : 30}">
            </div>
          </div>

          <div class="field" style="margin-top:10px">
            <label>${isEn ? 'Incident Types to Notify' : 'Loại sự cố cần gửi thông báo'}</label>
            <div class="tg-check-grid">
              <label class="tg-check-card" for="f-tg_notify_down">
                <input type="checkbox" name="notify_down" id="f-tg_notify_down" ${tg.notify_down !== false ? 'checked' : ''}>
                <span>
                  <span class="tg-chk-title">🚨 ${isEn ? 'Disconnected / Offline' : 'Mất kết nối / Offline'}</span>
                  <span class="tg-chk-desc">${isEn ? 'Alert immediately when a device stops responding to Ping/SNMP/Agent' : 'Báo ngay khi thiết bị mất kết nối Ping / SNMP / Agent'}</span>
                </span>
              </label>

              <label class="tg-check-card" for="f-tg_notify_recovered">
                <input type="checkbox" name="notify_recovered" id="f-tg_notify_recovered" ${tg.notify_recovered !== false ? 'checked' : ''}>
                <span>
                  <span class="tg-chk-title">✅ ${isEn ? 'Recovered / Back Online' : 'Phục hồi / Recovered'}</span>
                  <span class="tg-chk-desc">${isEn ? 'Send recovery notice when device returns ONLINE after an outage' : 'Gửi tin báo phục hồi khi thiết bị ONLINE trở lại sau sự cố'}</span>
                </span>
              </label>

              <label class="tg-check-card" for="f-tg_notify_threshold">
                <input type="checkbox" name="notify_threshold" id="f-tg_notify_threshold" ${tg.notify_threshold !== false ? 'checked' : ''}>
                <span>
                  <span class="tg-chk-title">⚠️ ${isEn ? 'High CPU / RAM / Resource Threshold' : 'Cảnh báo ngưỡng CPU/RAM cao'}</span>
                  <span class="tg-chk-desc">${isEn ? 'Alert when CPU, RAM, Disk, Thermal or Flood/DoS exceeds threshold' : 'Báo khi CPU, RAM, Ổ đĩa, Nhiệt độ hoặc DoS vượt ngưỡng an toàn'}</span>
                </span>
              </label>
            </div>
          </div>

          <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
            <button class="btn primary" type="submit" id="btn-tg-save">💾 ${isEn ? 'Save Configuration' : 'Lưu cấu hình'}</button>
            <button class="btn" type="button" id="btn-tg-test">📨 ${isEn ? 'Send Test Message (Test Connection)' : 'Gửi tin thử nghiệm'}</button>
            <button class="btn" type="button" id="btn-tg-guide">📖 ${isEn ? 'Connection Guide' : 'Hướng dẫn kết nối'}</button>
          </div>
        </form>

        <div class="tg-guide-box hidden" id="tg-guide-box">
          <h4>📖 ${isEn ? 'Step-by-Step Guide: Connecting Telegram Bot for NOC Alerts' : 'Tài liệu hướng dẫn: Thiết lập Telegram Bot nhận cảnh báo sự cố NOC'}</h4>
          ${isEn ? `
          <ol>
            <li><b>Create a Bot &amp; get Bot Token:</b> Open Telegram, search for <code>@BotFather</code>, send <code>/newbot</code>, enter a display name and username (ending in <code>bot</code>). Copy the HTTP API <b>Bot Token</b> (e.g. <code>123456789:AAH...</code>) and paste it into the <b>Bot Token</b> field above.</li>
            <li><b>Get Personal Chat ID:</b> If you want alerts sent to you directly, open your new Bot and click <b>Start</b> (<code>/start</code>), then message <code>@userinfobot</code> to get your numeric <b>Id</b>.</li>
            <li><b>Get Group Chat ID (Recommended for NOC Teams):</b>
              <ul>
                <li>Add your Bot to your Telegram Group and send a test message like <code>/start@YourBotName hello</code> in the group.</li>
                <li>Open a browser tab and visit: <code>https://api.telegram.org/bot&lt;YOUR_BOT_TOKEN&gt;/getUpdates</code></li>
                <li>Look for <code>"chat":{"id":-1001234567890,"title":"NOC Alert Group"...}</code>. Copy that negative number (including the <code>-</code> sign) into <b>Chat ID / Group ID</b>.</li>
              </ul>
            </li>
            <li><b>Verify &amp; Save:</b> Click <b>"📨 Send Test Message"</b> to verify your phone/group receives the sample alert, then click <b>"💾 Save Configuration"</b>.</li>
            <li><b>Per-Device Control:</b> You can toggle Telegram alerts on/off for individual devices inside each Device Detail page (<code>#/device/:id</code>) or Edit Device modal.</li>
          </ol>` : `
          <ol>
            <li><b>Bước 1 — Tạo Bot &amp; lấy Bot Token:</b> Mở ứng dụng Telegram, tìm <code>@BotFather</code> (có tích xanh), gõ lệnh <code>/newbot</code> → Đặt tên hiển thị và username cho Bot (kết thúc bằng chữ <code>bot</code>). Sao chép chuỗi <b>HTTP API Token</b> (dạng <code>123456789:AAH...</code>) dán vào ô <b>Bot Token</b> ở trên.</li>
            <li><b>Bước 2 — Lấy Chat ID cá nhân:</b> Nếu muốn nhận tin nhắn riêng, hãy bấm <b>Start</b> (<code>/start</code>) trong khung chat với Bot vừa tạo, sau đó nhắn tin cho <code>@userinfobot</code> để lấy mã <b>Id</b> dạng số.</li>
            <li><b>Bước 3 — Lấy Group ID cho nhóm trực NOC (Khuyến nghị):</b>
              <ul>
                <li>Thêm Bot vừa tạo vào nhóm Telegram trực hệ thống và gõ 1 tin nhắn bất kỳ trong nhóm (ví dụ: <code>/start</code>).</li>
                <li>Mở trình duyệt truy cập đường dẫn: <code>https://api.telegram.org/bot&lt;BOT_TOKEN_CỦA_BẠN&gt;/getUpdates</code></li>
                <li>Tìm đoạn <code>"chat":{"id":-1001234567890,"title":"Nhóm Trực NOC"...}</code>. Sao chép toàn bộ dãy số ID đó (bao gồm cả dấu trừ <code>-</code> ở đầu) dán vào ô <b>Chat ID / Group ID</b>.</li>
              </ul>
            </li>
            <li><b>Bước 4 — Kiểm tra &amp; Lưu cấu hình:</b> Nhấn nút <b>"📨 Gửi tin thử nghiệm"</b> để kiểm tra tin nhắn mẫu gửi về nhóm Telegram, sau đó bật công tắc thông báo và nhấn <b>"💾 Lưu cấu hình"</b>.</li>
            <li><b>Bước 5 — Bật/Tắt theo từng thiết bị:</b> Tại trang chi tiết từng thiết bị (<code>#/device/:id</code>) hoặc cửa sổ Sửa thiết bị, bạn có thể bật/tắt nhận cảnh báo Telegram riêng cho thiết bị đó (kể cả thông báo khi thiết bị <b>ONLINE trở lại</b> sau sự cố).</li>
          </ol>`}
        </div>
      </div>`;
    },
    bindTelegramPanel(el, s, save, guard) {
      const form = $('#st-telegram', el);
      if (!form) return;
      const tokenInp = $('#tg-bot-token', form);
      const eyeBtn = $('#btn-tg-eye', form);
      if (eyeBtn && tokenInp) {
        eyeBtn.onclick = () => {
          const isSecret = tokenInp.type === 'password';
          tokenInp.type = isSecret ? 'text' : 'password';
          eyeBtn.textContent = isSecret ? '🙈' : '👁️';
        };
      }
      const guideBtn = $('#btn-tg-guide', form);
      const guideBox = $('#tg-guide-box', el);
      if (guideBtn && guideBox) {
        guideBtn.onclick = () => {
          const hidden = guideBox.classList.toggle('hidden');
          guideBtn.classList.toggle('primary', !hidden);
          if (!hidden) guideBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        };
      }
      form.onsubmit = guard(async (fd) => {
        const isEn = M.S.lang === 'en';
        const enabled = $('#f-tg_enabled', form).checked;
        const botToken = (fd.get('bot_token') || '').trim();
        const chatId = (fd.get('chat_id') || '').trim();
        if (enabled && (!botToken && !(s.telegram && s.telegram.has_bot_token))) {
          throw new Error(isEn ? 'Please enter a Telegram Bot Token before enabling notifications' : 'Vui lòng nhập Bot Token trước khi bật thông báo Telegram');
        }
        if (enabled && !chatId) {
          throw new Error(isEn ? 'Please enter a Chat ID / Group ID before enabling notifications' : 'Vui lòng nhập Chat ID / Group ID trước khi bật thông báo Telegram');
        }
        const tgBody = {
          enabled,
          bot_token: botToken,
          allow_empty_token: true,
          chat_id: chatId,
          app_url: (fd.get('app_url') || '').trim(),
          cooldown_seconds: Number(fd.get('cooldown_seconds') ?? 30),
          notify_down: $('#f-tg_notify_down', form).checked,
          notify_recovered: $('#f-tg_notify_recovered', form).checked,
          notify_threshold: $('#f-tg_notify_threshold', form).checked,
        };
        await M.api('PUT', '/api/alerts/telegram', { telegram: tgBody });
        M.S.settings = { ...M.S.settings, ...(await M.api('GET', '/api/settings')) };
        M.toast(isEn ? 'Telegram alert settings saved successfully!' : 'Đã lưu cấu hình cảnh báo Telegram thành công!');
        this.render(el);
      });
      const testBtn = $('#btn-tg-test', form);
      if (testBtn) {
        testBtn.onclick = async () => {
          const isEn = M.S.lang === 'en';
          const fd = new FormData(form);
          const botToken = (fd.get('bot_token') || '').trim();
          const chatId = (fd.get('chat_id') || '').trim();
          const appUrl = (fd.get('app_url') || '').trim();
          if (!botToken && !(s.telegram && s.telegram.has_bot_token)) {
            M.toast(isEn ? 'Please enter Bot Token first' : 'Vui lòng nhập Bot Token trước khi gửi thử nghiệm');
            if (tokenInp) tokenInp.focus();
            return;
          }
          if (!chatId) {
            M.toast(isEn ? 'Please enter Chat ID / Group ID first' : 'Vui lòng nhập Chat ID / Group ID trước khi gửi thử nghiệm');
            const chatInp = $('#tg-chat-id', form);
            if (chatInp) chatInp.focus();
            return;
          }
          const orig = testBtn.textContent;
          testBtn.disabled = true;
          testBtn.textContent = isEn ? '⏳ Sending test message...' : '⏳ Đang gửi tin thử nghiệm...';
          try {
            const res = await M.api('POST', '/api/alerts/test-telegram', {
              lang: M.S.lang || 'vi',
              telegram: {
                bot_token: botToken,
                chat_id: chatId,
                app_url: appUrl,
              },
            });
            M.toast(res.message || (isEn ? 'Test message sent to Telegram!' : 'Đã gửi tin nhắn thử nghiệm tới Telegram thành công!'));
          } catch (err) {
            M.toast(err.message);
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = orig;
          }
        };
      }
    },
    aiPanel(s) {
      const ai = s.ai || {};
      const presets = s.ai_presets || {};
      const st = s.ai_stats || {};
      const isEn = M.S.lang === 'en';
      const providerOpts = Object.entries(presets).map(([k, v]) => `<option value="${esc(k)}" ${ai.provider === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
      const keyPlaceholder = ai.has_api_key
        ? (isEn ? '•••••••• (Configured – leave blank to keep current token)' : '•••••••• (Đã lưu Token – để trống nếu giữ nguyên)')
        : (isEn ? 'sk-... / AIza... (leave blank if using local Ollama)' : 'sk-... / AIza... (để trống nếu dùng Ollama nội bộ)');
      return `<div class="panel" style="margin-top:14px">
        <div class="row">
          <h2 style="margin:0">🤖 ${isEn ? 'AI Incident Diagnosis & Predictive Analytics (Ultra Token-Saver)' : 'Tích hợp AI Chẩn đoán Sự cố & Dự đoán Xu hướng (Siêu tiết kiệm Token)'}</h2>
          <span class="spacer"></span>
          <span class="ai-badge ${ai.enabled ? '' : 'cached'}">${ai.enabled ? (isEn ? '🟢 AI API Active' : '🟢 Đang bật gọi API AI') : (isEn ? '⚪ AI API Disabled (Local Fallback)' : '⚪ Đang tắt gọi API AI (Dùng Chuyên gia Nội bộ 0-token)')}</span>
        </div>
        <p class="muted" style="margin:6px 0 10px">${isEn
    ? 'Automatically analyzes Critical & High severity incidents (Server down, Disk Bad Sector/SMART error, Disk > 90%, CPU/RAM > 90%, CPU Overheating, UPS Power Loss, Flood/DoS) and collects 24h logs at end-of-day using a compact unified JSON template synced to your display language (VI/EN).'
    : 'Tự động phân tích sự cố mức Nghiêm trọng (Critical) & Cao (High) (Máy chủ sập, Disk Bad Sector/SMART, Disk > 90%, CPU/RAM > 90%, Quá nhiệt, Mất điện UPS, DoS/Flood) và thu thập log cuối ngày theo bộ Template JSON thống nhất, tự động đồng bộ theo ngôn ngữ hiển thị (Tiếng Việt / English).'}</p>

        <div class="ai-stats-bar" style="margin-bottom:12px">
          <div class="stat">${isEn ? 'API Calls Today' : 'Lượt gọi API hôm nay'}: <b>${st.calls_today || 0} / ${ai.daily_call_limit || 50}</b></div>
          <div class="stat">${isEn ? 'Tokens Today' : 'Token tiêu thụ hôm nay'}: <b>${st.tokens_today || 0}</b></div>
          <div class="stat">${isEn ? 'Total Reports' : 'Tổng báo cáo AI'}: <b>${st.total_reports || 0}</b></div>
          <div class="stat">${isEn ? 'Zero-Token Cache Hits' : 'Tái sử dụng Cache (0 Token)'}: <b>${st.cached_hits || 0}</b></div>
        </div>

        <form id="st-ai">
          <div class="row" style="gap:18px;margin-bottom:10px;flex-wrap:wrap">
            ${chk('ai_enabled', isEn ? '<b>Enable AI API Calls</b> (Uncheck to disable all external AI API requests)' : '<b>Bật gọi API AI</b> (Bỏ chọn để tắt hoàn toàn việc gọi API AI ra ngoài)', ai.enabled)}
            ${chk('ai_auto_incident', isEn ? 'Auto-analyze High & Critical Incidents' : 'Tự động phân tích khi có sự cố Cao & Nghiêm trọng', ai.auto_incident !== false)}
            ${chk('ai_daily_digest', isEn ? 'Enable End-of-Day Log Collection & AI Digest (Zero agent changes)' : 'Bật thu thập Log cuối ngày & gửi AI phân tích (Không cần sửa Agent)', ai.daily_digest_enabled)}
          </div>

          <div class="field-grid">
            <div class="field">
              <label>${isEn ? 'AI Server / Provider Preset' : 'Nhà cung cấp Server AI (Preset)'}</label>
              <select class="sel inp" name="provider" id="ai-provider">${providerOpts}</select>
            </div>
            <div class="field">
              <label>${isEn ? 'AI API Endpoint URL (Chat Completions)' : 'Địa chỉ API Server AI (Endpoint URL)'}</label>
              <input class="inp" name="api_url" id="ai-url" required value="${esc(ai.api_url || '')}" placeholder="https://api.openai.com/v1/chat/completions">
            </div>
            <div class="field">
              <label>${isEn ? 'AI Model Name' : 'Tên Model AI'}</label>
              <input class="inp" name="model" id="ai-model" required value="${esc(ai.model || '')}" placeholder="gpt-4o-mini">
            </div>
            <div class="field">
              <label>${isEn ? 'API Token (Bearer Key)' : 'API Token (Khóa xác thực)'} ${ai.has_api_key ? `<span class="ai-badge" style="margin-left:4px">${isEn ? 'Saved' : 'Đã lưu'}</span>` : ''}</label>
              <div class="row" style="gap:6px">
                <input class="inp" type="password" name="api_key" id="ai-key" style="flex:1" autocomplete="new-password" placeholder="${esc(keyPlaceholder)}">
                ${ai.has_api_key ? `<label class="muted" style="font-size:11px;white-space:nowrap;display:flex;align-items:center;gap:4px"><input type="checkbox" name="clear_key" id="ai-clear-key"> ${isEn ? 'Clear key' : 'Xóa khóa'}</label>` : ''}
              </div>
            </div>
            <div class="field">
              <label>${isEn ? 'End-of-Day Digest Time (HH:MM)' : 'Giờ thu thập Log & báo cáo cuối ngày (HH:MM)'}</label>
              <input class="inp" name="daily_digest_time" pattern="^([01]\\d|2[0-3]):([0-5]\\d)$" value="${esc(ai.daily_digest_time || '23:50')}" placeholder="23:50">
            </div>
            <div class="field">
              <label>${isEn ? 'Duplicate Incident Cooldown (minutes, 0-token cache)' : 'Chu kỳ chống trùng lặp sự cố (phút, Cache 0-token)'}</label>
              <input class="inp" type="number" min="1" max="1440" name="cooldown_minutes" value="${ai.cooldown_minutes || 60}">
            </div>
            <div class="field">
              <label>${isEn ? 'Max AI API Calls / Day (Hard Cap)' : 'Giới hạn số lượt gọi API AI tối đa / ngày'}</label>
              <input class="inp" type="number" min="1" max="5000" name="daily_call_limit" value="${ai.daily_call_limit || 50}">
            </div>
            <div class="field">
              <label>${isEn ? 'Max Response Tokens / Call (max_tokens)' : 'Giới hạn Token phản hồi tối đa / lần gọi'}</label>
              <input class="inp" type="number" min="100" max="2000" name="max_tokens" value="${ai.max_tokens || 320}">
            </div>
          </div>

          <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
            <button class="btn primary" type="submit">${isEn ? '💾 Save AI Settings' : '💾 Lưu cấu hình AI'}</button>
            <button class="btn" type="button" id="btn-ai-test">${isEn ? '🧪 Test Connection & View Unified Template' : '🧪 Kiểm tra kết nối & Xem Template mẫu'}</button>
            <button class="btn" type="button" id="btn-ai-digest-now">${isEn ? '📊 Collect 24h Logs & Run Digest Now' : '📊 Thu thập Log 24h & Phân tích ngay'}</button>
          </div>
        </form>

        <details class="ai-doc-box">
          <summary>📖 ${isEn ? 'Documentation: AI Token Setup, Unified JSON Template & Token-Saving Architecture (Click to expand)' : 'Tài liệu hướng dẫn cấu hình AI, Chuẩn Template JSON & Cơ chế Siêu Tiết Kiệm Token (Nhấn để xem)'}</summary>
          ${isEn ? `
          <div style="margin-top:10px">
            <h4>1. Quick Provider & API Token Setup</h4>
            <ul>
              <li><b>OpenAI:</b> Create an API Key at <code>platform.openai.com/api-keys</code> → Choose preset <b>OpenAI</b> (Endpoint: <code>https://api.openai.com/v1/chat/completions</code>, Recommended ultra-cheap model: <code>gpt-4o-mini</code>).</li>
              <li><b>Google Gemini (OpenAI-Compatible):</b> Create a key at <code>aistudio.google.com</code> → Choose preset <b>Google Gemini</b> (Model: <code>gemini-3.8-flash</code> — fast & generous free tier).</li>
              <li><b>DeepSeek / Groq:</b> Choose preset <b>DeepSeek</b> (<code>deepseek-chat</code>) or <b>Groq</b> (<code>openai/gpt-oss-120b</code>) and paste your API key.</li>
              <li><b>Local Ollama (100% Free, Offline):</b> Install Ollama locally, run <code>ollama run qwen2.5:7b</code>, choose preset <b>Ollama (Local)</b>. No API token required!</li>
              <li><b>Disable AI Calls Anytime:</b> Uncheck <b>"Enable AI API Calls"</b> to immediately stop all external API requests. The platform still provides instant 0-token diagnostics via the built-in Local Expert Engine.</li>
            </ul>

            <h4>2. Unified Request & Response Template (Auto Language Sync: EN / VI)</h4>
            <p>When display language is set to <b>English</b>, the server sends an ultra-compact English prompt (~90–130 tokens) and enforces an English JSON response. When set to <b>Tiếng Việt</b>, both prompt and response are in Vietnamese:</p>
            <pre>// Compact Incident Payload sent to AI Server:
DEV:Core-DB(server,10.0.0.12)|SEV:critical|TYPE:disk|ISSUE:Disk 93% >= 90%|METRICS:CPU:42%,RAM:78%,Disk:93%|TREND_24H:CPU(avg:38%,max:75%);Disk(now:93%,+4.2%/d,full~1.7d)

// Mandatory Structured JSON returned by AI Server (parsed by Monitoring Server):
{
  "issue": "Summary of the core failure or bottleneck (1-2 sentences)",
  "cause": "Most likely root cause based on metrics & 24h trend",
  "solution": "Concrete step-by-step remediation commands/actions",
  "prediction": "Capacity & reliability forecast over the next 24-72h"
}</pre>

            <h4>3. End-of-Day Log Collection (Zero Agent Changes Required)</h4>
            <ul>
              <li><b>No OS Agent Modification:</b> The Monitoring Server already collects and stores all device events, SNMP traps, and 30-second resource metrics in its central SQLite database.</li>
              <li>At the configured time (e.g., <code>23:50</code>) or when clicking <b>"Collect 24h Logs & Run Digest Now"</b>, the server mathematically pre-aggregates 24h incident counts and computes linear regression disk/CPU trends on the server before sending a single ~180-token summary to the AI.</li>
            </ul>

            <h4>4. 5-Layer Token Saving Architecture (Saves 95%–98% Tokens)</h4>
            <ul>
              <li><b>Severity Gate:</b> Only triggers automatically for <b>Critical</b> & <b>High</b> incidents (Server down, Disk SMART/Bad Sector, Disk &gt; 90%, CPU/RAM &gt; 90%, Overheating, Power Loss, Flood/DoS). Minor/Low fluctuations are ignored.</li>
              <li><b>Fingerprint Deduplication Cache:</b> Identical incidents on the same device within the Cooldown window (default 60m) reuse the cached AI diagnosis for <b>0 tokens</b>.</li>
              <li><b>Server-Side Trend Math:</b> Instead of sending thousands of raw metric rows, the server calculates slope (<code>+%/day</code>, estimated days to 100% full) in ~15 tokens.</li>
              <li><b>Strict JSON Schema & <code>max_tokens</code> Cap:</b> Forces concise JSON output with <code>temperature: 0.1</code> and hard token ceiling.</li>
              <li><b>Daily Hard Quota:</b> Guarantees zero unexpected billing spikes during network storms.</li>
            </ul>
          </div>` : `
          <div style="margin-top:10px">
            <h4>1. Hướng dẫn lấy API Token & Cấu hình nhanh</h4>
            <ul>
              <li><b>OpenAI:</b> Tạo khóa tại <code>platform.openai.com/api-keys</code> → Chọn preset <b>OpenAI</b> (Endpoint: <code>https://api.openai.com/v1/chat/completions</code>, Model tiết kiệm khuyến nghị: <code>gpt-4o-mini</code>).</li>
              <li><b>Google Gemini:</b> Tạo khóa tại <code>aistudio.google.com</code> → Chọn preset <b>Google Gemini</b> (Model: <code>gemini-3.8-flash</code> — tốc độ cao, có gói miễn phí hào phóng).</li>
              <li><b>DeepSeek / Groq:</b> Chọn preset <b>DeepSeek</b> (<code>deepseek-chat</code>) hoặc <b>Groq</b> (<code>openai/gpt-oss-120b</code>) và dán API Token tương ứng.</li>
              <li><b>Ollama Nội bộ (Miễn phí 100%, Offline):</b> Cài Ollama trên máy chủ nội bộ, chạy <code>ollama run qwen2.5:7b</code>, chọn preset <b>Ollama (Local)</b> — không cần API Token.</li>
              <li><b>Tắt gọi API AI bất cứ lúc nào:</b> Bỏ tích <b>"Bật gọi API AI"</b> để ngắt hoàn toàn kết nối ra ngoài. Hệ thống sẽ tự động chuyển sang <b>Chuyên gia Nội bộ (0 Token)</b> để vẫn hiển thị nguyên nhân & hướng xử lý.</li>
            </ul>

            <h4>2. Chuẩn Template JSON Thống Nhất (Tự động đồng bộ Tiếng Việt / English)</h4>
            <p>Khi ngôn ngữ ứng dụng đang chọn <b>Tiếng Việt</b>, Server gửi ngữ cảnh nén gọn bằng yêu cầu Tiếng Việt (~90–130 tokens) và bắt buộc AI trả về JSON Tiếng Việt. Khi chuyển sang <b>English</b>, cả chiều gửi và chiều nhận tự động chuyển sang Tiếng Anh:</p>
            <pre>// Dữ liệu ngữ cảnh siêu nén Server gửi lên AI:
DEV:Core-DB(server,10.0.0.12)|SEV:critical|TYPE:disk|ISSUE:Ổ đĩa 93% >= 90%|METRICS:CPU:42%,RAM:78%,Disk:93%|TREND_24H:CPU(avg:38%,max:75%);Disk(now:93%,+4.2%/d,full~1.7d)

// Định dạng JSON chuẩn AI trả về để Server đọc và hiển thị:
{
  "issue": "Tóm tắt vấn đề cốt lõi (1-2 câu)",
  "cause": "Nguyên nhân gốc rễ khả dĩ nhất dựa trên số liệu & xu hướng 24h",
  "solution": "Các bước khắc phục cụ thể, lệnh kiểm tra đề xuất",
  "prediction": "Dự đoán rủi ro và dung lượng trong 24-72h tới"
}</pre>

            <h4>3. Tính năng Thu thập Log cuối ngày (Không cần sửa Agent hay cài thêm thư viện)</h4>
            <ul>
              <li><b>Không can thiệp OS Agent:</b> Toàn bộ log sự kiện, cảnh báo SNMP/DoS và chuỗi chỉ số CPU/RAM/Disk/Nhiệt độ/SMART đã được Server lưu sẵn trong cơ sở dữ liệu SQLite trung tâm.</li>
              <li>Vào đúng giờ cài đặt (mặc định <code>23:50</code>) hoặc khi bấm nút <b>"📊 Thu thập Log 24h & Phân tích ngay"</b>, Server tự động gom nhóm thống kê 24h và tính toán tốc độ tăng trưởng ổ đĩa/tài nguyên trước khi gửi bản tóm tắt siêu gọn (~180 tokens) cho AI phân tích toàn cảnh.</li>
            </ul>

            <h4>4. 5 Cơ chế Siêu Tiết Kiệm Token (Giảm 95%–98% chi phí Token)</h4>
            <ul>
              <li><b>Bộ lọc Mức cảnh báo (Severity Gate):</b> Chỉ tự động gọi AI với sự cố mức <b>Nghiêm trọng (Critical)</b> và <b>Cao (High)</b> (Máy chủ mất kết nối, Disk Bad Sector/SMART, Disk &gt; 90%, CPU/RAM &gt; 90%, Quá nhiệt CPU, Mất điện UPS, Tấn công DoS/Flood).</li>
              <li><b>Chống trùng lặp bằng Fingerprint Cache:</b> Sự cố lặp lại trên cùng thiết bị trong khung thời gian Cooldown (mặc định 60 phút) được lấy ngay từ Cache với <b>0 Token</b>.</li>
              <li><b>Tính toán Dự đoán Tuyến tính tại Server:</b> Server tự tính độ dốc tăng ổ đĩa (<code>+%/ngày</code>, dự kiến bao nhiêu ngày nữa đầy ổ) thành chuỗi 15 token thay vì gửi hàng ngàn dòng log thô.</li>
              <li><b>Ép chuẩn JSON ngắn gọn & trần <code>max_tokens</code>:</b> Không tốn token cho lời chào hỏi rườm rà.</li>
              <li><b>Giới hạn cứng số lượt gọi mỗi ngày (Daily Cap):</b> Bảo vệ tuyệt đối ngân sách API ngay cả khi mạng bị bão cảnh báo.</li>
            </ul>
          </div>`}
        </details>
      </div>`;
    },
    bindAiPanel(el, s, save, guard) {
      const presets = s.ai_presets || {};
      const provSel = $('#ai-provider', el);
      if (provSel) {
        provSel.onchange = () => {
          const p = presets[provSel.value];
          if (p && provSel.value !== 'custom') {
            if (p.api_url) $('#ai-url', el).value = p.api_url;
            if (p.model) $('#ai-model', el).value = p.model;
          }
        };
      }
      const form = $('#st-ai', el);
      if (form) {
        form.onsubmit = guard(async (fd) => {
          const isEn = M.S.lang === 'en';
          const clearKey = $('#ai-clear-key', form) && $('#ai-clear-key', form).checked;
          const typedKey = (fd.get('api_key') || '').trim();
          const aiBody = {
            enabled: $('#f-ai_enabled', form).checked,
            auto_incident: $('#f-ai_auto_incident', form).checked,
            daily_digest_enabled: $('#f-ai_daily_digest', form).checked,
            provider: fd.get('provider'),
            api_url: fd.get('api_url'),
            model: fd.get('model'),
            daily_digest_time: fd.get('daily_digest_time') || '23:50',
            cooldown_minutes: Number(fd.get('cooldown_minutes')) || 60,
            daily_call_limit: Number(fd.get('daily_call_limit')) || 50,
            max_tokens: Number(fd.get('max_tokens')) || 320,
          };
          if (clearKey) aiBody.api_key = '';
          else if (typedKey) aiBody.api_key = typedKey;
          await save({ ai: aiBody }, isEn ? 'AI settings saved' : 'Đã lưu cấu hình AI');
          this.render(el);
        });
      }
      const btnTest = $('#btn-ai-test', el);
      if (btnTest) {
        btnTest.onclick = async () => {
          const isEn = M.S.lang === 'en';
          const orig = btnTest.textContent;
          btnTest.disabled = true;
          btnTest.textContent = isEn ? '⏳ Testing...' : '⏳ Đang kiểm tra...';
          try {
            const fd = new FormData(form);
            const typedKey = (fd.get('api_key') || '').trim();
            const res = await M.api('POST', '/api/ai/test', {
              lang: M.S.lang || 'vi',
              ai: {
                enabled: $('#f-ai_enabled', form).checked,
                provider: fd.get('provider'),
                api_url: fd.get('api_url'),
                model: fd.get('model'),
                max_tokens: Number(fd.get('max_tokens')) || 320,
                ...(typedKey ? { api_key: typedKey } : {}),
              },
            });
            const p = res.parsed || {};
            M.modal(
              isEn ? '🧪 AI Connection & Unified Template Preview' : '🧪 Kết quả kiểm tra AI & Xem trước Template thống nhất',
              `<div class="row" style="margin-bottom:8px;gap:8px">
                <span class="ai-badge">${res.live_api_called ? (isEn ? '✅ Live AI Server Response' : '✅ Phản hồi trực tiếp từ Server AI') : (isEn ? '⚡ Local Expert Preview (AI API Disabled or No Key)' : '⚡ Chế độ Chuyên gia Nội bộ (Đang tắt API hoặc chưa nhập Token)')}</span>
                <span class="muted">${isEn ? 'Model' : 'Mô hình'}: <b>${esc(res.model)}</b> · Tokens: <b>${res.tokens_used || 0}</b> · Lang: <b>${esc((res.lang || '').toUpperCase())}</b></span>
              </div>
              ${res.api_error ? `<div class="panel" style="border-color:var(--down);margin-bottom:8px;color:var(--down)">⚠️ API Error: ${esc(res.api_error)}</div>` : ''}
              <div class="ai-card" style="margin-bottom:10px">
                <div class="ai-grid">
                  <div class="ai-box"><h5>⚠️ ${isEn ? 'Issue (Vấn đề)' : 'Vấn đề (Issue)'}</h5><p>${esc(p.issue || '—')}</p></div>
                  <div class="ai-box"><h5>🔍 ${isEn ? 'Root Cause (Nguyên nhân)' : 'Nguyên nhân (Cause)'}</h5><p>${esc(p.cause || '—')}</p></div>
                  <div class="ai-box"><h5>🛠️ ${isEn ? 'Solution (Đề xuất giải pháp)' : 'Đề xuất giải pháp (Solution)'}</h5><p>${esc(p.solution || '—')}</p></div>
                  <div class="ai-box"><h5>📈 ${isEn ? 'Prediction (Dự đoán)' : 'Dự đoán (Prediction)'}</h5><p>${esc(p.prediction || '—')}</p></div>
                </div>
              </div>
              <div class="field"><label>${isEn ? 'Unified Outbound Prompt Template (System + Compact User Context)' : 'Template gửi lên Server AI (System + Ngữ cảnh nén gọn)'}</label>
                <pre style="background:var(--bg);padding:8px;border-radius:6px;border:1px solid var(--border);font-size:11px;white-space:pre-wrap;max-height:160px;overflow:auto"><b>[SYSTEM]</b> ${esc(res.prompt_preview && res.prompt_preview.system)}\n\n<b>[USER]</b> ${esc(res.prompt_preview && res.prompt_preview.user)}</pre>
              </div>`,
              async () => {},
              { submit: t('Đóng') },
            );
          } catch (err) {
            M.toast(err.message);
          } finally {
            btnTest.disabled = false;
            btnTest.textContent = orig;
          }
        };
      }
      const btnDigest = $('#btn-ai-digest-now', el);
      if (btnDigest) {
        btnDigest.onclick = async () => {
          const isEn = M.S.lang === 'en';
          const orig = btnDigest.textContent;
          btnDigest.disabled = true;
          btnDigest.textContent = isEn ? '⏳ Analyzing 24h logs...' : '⏳ Đang phân tích log 24h...';
          try {
            await M.api('POST', '/api/ai/daily-digest', { lang: M.S.lang || 'vi' });
            M.toast(isEn ? 'End-of-day AI digest completed! Redirecting to AI Reports...' : 'Đã tạo báo cáo AI cuối ngày! Đang mở tab Báo cáo AI...');
            if (M.views.events) M.views.events.subTab = 'ai';
            location.hash = '#/events/ai';
          } catch (err) {
            M.toast(err.message);
          } finally {
            btnDigest.disabled = false;
            btnDigest.textContent = orig;
          }
        };
      }
    },
    systemPanel(s) {
      const v = s.version || {};
      const y = s.system || {};
      const fb = (n) => (n == null ? '—' : M.fmtBytes(n));
      const isEn = M.S.lang === 'en';
      const low = y.disk_low ? ` <span class="sev-badge critical">${t('Sắp đầy – đang tự dọn lịch sử')}</span>` : '';
      return `<dl class="kv">
        <dt>${t('Phiên bản')}</dt><dd>v${esc(v.version)} · build ${esc(v.build)} · ${isEn ? 'commit' : 'mã'} ${esc(v.code)}</dd>
        <dt>${t('Tính năng')}</dt><dd>${esc((v.features || []).join(', ') || '—')}</dd>
        <dt>${t('Khởi động lúc')}</dt><dd>${v.started_at ? new Date(v.started_at).toLocaleString(isEn ? 'en-US' : 'vi-VN') : '—'}</dd>
        <dt>Database</dt><dd>${fb(y.db_bytes)} (WAL ${fb(y.wal_bytes)}) · ${isEn ? `retention ${esc(y.retention_days)} days` : `giữ lịch sử ${esc(y.retention_days)} ngày`}</dd>
        <dt>${t('Ổ đĩa chứa database')}</dt><dd>${isEn ? 'free' : 'trống'} ${fb(y.disk_free_bytes)} / ${fb(y.disk_total_bytes)}${low}</dd></dl>`;
    },
    async loadUsers() {
      this.users = (await M.api('GET', '/api/users')).users;
      $('#us-body').innerHTML = this.users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>
        <button class="btn sm" data-act="pw" data-id="${u.id}">${t('Sửa / đặt lại mật khẩu')}</button>
        ${u.id !== M.S.user.id ? `<button class="btn sm danger" data-act="del" data-id="${u.id}">${t('Xóa')}</button>` : ''}</td></tr>`).join('');
    },
    userForm(u) {
      const isEn = M.S.lang === 'en';
      const roles = ['admin', 'operator', 'viewer'].map((r) => `<option ${u && u.role === r ? 'selected' : ''}>${r}</option>`).join('');
      M.modal(u ? (isEn ? `Edit ${u.username}` : `Sửa ${u.username}`) : t('Thêm người dùng'), `
        ${u ? '' : `<div class="field"><label>${t('Tên đăng nhập')}</label><input class="inp" name="username" required></div>`}
        <div class="field"><label>${t('Vai trò')}</label><select class="sel inp" name="role">${roles}</select></div>
        <div class="field"><label>${isEn
    ? `${u ? 'New password (leave blank to keep)' : 'Initial password'} – user must change on next login`
    : `${u ? 'Mật khẩu mới (để trống nếu không đổi)' : 'Mật khẩu ban đầu'} – người dùng sẽ phải đổi khi đăng nhập`}</label>
        <input class="inp" type="password" name="password" minlength="8" autocomplete="new-password" ${u ? '' : 'required'}></div>`,
      async (f) => {
        const v = Object.fromEntries(new FormData(f));
        if (u) await M.api('PUT', `/api/users/${u.id}`, { role: v.role, ...(v.password ? { password: v.password } : {}) });
        else await M.api('POST', '/api/users', v);
        this.loadUsers();
      });
    },
  };
})();
