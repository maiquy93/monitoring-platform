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

  // ---------- device editor ----------
  M.editDevice = async (id) => {
    const d = id ? await M.api('GET', `/api/devices/${id}`) : { name: '', type: 'server', address: '', check_icmp: true, check_agent: false, snmp_enabled: false, snmp_port: 161, severity_override: '', location: '', notes: '', maintenance: false, mute_local_alerts: false, groups: [] };
    if (!M.S.groups.length) await M.loadGroups();
    if (!M.profiles) M.profiles = await M.api('GET', '/api/snmp/profiles').then((r) => r.profiles).catch(() => []);
    const def = M.S.settings.type_severity;
    const { form } = M.modal(id ? (M.S.lang === 'en' ? `Edit device: ${d.name}` : `Sửa thiết bị: ${d.name}`) : t('Thêm thiết bị'), `
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
      <div class="row" style="margin-top:6px">
        ${chk('maintenance', t('Chế độ bảo trì (tắt cảnh báo)'), d.maintenance)}
        ${chk('mute_local_alerts', t('Tắt cảnh báo trên thẻ thiết bị (Ẩn huy hiệu local)'), d.mute_local_alerts)}
      </div>
      ${id ? `<div class="field" style="margin-top:10px"><button type="button" class="btn danger" id="f-del">${t('Xóa thiết bị')}</button></div>` : ''}`,
    async (f) => {
      const fd = new FormData(f);
      const body = {
        name: fd.get('name'), type: fd.get('type'), address: fd.get('address'), severity: fd.get('severity') || null,
        location: fd.get('location'), notes: fd.get('notes'), snmp_community: fd.get('snmp_community'), snmp_port: Number(fd.get('snmp_port')), snmp_profile: fd.get('snmp_profile') || '',
        check_icmp: f.check_icmp.checked, check_agent: f.check_agent.checked, snmp_enabled: f.snmp_enabled.checked,
        maintenance: f.maintenance.checked, mute_local_alerts: f.mute_local_alerts.checked, groups: fd.getAll('grp').map(Number),
      };
      if (id) await M.api('PUT', `/api/devices/${id}`, body); else await M.api('POST', '/api/devices', body);
      await M.loadGroups();
      M.toast(t('Đã lưu thiết bị'));
      if (M.current === M.views.devices) M.views.devices.paint();
    });
    $('#f-type', form).onchange = (e) => { $('#f-sev', form).options[0].text = byTypeLabel(def[e.target.value]); };
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
