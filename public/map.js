'use strict';
// Topology maps: live status view + visual port matrix + smart wire routing editor.
(() => {
  const { esc, $, t } = M;
  const W = 1600, H = 900, NW = 180;
  const canEdit = () => M.S.user && M.S.user.role !== 'viewer';
  const COL = {
    critical: 'var(--c-critical)',
    high: 'var(--c-high)',
    medium: 'var(--c-medium)',
    low: 'var(--c-low)',
    up: 'var(--c-ok)',
    unknown: 'var(--c-unknown)',
    none: 'var(--muted)',
  };
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

  // Helper: Determine number of physical ports to render for a node
  function getNodePortCount(n, snap) {
    if (!n || n.kind !== 'device') return 0;
    const d = snap && snap.devices && snap.devices.find((x) => x.id === n.ref);
    if (!d) return 0;
    if (d.port_count !== undefined && d.port_count !== null && d.port_count > 0) return d.port_count;
    if (d.type === 'switch') return 24;
    if (['router', 'firewall'].includes(d.type)) return 8;
    return 0;
  }

  function getCardDims(portCount) {
    return { w: NW, h: portCount > 0 ? 92 : 60 };
  }

  // Calculate physical port layout (2 interleaved rows: top odd 1,3,5...; bottom even 2,4,6...)
  function getPortLayout(portCount) {
    const P = Math.min(128, Math.max(1, portCount));
    const cols = Math.ceil(P / 2);
    const availW = 164; // width inside NW (180px) with 8px margins
    const colPitch = availW / cols;
    const pw = Math.max(4, Math.min(12, colPitch - 2));
    const ph = 9;
    const leftMargin = 8 + (availW - cols * colPitch) / 2 + (colPitch - pw) / 2;
    return { P, cols, colPitch, pw, ph, leftMargin };
  }

  function getPortRect(idx, portCount) {
    const layout = getPortLayout(portCount);
    if (idx < 1 || idx > layout.P) return null;
    const isTop = idx % 2 !== 0;
    const col = Math.floor((idx - 1) / 2);
    const rx = layout.leftMargin + col * layout.colPitch;
    const ry = isTop ? 54 : 68;
    return { rx, ry, pw: layout.pw, ph: layout.ph, isTop, col };
  }

  // Calculate absolute center coords of a specific port on the map SVG
  function getPortCenter(n, portIdx, portCount) {
    const rect = getPortRect(portIdx, portCount);
    const dims = getCardDims(portCount);
    if (!rect) return { x: n.x, y: n.y };
    return {
      x: (n.x - dims.w / 2) + rect.rx + rect.pw / 2,
      y: (n.y - dims.h / 2) + rect.ry + rect.ph / 2,
    };
  }

  // Calculate cable endpoint: precise port center if port is specified & valid, else node center
  function getWireEndpoint(n, portVal, snap) {
    if (!n) return { x: 0, y: 0 };
    const pc = getNodePortCount(n, snap);
    if (pc > 0 && portVal) {
      const num = Number(portVal);
      if (Number.isInteger(num) && num >= 1 && num <= pc) {
        return getPortCenter(n, num, pc);
      }
    }
    return { x: n.x, y: n.y };
  }

  M.views.maps = {
    async render(el) {
      await M.loadMaps();
      el.innerHTML = `<div class="row"><h1>${t('Sơ đồ topology')}</h1><span class="spacer"></span>
        ${canEdit() ? `<button class="btn primary" id="mp-add">${t('+ Tạo sơ đồ')}</button>` : ''}</div>
        <div class="grid">${M.S.maps.map((m) => `<a class="tile up" href="#/map/${m.id}"><div class="t-top"><span class="t-ico">🗺️</span><span class="t-name">${esc(m.name)}</span></div></a>`).join('')
    || `<div class="muted">${t('Chưa có sơ đồ nào.')}</div>`}</div>`;
      const add = $('#mp-add');
      if (add) add.onclick = () => M.modal(t('Tạo sơ đồ'), `<div class="field"><label>${t('Tên sơ đồ')}</label><input class="inp" name="name" maxlength="80" required></div>`, async (f) => {
        const r = await M.api('POST', '/api/maps', { name: new FormData(f).get('name'), nodes: [], links: [] });
        M.S.mapEdit = true;
        location.hash = `#/map/${r.id}`;
      }, { submit: t('Tạo') });
    },
  };

  const uid = () => `n${Math.random().toString(36).slice(2, 10)}`;

  M.views.map = {
    async render(el, id) {
      const m = await M.api('GET', `/api/maps/${id}`);
      this.m = m;
      this.edit = !!M.S.mapEdit && canEdit();
      M.S.mapEdit = false;
      this.sel = null;
      this.linkMode = false;
      this.linkFrom = null;
      this.pendingPort = null;
      this.wireDrag = null;
      this.drag = null;
      this.dirty = false;
      el.innerHTML = `<div class="row" style="margin-bottom:10px"><h1 style="margin:0" id="mp-title"></h1><span class="spacer"></span><div id="mp-tools" class="row"></div></div>
        <div class="map-box" id="mp-box"><svg id="mp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"></svg></div>`;
      this.bind();
      this.tools();
      this.draw();
    },
    destroy() { this.m = null; },
    update() { if (this.m && !this.drag && !this.wireDrag) this.draw(); },

    tools() {
      const m = this.m;
      $('#mp-title').textContent = `🗺️ ${m.name}`;
      const tl = $('#mp-tools');
      if (!canEdit()) { tl.innerHTML = ''; return; }
      if (!this.edit) {
        tl.innerHTML = `<button class="btn" id="mp-edit">${t('✏️ Chỉnh sửa')}</button>`;
        $('#mp-edit').onclick = () => { this.edit = true; this.tools(); this.draw(); };
        return;
      }
      const onMap = new Set(m.nodes.filter((n) => n.kind === 'device').map((n) => n.ref));
      const gOn = new Set(m.nodes.filter((n) => n.kind === 'group').map((n) => n.ref));
      const devOpts = M.S.snap ? M.S.snap.devices.filter((d) => !onMap.has(d.id)).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('') : '';
      const grpOpts = M.S.groups.filter((g) => !gOn.has(g.id)).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');

      const isLinkSel = this.sel && this.sel.type === 'link';
      const isNodeSel = this.sel && this.sel.type === 'node';
      const selNode = isNodeSel ? m.nodes.find((x) => x.id === this.sel.id) : null;
      const isDevSel = selNode && selNode.kind === 'device';

      tl.innerHTML = `<select class="sel" id="mp-dev"><option value="">${t('+ Thiết bị…')}</option>${devOpts}</select>
        <select class="sel" id="mp-grp"><option value="">${t('+ Nhóm…')}</option>${grpOpts}</select>
        <button class="btn" id="mp-lbl">${t('+ Nhãn')}</button>
        <button class="btn ${this.linkMode ? 'primary' : ''}" id="mp-link">${t('🔗 Nối dây')}</button>
        ${isLinkSel ? `<button class="btn primary" id="mp-cfg-link">${t('🔌 Đổi cổng nối')}</button>` : ''}
        ${isDevSel ? `<button class="btn" id="mp-dev-ports">${t('🔌 Số cổng')}</button>` : ''}
        <button class="btn" id="mp-ren">${t('Đổi tên')}</button>
        <button class="btn danger" id="mp-del">${t('Xóa mục chọn')}</button>
        <button class="btn primary" id="mp-save">${t('💾 Lưu')}</button><button class="btn" id="mp-cancel">${t('Đóng')}</button>
        <button class="btn danger" id="mp-rm">${t('Xóa sơ đồ')}</button>`;

      const add = (node) => {
        m.nodes.push({ id: uid(), x: 200 + (m.nodes.length % 8) * 40, y: 120 + (m.nodes.length % 8) * 40, ...node });
        this.dirty = true;
        this.tools();
        this.draw();
      };
      $('#mp-dev').onchange = (e) => { if (e.target.value) add({ kind: 'device', ref: Number(e.target.value), label: '' }); };
      $('#mp-grp').onchange = (e) => { if (e.target.value) add({ kind: 'group', ref: Number(e.target.value), label: '' }); };
      $('#mp-lbl').onclick = () => add({ kind: 'label', ref: null, label: t('Nhãn mới') });
      $('#mp-link').onclick = () => {
        this.linkMode = !this.linkMode;
        this.linkFrom = null;
        this.pendingPort = null;
        this.tools();
        this.draw();
        if (this.linkMode) M.toast(t('Bấm lần lượt 2 cổng hoặc 2 thiết bị để nối dây'));
      };

      const cfgLinkBtn = $('#mp-cfg-link');
      if (cfgLinkBtn) cfgLinkBtn.onclick = () => { if (this.sel && this.sel.type === 'link') this.openLinkConfigModal(this.sel.index); };

      const devPortsBtn = $('#mp-dev-ports');
      if (devPortsBtn) devPortsBtn.onclick = () => { if (selNode) this.openDevicePortsModal(selNode); };

      $('#mp-ren').onclick = () => {
        const n = this.sel && this.sel.type === 'node' && m.nodes.find((x) => x.id === this.sel.id);
        if (!n || n.kind !== 'label') return M.toast(t('Chọn một nhãn để đổi tên'));
        M.modal(t('Đổi tên nhãn'), `<div class="field"><input class="inp" name="l" maxlength="80" value="${esc(n.label)}" required></div>`, (f) => {
          n.label = new FormData(f).get('l');
          this.dirty = true;
          this.draw();
        });
      };

      $('#mp-del').onclick = () => {
        if (!this.sel) return M.toast(t('Chưa chọn mục nào'));
        if (this.sel.type === 'node') {
          m.nodes = m.nodes.filter((n) => n.id !== this.sel.id);
          m.links = m.links.filter((l) => l.from !== this.sel.id && l.to !== this.sel.id);
        } else m.links.splice(this.sel.index, 1);
        this.sel = null;
        this.pendingPort = null;
        this.dirty = true;
        this.tools();
        this.draw();
      };

      $('#mp-save').onclick = async () => {
        await M.api('PUT', `/api/maps/${m.id}`, { name: m.name, nodes: m.nodes, links: m.links });
        this.dirty = false;
        M.toast(t('Đã lưu sơ đồ'));
      };

      $('#mp-cancel').onclick = async () => {
        const go = async () => {
          this.m = await M.api('GET', `/api/maps/${m.id}`);
          this.edit = false;
          this.sel = null;
          this.linkMode = false;
          this.pendingPort = null;
          this.tools();
          this.draw();
        };
        if (this.dirty) M.confirm(t('Bỏ các thay đổi chưa lưu?'), go); else go();
      };

      $('#mp-rm').onclick = () => M.confirm(M.S.lang === 'en' ? `Delete map "${m.name}"?` : `Xóa sơ đồ "${m.name}"?`, async () => {
        await M.api('DELETE', `/api/maps/${m.id}`);
        location.hash = '#/maps';
      });
    },

    // Modal to configure physical ports connected on both ends of a cable
    openLinkConfigModal(linkIndex) {
      const l = this.m.links[linkIndex];
      if (!l) return;
      const nodes = new Map(this.m.nodes.map((n) => [n.id, n]));
      const nodeA = nodes.get(l.from);
      const nodeB = nodes.get(l.to);
      if (!nodeA || !nodeB) return;
      const snap = M.S.snap;
      const infoA = this.info(nodeA);
      const infoB = this.info(nodeB);
      const pcA = getNodePortCount(nodeA, snap);
      const pcB = getNodePortCount(nodeB, snap);

      const makePortOptions = (count, current) => {
        let h = `<option value="">${t('(Không gán cổng / Tự động)')}</option>`;
        for (let i = 1; i <= count; i++) {
          h += `<option value="${i}" ${String(current) === String(i) ? 'selected' : ''}>${t('Cổng')} ${i} (Port ${i})</option>`;
        }
        return h;
      };

      const bodyHtml = `
        <div style="margin-bottom:12px;font-size:13px" class="muted">
          ${t('Cấu hình cổng vật lý kết nối giữa 2 thiết bị. Đường dây cáp sẽ bắt đầu chính xác từ ô cổng nguồn đến ô cổng đích.')}
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${esc(infoA.name)} (${esc(infoA.sub || infoA.cls)})</label>
            ${pcA > 0
              ? `<select class="sel inp" name="from_port" style="width:100%">${makePortOptions(pcA, l.from_port)}</select>`
              : `<input class="inp" name="from_port" placeholder="${t('Tên cổng tùy chọn (vd: eth0)')}" value="${esc(l.from_port || '')}">`}
          </div>
          <div class="field">
            <label>${esc(infoB.name)} (${esc(infoB.sub || infoB.cls)})</label>
            ${pcB > 0
              ? `<select class="sel inp" name="to_port" style="width:100%">${makePortOptions(pcB, l.to_port)}</select>`
              : `<input class="inp" name="to_port" placeholder="${t('Tên cổng tùy chọn (vd: eth0)')}" value="${esc(l.to_port || '')}">`}
          </div>
        </div>
      `;

      M.modal(t('🔌 Cấu hình cổng liên kết'), bodyHtml, (f) => {
        const fd = new FormData(f);
        const fp = String(fd.get('from_port') || '').trim();
        const tp = String(fd.get('to_port') || '').trim();
        l.from_port = fp || null;
        l.to_port = tp || null;
        this.dirty = true;
        this.draw();
        M.toast(t('Đã cập nhật cổng kết nối'));
      }, { submit: t('Lưu cổng') });
    },

    // Modal to configure device physical port count
    openDevicePortsModal(node) {
      if (node.kind !== 'device') return;
      const snap = M.S.snap;
      const d = snap && snap.devices && snap.devices.find((x) => x.id === node.ref);
      if (!d) return;
      const curCount = getNodePortCount(node, snap);

      const bodyHtml = `
        <div style="margin-bottom:12px;font-size:13px" class="muted">
          ${t('Cấu hình số cổng vật lý hiển thị trực tiếp trên thẻ thiết bị (Switch: 24/48 port, Router: 4/8 port, Firewall: 8 port).')}
        </div>
        <div class="field">
          <label>${t('Số cổng vật lý (Port Matrix Count)')}</label>
          <input class="inp" name="pc" type="number" min="0" max="128" value="${curCount || (d.type === 'switch' ? 24 : 8)}" required>
          <small class="muted" style="display:block;margin-top:4px">${t('Nhập 0 nếu muốn ẩn ma trận cổng trên thẻ thiết bị này.')}</small>
        </div>
      `;

      M.modal(t(`🔌 Cấu hình số cổng: ${d.name}`), bodyHtml, async (f) => {
        const fd = new FormData(f);
        const count = Number(fd.get('pc'));
        if (!Number.isInteger(count) || count < 0 || count > 128) return M.toast(t('Số cổng không hợp lệ (0-128)'));
        await M.api('PUT', `/api/devices/${d.id}`, { port_count: count });
        d.port_count = count;
        this.dirty = true;
        this.draw();
        M.toast(t('Đã lưu cấu hình số cổng'));
      }, { submit: t('Cập nhật') });
    },

    // Resolve a node to display info + status class from live data
    info(n) {
      const snap = M.S.snap;
      if (n.kind === 'label') return { name: n.label, sub: '', cls: 'label', rank: 'unknown', icon: '' };
      if (n.kind === 'device') {
        const d = snap && snap.devices && snap.devices.find((x) => x.id === n.ref);
        if (!d) return { name: t('(đã xóa)'), sub: '', cls: '', rank: 'unknown', icon: '❓' };
        return {
          name: d.name,
          sub: M.STATE_NAME[d.status] || d.status,
          cls: M.statusClass(d),
          icon: M.ICON[d.type] || '',
          rank: d.status === 'down' ? d.severity : d.status === 'warning' ? 'medium' : d.status === 'up' ? 'up' : 'unknown',
          href: `#/device/${d.id}`,
        };
      }
      const g = M.S.groups && M.S.groups.find((x) => x.id === n.ref);
      if (!g) return { name: t('(đã xóa)'), sub: '', cls: '', rank: 'unknown', icon: '❓' };
      const list = snap && snap.devices ? snap.devices.filter((d) => d.groups && d.groups.includes(g.id)) : [];
      const s = M.summarize(list);
      const downs = list.filter((d) => d.status === 'down');
      const worst = downs.reduce((a, d) => (SEV_RANK[d.severity] > SEV_RANK[a] ? d.severity : a), 'low');
      const cls = downs.length ? `down sev-${worst}` : s.warning ? 'warning' : s.total && s.unknown < s.total ? 'up' : '';
      return {
        name: g.name,
        sub: M.S.lang === 'en' ? `${s.alive}/${s.total} online` : `${s.alive}/${s.total} hoạt động`,
        cls,
        icon: '🗂️',
        rank: downs.length ? worst : s.warning ? 'medium' : cls === 'up' ? 'up' : 'unknown',
        href: `#/group/${g.id}`,
      };
    },

    draw() {
      const svg = $('#mp-svg');
      if (!svg || !this.m) return;
      const m = this.m;
      const snap = M.S.snap;
      const nodes = new Map(m.nodes.map((n) => [n.id, n]));
      const infos = new Map(m.nodes.map((n) => [n.id, this.info(n)]));
      $('#mp-box').classList.toggle('editing', this.edit);
      const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);

      // Render Links with Precise Port Wire Routing
      const links = m.links.map((l, i) => {
        const a = nodes.get(l.from), b = nodes.get(l.to);
        if (!a || !b) return '';
        const ia = infos.get(a.id), ib = infos.get(b.id);
        const r = score(ia ? ia.rank : 'unknown') >= score(ib ? ib.rank : 'unknown') ? (ia ? ia.rank : 'unknown') : (ib ? ib.rank : 'unknown');
        const bad = SEV_RANK[r];
        const sel = this.sel && this.sel.type === 'link' && this.sel.index === i;

        // Calculate cable endpoints from precise physical port coords
        const ptA = getWireEndpoint(a, l.from_port, snap);
        const ptB = getWireEndpoint(b, l.to_port, snap);

        return `<line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r]}${sel ? ';stroke-width:7;filter:drop-shadow(0 0 5px var(--accent))' : ''}" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}"/>
          ${this.edit ? `<line data-link="${i}" stroke="transparent" stroke-width="20" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}" style="cursor:pointer"/>` : ''}`;
      }).join('');

      // Temporary drag line when user drags cable from port
      let dragLine = '';
      if (this.wireDrag && this.edit) {
        const fromNode = nodes.get(this.wireDrag.fromNodeId);
        const startPt = getWireEndpoint(fromNode, this.wireDrag.fromPort, snap);
        dragLine = `<line class="m-wire-drag" x1="${startPt.x}" y1="${startPt.y}" x2="${this.wireDrag.curX}" y2="${this.wireDrag.curY}"/>`;
      }

      const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

      // Render Node Cards with Physical Port Grid
      const nodeSvg = m.nodes.map((n) => {
        const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
        const sel = (this.sel && this.sel.type === 'node' && this.sel.id === n.id) || this.linkFrom === n.id;

        if (n.kind === 'label') {
          return `<g class="m-node m-label ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
            <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
        }

        const pc = getNodePortCount(n, snap);
        const dims = getCardDims(pc);

        let portGridHtml = '';
        if (pc > 0) {
          const ports = [];
          for (let pIdx = 1; pIdx <= pc; pIdx++) {
            const pRect = getPortRect(pIdx, pc);
            if (!pRect) continue;

            // Find link connected to this port
            const connLink = m.links.find((l) => (l.from === n.id && String(l.from_port) === String(pIdx)) || (l.to === n.id && String(l.to_port) === String(pIdx)));

            let portCls = 'm-port-unused';
            let tooltip = `${t('Cổng')}: Port ${pIdx}\n${t('Trạng thái')}: ${t('Trống (Unused)')}`;

            if (connLink) {
              const otherNodeId = connLink.from === n.id ? connLink.to : connLink.from;
              const otherPort = connLink.from === n.id ? connLink.to_port : connLink.from_port;
              const otherInfo = infos.get(otherNodeId);
              const otherRank = otherInfo ? otherInfo.rank : 'unknown';

              const isDown = i.cls.includes('down') || (otherInfo && otherInfo.cls.includes('down')) || SEV_RANK[otherRank] >= 3;
              const isWarning = i.cls.includes('warning') || (otherInfo && otherInfo.cls.includes('warning')) || SEV_RANK[otherRank] === 2;

              if (isDown) {
                portCls = 'm-port-down';
              } else if (isWarning) {
                portCls = 'm-port-warning';
              } else {
                portCls = 'm-port-up';
              }

              const statusLabel = portCls === 'm-port-up' ? t('Hoạt động (UP)') : portCls === 'm-port-down' ? t('Mất kết nối (DOWN)') : t('Cảnh báo (WARNING)');
              tooltip = `${t('Cổng')}: Port ${pIdx} [${statusLabel}]\n${t('Kết nối')}: ${otherInfo ? otherInfo.name : otherNodeId}${otherPort ? ` [Port ${otherPort}]` : ''}`;
            }

            const isPendingSource = this.pendingPort && this.pendingPort.nodeId === n.id && String(this.pendingPort.port) === String(pIdx);

            ports.push(`
              <rect class="m-port ${portCls} ${isPendingSource ? 'sel-port' : ''}"
                    x="${pRect.rx}" y="${pRect.ry}" width="${pRect.pw}" height="${pRect.ph}"
                    rx="1.5"
                    data-port-node="${n.id}" data-port="${pIdx}">
                <title>${esc(tooltip)}</title>
              </rect>
            `);
          }

          portGridHtml = `
            <line x1="8" y1="49" x2="${dims.w - 8}" y2="49" stroke="var(--border)" stroke-width="1" stroke-opacity="0.4"/>
            <g class="m-port-grid">${ports.join('')}</g>
          `;
        }

        return `<g class="m-node ${i.cls} ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - dims.w / 2},${n.y - dims.h / 2})">
          <rect width="${dims.w}" height="${dims.h}" rx="10"/>
          <text x="12" y="27" font-size="22">${i.icon}</text>
          <text x="42" y="26" font-size="15" font-weight="700">${esc(trunc(i.name, 17))}</text>
          <text class="m-sub" x="42" y="${pc > 0 ? 43 : 46}">${esc(i.sub)}</text>
          ${portGridHtml}
        </g>`;
      }).join('');

      svg.innerHTML = links + dragLine + nodeSvg;
    },

    bind() {
      const svg = $('#mp-svg');
      const pt = (e) => {
        const p = svg.createSVGPoint();
        p.x = e.clientX; p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return { x: q.x, y: q.y };
      };

      svg.addEventListener('pointerdown', (e) => {
        if (!this.m) return;
        const portEl = e.target.closest('[data-port]');
        const g = e.target.closest('[data-id]');
        const lk = e.target.closest('[data-link]');

        if (!this.edit) return;

        // Click or Drag from a specific physical port
        if (portEl) {
          const targetNodeId = portEl.dataset.portNode;
          const targetPort = portEl.dataset.port;
          const p = pt(e);

          if (this.pendingPort) {
            if (this.pendingPort.nodeId === targetNodeId && this.pendingPort.port === targetPort) {
              this.pendingPort = null;
            } else if (this.pendingPort.nodeId === targetNodeId) {
              this.pendingPort = { nodeId: targetNodeId, port: targetPort };
            } else {
              // Create port-to-port cable connection!
              const fromN = this.pendingPort.nodeId;
              const fromP = this.pendingPort.port;
              this.m.links.push({
                from: fromN,
                to: targetNodeId,
                from_port: String(fromP),
                to_port: String(targetPort),
              });
              this.dirty = true;
              this.pendingPort = null;
              this.linkMode = false;
              M.toast(t('Đã kết nối cáp cổng-tới-cổng thành công!'));
            }
          } else {
            // Start drag wire or select source port
            this.pendingPort = { nodeId: targetNodeId, port: targetPort };
            this.wireDrag = { fromNodeId: targetNodeId, fromPort: targetPort, curX: p.x, curY: p.y };
            svg.setPointerCapture(e.pointerId);
          }
          this.tools();
          this.draw();
          return;
        }

        // Click on a node body
        if (g) {
          const n = this.m.nodes.find((x) => x.id === g.dataset.id);
          if (!n) return;

          if (this.pendingPort) {
            // Cable from pending port to this entire node
            if (this.pendingPort.nodeId !== n.id) {
              this.m.links.push({
                from: this.pendingPort.nodeId,
                to: n.id,
                from_port: String(this.pendingPort.port),
                to_port: null,
              });
              this.dirty = true;
              this.pendingPort = null;
              this.linkMode = false;
              M.toast(t('Đã kết nối cáp từ cổng vào thiết bị!'));
            } else {
              this.pendingPort = null;
            }
            this.tools();
            this.draw();
            return;
          }

          if (this.linkMode) {
            if (!this.linkFrom) this.linkFrom = n.id;
            else if (this.linkFrom !== n.id) {
              const dup = this.m.links.some((l) => (l.from === this.linkFrom && l.to === n.id) || (l.from === n.id && l.to === this.linkFrom));
              if (!dup) {
                this.m.links.push({ from: this.linkFrom, to: n.id, from_port: null, to_port: null });
                this.dirty = true;
              }
              this.linkFrom = null;
            }
          } else {
            this.sel = { type: 'node', id: n.id };
            const p = pt(e);
            this.drag = { n, dx: n.x - p.x, dy: n.y - p.y };
            svg.setPointerCapture(e.pointerId);
          }
        } else if (lk) {
          this.sel = { type: 'link', index: Number(lk.dataset.link) };
          this.pendingPort = null;
        } else {
          this.sel = null;
          this.linkFrom = null;
          this.pendingPort = null;
        }
        this.tools();
        this.draw();
      });

      svg.addEventListener('pointermove', (e) => {
        const p = pt(e);
        if (this.wireDrag) {
          this.wireDrag.curX = p.x;
          this.wireDrag.curY = p.y;
          this.draw();
          return;
        }
        if (!this.drag) return;
        const pc = getNodePortCount(this.drag.n, M.S.snap);
        const dims = getCardDims(pc);
        this.drag.n.x = Math.round(Math.min(W - dims.w / 2, Math.max(dims.w / 2, p.x + this.drag.dx)) / 10) * 10;
        this.drag.n.y = Math.round(Math.min(H - dims.h / 2, Math.max(dims.h / 2, p.y + this.drag.dy)) / 10) * 10;
        this.dirty = true;
        this.draw();
      });

      const end = (e) => {
        if (this.wireDrag) {
          const fromNodeId = this.wireDrag.fromNodeId;
          const fromPort = this.wireDrag.fromPort;
          this.wireDrag = null;

          // Check if released over a target port or node
          const targetEl = document.elementFromPoint(e.clientX, e.clientY);
          const targetPortEl = targetEl ? targetEl.closest('[data-port]') : null;
          const targetNodeEl = targetEl ? targetEl.closest('[data-id]') : null;

          if (targetPortEl) {
            const targetNodeId = targetPortEl.dataset.portNode;
            const targetPort = targetPortEl.dataset.port;
            if (targetNodeId && targetNodeId !== fromNodeId) {
              this.m.links.push({
                from: fromNodeId,
                to: targetNodeId,
                from_port: String(fromPort),
                to_port: String(targetPort),
              });
              this.dirty = true;
              this.pendingPort = null;
              M.toast(t('Đã kéo nối dây cổng-tới-cổng thành công!'));
            }
          } else if (targetNodeEl) {
            const targetNodeId = targetNodeEl.dataset.id;
            if (targetNodeId && targetNodeId !== fromNodeId) {
              this.m.links.push({
                from: fromNodeId,
                to: targetNodeId,
                from_port: String(fromPort),
                to_port: null,
              });
              this.dirty = true;
              this.pendingPort = null;
              M.toast(t('Đã kéo nối dây từ cổng vào thiết bị!'));
            }
          }
          this.tools();
          this.draw();
        }
        this.drag = null;
      };

      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);

      // Double-click to configure wire ports or node port count
      svg.addEventListener('dblclick', (e) => {
        if (!this.edit || !this.m) return;
        const lk = e.target.closest('[data-link]');
        const g = e.target.closest('[data-id]');
        if (lk) {
          const idx = Number(lk.dataset.link);
          this.openLinkConfigModal(idx);
        } else if (g) {
          const n = this.m.nodes.find((x) => x.id === g.dataset.id);
          if (n && n.kind === 'device') {
            this.openDevicePortsModal(n);
          }
        }
      });

      // Regular click to navigate in view mode
      svg.addEventListener('click', (e) => {
        if (this.edit || !this.m) return;
        const g = e.target.closest('[data-id]');
        if (!g) return;
        const n = this.m.nodes.find((x) => x.id === g.dataset.id);
        const i = n && this.info(n);
        if (i && i.href) location.hash = i.href;
      });
    },
  };

  // Reusable lightweight SVG map renderer (dashboard, secondary views)
  M.renderMapSvg = (svg, m) => {
    if (!svg || !m) return;
    const snap = M.S.snap;
    const nodes = new Map((m.nodes || []).map((n) => [n.id, n]));
    const infos = new Map((m.nodes || []).map((n) => [n.id, M.views.map.info(n)]));
    const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);

    const links = (m.links || []).map((l) => {
      const a = nodes.get(l.from), b = nodes.get(l.to);
      if (!a || !b) return '';
      const ia = infos.get(a.id), ib = infos.get(b.id);
      const r = score(ia ? ia.rank : 'unknown') >= score(ib ? ib.rank : 'unknown') ? (ia ? ia.rank : 'unknown') : (ib ? ib.rank : 'unknown');
      const bad = SEV_RANK[r];

      const ptA = getWireEndpoint(a, l.from_port, snap);
      const ptB = getWireEndpoint(b, l.to_port, snap);

      return `<line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r] || 'var(--c-ok)'}" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}"/>`;
    }).join('');

    const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
    const nodeSvg = (m.nodes || []).map((n) => {
      const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
      if (n.kind === 'label') {
        return `<g class="m-node m-label" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
          <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
      }

      const pc = getNodePortCount(n, snap);
      const dims = getCardDims(pc);

      let portGridHtml = '';
      if (pc > 0) {
        const ports = [];
        for (let pIdx = 1; pIdx <= pc; pIdx++) {
          const pRect = getPortRect(pIdx, pc);
          if (!pRect) continue;

          const connLink = (m.links || []).find((l) => (l.from === n.id && String(l.from_port) === String(pIdx)) || (l.to === n.id && String(l.to_port) === String(pIdx)));

          let portCls = 'm-port-unused';
          let tooltip = `Port ${pIdx} (Unused)`;

          if (connLink) {
            const otherNodeId = connLink.from === n.id ? connLink.to : connLink.from;
            const otherPort = connLink.from === n.id ? connLink.to_port : connLink.from_port;
            const otherInfo = infos.get(otherNodeId);
            const otherRank = otherInfo ? otherInfo.rank : 'unknown';

            const isDown = i.cls.includes('down') || (otherInfo && otherInfo.cls.includes('down')) || SEV_RANK[otherRank] >= 3;
            const isWarning = i.cls.includes('warning') || (otherInfo && otherInfo.cls.includes('warning')) || SEV_RANK[otherRank] === 2;

            portCls = isDown ? 'm-port-down' : isWarning ? 'm-port-warning' : 'm-port-up';
            tooltip = `Port ${pIdx} -> ${otherInfo ? otherInfo.name : otherNodeId}${otherPort ? ` [P${otherPort}]` : ''}`;
          }

          ports.push(`
            <rect class="m-port ${portCls}"
                  x="${pRect.rx}" y="${pRect.ry}" width="${pRect.pw}" height="${pRect.ph}"
                  rx="1.5">
              <title>${esc(tooltip)}</title>
            </rect>
          `);
        }

        portGridHtml = `
          <line x1="8" y1="49" x2="${dims.w - 8}" y2="49" stroke="var(--border)" stroke-width="1" stroke-opacity="0.4"/>
          <g class="m-port-grid">${ports.join('')}</g>
        `;
      }

      return `<g class="m-node ${i.cls}" data-id="${n.id}" data-href="${i.href || ''}" style="cursor:pointer" transform="translate(${n.x - dims.w / 2},${n.y - dims.h / 2})">
        <rect width="${dims.w}" height="${dims.h}" rx="10"/>
        <text x="12" y="27" font-size="22">${i.icon}</text>
        <text x="42" y="26" font-size="15" font-weight="700">${esc(trunc(i.name, 17))}</text>
        <text class="m-sub" x="42" y="${pc > 0 ? 43 : 46}">${esc(i.sub)}</text>
        ${portGridHtml}
      </g>`;
    }).join('');

    svg.innerHTML = links + nodeSvg;
  };
})();
