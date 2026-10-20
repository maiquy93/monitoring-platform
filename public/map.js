'use strict';
// Topology maps: live status view + straight wire routing + active port badges + integrated Port Inspector.
(() => {
  const { esc, $, t } = M;
  const W = 1600, H = 900, NW = 180, NH = 62;
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

  // Calculate clean edge anchor endpoints between Node A and Node B so wires run straight
  function getEdgeEndpoints(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let ptA, ptB, sideA, sideB;

    if (Math.abs(dx) >= Math.abs(dy)) {
      // Horizontal dominant
      if (dx >= 0) {
        ptA = { x: a.x + NW / 2, y: a.y };
        ptB = { x: b.x - NW / 2, y: b.y };
        sideA = 'R'; sideB = 'L';
      } else {
        ptA = { x: a.x - NW / 2, y: a.y };
        ptB = { x: b.x + NW / 2, y: b.y };
        sideA = 'L'; sideB = 'R';
      }
    } else {
      // Vertical dominant
      if (dy >= 0) {
        ptA = { x: a.x, y: a.y + NH / 2 };
        ptB = { x: b.x, y: b.y - NH / 2 };
        sideA = 'B'; sideB = 'T';
      } else {
        ptA = { x: a.x, y: a.y - NH / 2 };
        ptB = { x: b.x, y: b.y + NH / 2 };
        sideA = 'T'; sideB = 'B';
      }
    }
    return { ptA, ptB, sideA, sideB };
  }

  // Calculate badge center position near the edge endpoint along the cable direction
  function getBadgeCoords(pt, side) {
    const offset = 18;
    switch (side) {
      case 'R': return { x: pt.x + offset, y: pt.y };
      case 'L': return { x: pt.x - offset, y: pt.y };
      case 'B': return { x: pt.x, y: pt.y + offset };
      case 'T': return { x: pt.x, y: pt.y - offset };
      default: return { x: pt.x, y: pt.y };
    }
  }

  // Shorten port label (e.g., '1' -> 'P1', 'ether1' -> 'eth1', 'gi0/1' -> 'Gi1')
  function formatPortBadgeLabel(raw) {
    if (!raw) return '';
    const str = String(raw).trim();
    if (/^\d+$/.test(str)) return `P${str}`;
    if (/^ether(\d+)$/i.test(str)) return `eth${RegExp.$1}`;
    if (/^(gi|fa|te|ge)(\d+.*)$/i.test(str)) return `${RegExp.$1.toUpperCase()}${RegExp.$2}`;
    return str.length > 5 ? str.slice(0, 4) : str;
  }

  // Determine physical port count configured for device (default 48 for switches)
  function getNodePortCount(n, snap) {
    if (!n || n.kind !== 'device') return 0;
    const d = snap && snap.devices && snap.devices.find((x) => x.id === n.ref);
    if (!d) return 0;
    if (d.port_count !== undefined && d.port_count !== null && d.port_count > 0) return d.port_count;
    if (d.type === 'switch') return 48;
    if (['router', 'firewall'].includes(d.type)) return 16;
    return 0;
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
      this.drag = null;
      this.dirty = false;
      el.innerHTML = `<div class="row" style="margin-bottom:10px"><h1 style="margin:0" id="mp-title"></h1><span class="spacer"></span><div id="mp-tools" class="row"></div></div>
        <div class="map-box" id="mp-box"><svg id="mp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"></svg></div>`;
      this.bind();
      this.tools();
      this.draw();
    },
    destroy() { this.m = null; },
    update() { if (this.m && !this.drag) this.draw(); },

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
      const selDev = selNode && selNode.kind === 'device' && M.S.snap ? M.S.snap.devices.find((d) => d.id === selNode.ref) : null;

      tl.innerHTML = `<select class="sel" id="mp-dev"><option value="">${t('+ Thiết bị…')}</option>${devOpts}</select>
        <select class="sel" id="mp-grp"><option value="">${t('+ Nhóm…')}</option>${grpOpts}</select>
        <button class="btn" id="mp-lbl">${t('+ Nhãn')}</button>
        <button class="btn ${this.linkMode ? 'primary' : ''}" id="mp-link">${t('🔗 Nối dây')}</button>
        ${isLinkSel ? `<button class="btn primary" id="mp-cfg-link">${t('🔌 Đổi cổng nối')}</button>` : ''}
        ${selDev ? `<button class="btn" id="mp-inspect-btn">${t('🔌 Soi cổng')}</button>` : ''}
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
        this.tools();
        this.draw();
        if (this.linkMode) M.toast(t('Bấm lần lượt 2 thiết bị để nối dây'));
      };

      const cfgLinkBtn = $('#mp-cfg-link');
      if (cfgLinkBtn) cfgLinkBtn.onclick = () => { if (this.sel && this.sel.type === 'link') this.openLinkConfigModal(this.sel.index); };

      const inspectBtn = $('#mp-inspect-btn');
      if (inspectBtn) inspectBtn.onclick = () => { if (selDev && M.openPortInspectorModal) M.openPortInspectorModal(selDev); };

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

    // Modal to configure ports at both ends of a cable link (supports up to 48 ports + SNMP ports + custom input)
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
      const devA = nodeA.kind === 'device' && snap ? snap.devices.find((d) => d.id === nodeA.ref) : null;
      const devB = nodeB.kind === 'device' && snap ? snap.devices.find((d) => d.id === nodeB.ref) : null;

      const pcA = Math.max(getNodePortCount(nodeA, snap), (devA && devA.type === 'switch') ? 48 : 0);
      const pcB = Math.max(getNodePortCount(nodeB, snap), (devB && devB.type === 'switch') ? 48 : 0);

      const makeDatalistOptions = (count, current) => {
        const opts = [];
        const seen = new Set();
        if (current) {
          opts.push(`<option value="${esc(current)}">${t('Đang chọn:')} ${esc(current)}</option>`);
          seen.add(String(current));
        }
        const max = Math.max(48, count || 0);
        for (let i = 1; i <= max; i++) {
          const val = String(i);
          if (!seen.has(val)) {
            opts.push(`<option value="${val}">Port ${i} (P${i})</option>`);
            seen.add(val);
          }
        }
        return opts.join('');
      };

      const curFrom = l.from_port || '';
      const curTo = l.to_port || '';

      const bodyHtml = `
        <div style="margin-bottom:12px;font-size:13px" class="muted">
          ${t('Cấu hình cổng vật lý kết nối cho 2 đầu dây cáp. Chọn từ danh sách 48 cổng hoặc nhập tay cổng bất kỳ (vd: Gi1/0/25, ether1, Port 47...).')}
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${esc(infoA.name)}</label>
            <input class="inp" list="dl-port-a" id="inp-port-a" name="from_port" placeholder="${t('Chọn hoặc nhập cổng (vd: 1, Gi1/0/25)...')}" value="${esc(curFrom)}" autocomplete="off" style="width:100%">
            <datalist id="dl-port-a">${makeDatalistOptions(pcA, curFrom)}</datalist>
            <div id="snmp-ports-a" class="muted" style="font-size:11px;margin-top:4px"></div>
          </div>
          <div class="field">
            <label>${esc(infoB.name)}</label>
            <input class="inp" list="dl-port-b" id="inp-port-b" name="to_port" placeholder="${t('Chọn hoặc nhập cổng (vd: 2, ether2)...')}" value="${esc(curTo)}" autocomplete="off" style="width:100%">
            <datalist id="dl-port-b">${makeDatalistOptions(pcB, curTo)}</datalist>
            <div id="snmp-ports-b" class="muted" style="font-size:11px;margin-top:4px"></div>
          </div>
        </div>
      `;

      const { form } = M.modal(t('🔌 Cấu hình cổng kết nối liên kết (Đến 48 Port)'), bodyHtml, (f) => {
        const fd = new FormData(f);
        const fp = String(fd.get('from_port') || '').trim();
        const tp = String(fd.get('to_port') || '').trim();
        l.from_port = fp || null;
        l.to_port = tp || null;
        this.dirty = true;
        this.draw();
        M.toast(t('Đã cập nhật cổng kết nối'));
      }, { submit: t('Lưu cổng') });

      // Async enrich with real SNMP ports if device has SNMP configured
      const enrichWithSnmp = async (dev, datalistId, hintId) => {
        if (!dev || !dev.address || !dev.snmp_enabled) return;
        try {
          const res = await M.api('GET', `/api/devices/${dev.id}/ports`);
          if (res && Array.isArray(res.ports) && res.ports.length > 0) {
            const dl = $(`#${datalistId}`, form);
            const hint = $(`#${hintId}`, form);
            if (dl) {
              const snmpOpts = res.ports.map((p) => {
                const st = p.oper_status === 'up' ? '🟢 UP' : '⚪ DOWN';
                return `<option value="${esc(p.name)}">${esc(p.name)} [${st}] (${esc(p.speed_label || '')})</option>`;
              });
              dl.innerHTML = snmpOpts.join('') + dl.innerHTML;
            }
            if (hint) {
              hint.innerHTML = `<span style="color:var(--c-ok)">✓ ${t('Đã đọc')} ${res.ports.length} ${t('cổng vật lý từ SNMP')}</span>`;
            }
          }
        } catch { /* optional SNMP enrich */ }
      };

      enrichWithSnmp(devA, 'dl-port-a', 'snmp-ports-a');
      enrichWithSnmp(devB, 'dl-port-b', 'snmp-ports-b');
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
          rawDevice: d,
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
      const nodes = new Map(m.nodes.map((n) => [n.id, n]));
      const infos = new Map(m.nodes.map((n) => [n.id, this.info(n)]));
      $('#mp-box').classList.toggle('editing', this.edit);
      const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);

      // Render Straight Edge-to-Edge Links with Clean Port Badges
      const linksHtml = m.links.map((l, i) => {
        const a = nodes.get(l.from), b = nodes.get(l.to);
        if (!a || !b) return '';
        const ia = infos.get(a.id), ib = infos.get(b.id);
        const r = score(ia ? ia.rank : 'unknown') >= score(ib ? ib.rank : 'unknown') ? (ia ? ia.rank : 'unknown') : (ib ? ib.rank : 'unknown');
        const bad = SEV_RANK[r];
        const sel = this.sel && this.sel.type === 'link' && this.sel.index === i;

        // Straight edge-to-edge calculation
        const { ptA, ptB, sideA, sideB } = getEdgeEndpoints(a, b);

        // Port Badges at cable ends if configured
        let badgesHtml = '';
        const bw = 32, bh = 17;

        if (l.from_port) {
          const bCoordA = getBadgeCoords(ptA, sideA);
          const pLblA = formatPortBadgeLabel(l.from_port);
          badgesHtml += `
            <g class="m-port-badge" transform="translate(${bCoordA.x - bw / 2}, ${bCoordA.y - bh / 2})">
              <rect width="${bw}" height="${bh}" rx="4" class="m-port-badge-bg ${bad ? 'down' : 'up'}"/>
              <text x="${bw / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblA)}</text>
              <title>${esc(t('Cổng'))}: ${esc(l.from_port)} (${esc(ia ? ia.name : '')})</title>
            </g>
          `;
        }

        if (l.to_port) {
          const bCoordB = getBadgeCoords(ptB, sideB);
          const pLblB = formatPortBadgeLabel(l.to_port);
          badgesHtml += `
            <g class="m-port-badge" transform="translate(${bCoordB.x - bw / 2}, ${bCoordB.y - bh / 2})">
              <rect width="${bw}" height="${bh}" rx="4" class="m-port-badge-bg ${bad ? 'down' : 'up'}"/>
              <text x="${bw / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblB)}</text>
              <title>${esc(t('Cổng'))}: ${esc(l.to_port)} (${esc(ib ? ib.name : '')})</title>
            </g>
          `;
        }

        return `
          <line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r]}${sel ? ';stroke-width:7;filter:drop-shadow(0 0 5px var(--accent))' : ''}" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}"/>
          ${this.edit ? `<line data-link="${i}" stroke="transparent" stroke-width="20" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}" style="cursor:pointer"/>` : ''}
          ${badgesHtml}
        `;
      }).join('');

      const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

      // Render Node Cards cleanly (NO crowded 24/48 matrix on small cards)
      const nodeSvg = m.nodes.map((n) => {
        const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
        const sel = (this.sel && this.sel.type === 'node' && this.sel.id === n.id) || this.linkFrom === n.id;

        if (n.kind === 'label') {
          return `<g class="m-node m-label ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
            <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
        }

        // Active connected ports list for this node
        const activePorts = m.links
          .map((lk) => (lk.from === n.id && lk.from_port ? lk.from_port : (lk.to === n.id && lk.to_port ? lk.to_port : null)))
          .filter(Boolean);

        const hasActivePorts = activePorts.length > 0;
        const portSummaryText = hasActivePorts
          ? `🔌 Cáp: ${activePorts.slice(0, 3).map((p) => formatPortBadgeLabel(p)).join(', ')}${activePorts.length > 3 ? '…' : ''}`
          : '';

        const isNetDevice = n.kind === 'device' && i.rawDevice && (i.rawDevice.snmp_enabled || ['switch', 'router', 'firewall'].includes(i.rawDevice.type));

        // Integrated Port Inspector button on the top-right of the card
        const inspectBtnHtml = isNetDevice ? `
          <g class="m-port-inspect-btn" data-inspect-ref="${n.ref}">
            <rect x="${NW - 28}" y="8" width="20" height="18" rx="4"/>
            <text x="${NW - 18}" y="21" text-anchor="middle" font-size="11">🔌</text>
            <title>${esc(t('Mở bảng soi cổng chi tiết (Port Inspector)'))}</title>
          </g>
        ` : '';

        return `
          <g class="m-node ${i.cls} ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - NH / 2})">
            <rect width="${NW}" height="${NH}" rx="10"/>
            <text x="12" y="32" font-size="22">${i.icon}</text>
            <text x="42" y="26" font-size="15" font-weight="700">${esc(trunc(i.name, isNetDevice ? 14 : 17))}</text>
            <text class="m-sub" x="42" y="${hasActivePorts ? 42 : 46}">${esc(trunc(i.sub, 18))}</text>
            ${hasActivePorts ? `<text class="m-port-active-summary" x="42" y="55" font-size="10" font-weight="600" fill="var(--c-ok)">${esc(portSummaryText)}</text>` : ''}
            ${inspectBtnHtml}
          </g>
        `;
      }).join('');

      svg.innerHTML = linksHtml + nodeSvg;
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
        const insp = e.target.closest('[data-inspect-ref]');
        if (insp) {
          const devId = Number(insp.dataset.inspectRef);
          const dev = M.S.snap && M.S.snap.devices && M.S.snap.devices.find((d) => d.id === devId);
          if (dev && M.openPortInspectorModal) M.openPortInspectorModal(dev);
          return;
        }

        const g = e.target.closest('[data-id]');
        const lk = e.target.closest('[data-link]');

        if (!this.edit) return;

        if (g) {
          const n = this.m.nodes.find((x) => x.id === g.dataset.id);
          if (!n) return;

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
        } else {
          this.sel = null;
          this.linkFrom = null;
        }
        this.tools();
        this.draw();
      });

      svg.addEventListener('pointermove', (e) => {
        if (!this.drag) return;
        const p = pt(e);
        this.drag.n.x = Math.round(Math.min(W - NW / 2, Math.max(NW / 2, p.x + this.drag.dx)) / 10) * 10;
        this.drag.n.y = Math.round(Math.min(H - NH / 2, Math.max(NH / 2, p.y + this.drag.dy)) / 10) * 10;
        this.dirty = true;
        this.draw();
      });

      const end = () => { this.drag = null; };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);

      // Double-click to configure wire ports
      svg.addEventListener('dblclick', (e) => {
        if (!this.edit || !this.m) return;
        const lk = e.target.closest('[data-link]');
        const badge = e.target.closest('.m-port-badge');
        if (lk) {
          this.openLinkConfigModal(Number(lk.dataset.link));
        } else if (badge && this.sel && this.sel.type === 'link') {
          this.openLinkConfigModal(this.sel.index);
        }
      });

      // Regular click in view mode
      svg.addEventListener('click', (e) => {
        if (this.edit || !this.m) return;
        const insp = e.target.closest('[data-inspect-ref]');
        if (insp) return; // handled in pointerdown
        const g = e.target.closest('[data-id]');
        if (!g) return;
        const n = this.m.nodes.find((x) => x.id === g.dataset.id);
        const i = n && this.info(n);
        if (i && i.href) location.hash = i.href;
      });
    },
  };

  // Reusable lightweight SVG map renderer
  M.renderMapSvg = (svg, m) => {
    if (!svg || !m) return;
    const nodes = new Map((m.nodes || []).map((n) => [n.id, n]));
    const infos = new Map((m.nodes || []).map((n) => [n.id, M.views.map.info(n)]));
    const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);

    const links = (m.links || []).map((l) => {
      const a = nodes.get(l.from), b = nodes.get(l.to);
      if (!a || !b) return '';
      const ia = infos.get(a.id), ib = infos.get(b.id);
      const r = score(ia ? ia.rank : 'unknown') >= score(ib ? ib.rank : 'unknown') ? (ia ? ia.rank : 'unknown') : (ib ? ib.rank : 'unknown');
      const bad = SEV_RANK[r];

      const { ptA, ptB, sideA, sideB } = getEdgeEndpoints(a, b);

      let badgesHtml = '';
      const bw = 32, bh = 17;

      if (l.from_port) {
        const bCoordA = getBadgeCoords(ptA, sideA);
        const pLblA = formatPortBadgeLabel(l.from_port);
        badgesHtml += `
          <g class="m-port-badge" transform="translate(${bCoordA.x - bw / 2}, ${bCoordA.y - bh / 2})">
            <rect width="${bw}" height="${bh}" rx="4" class="m-port-badge-bg ${bad ? 'down' : 'up'}"/>
            <text x="${bw / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblA)}</text>
          </g>
        `;
      }

      if (l.to_port) {
        const bCoordB = getBadgeCoords(ptB, sideB);
        const pLblB = formatPortBadgeLabel(l.to_port);
        badgesHtml += `
          <g class="m-port-badge" transform="translate(${bCoordB.x - bw / 2}, ${bCoordB.y - bh / 2})">
            <rect width="${bw}" height="${bh}" rx="4" class="m-port-badge-bg ${bad ? 'down' : 'up'}"/>
            <text x="${bw / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblB)}</text>
          </g>
        `;
      }

      return `
        <line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r] || 'var(--c-ok)'}" x1="${ptA.x}" y1="${ptA.y}" x2="${ptB.x}" y2="${ptB.y}"/>
        ${badgesHtml}
      `;
    }).join('');

    const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
    const nodeSvg = (m.nodes || []).map((n) => {
      const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
      if (n.kind === 'label') {
        return `<g class="m-node m-label" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
          <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
      }

      const activePorts = (m.links || [])
        .map((lk) => (lk.from === n.id && lk.from_port ? lk.from_port : (lk.to === n.id && lk.to_port ? lk.to_port : null)))
        .filter(Boolean);

      const hasActivePorts = activePorts.length > 0;
      const portSummaryText = hasActivePorts
        ? `🔌 ${activePorts.slice(0, 3).map((p) => formatPortBadgeLabel(p)).join(', ')}`
        : '';

      return `
        <g class="m-node ${i.cls}" data-id="${n.id}" data-href="${i.href || ''}" style="cursor:pointer" transform="translate(${n.x - NW / 2},${n.y - NH / 2})">
          <rect width="${NW}" height="${NH}" rx="10"/>
          <text x="12" y="32" font-size="22">${i.icon}</text>
          <text x="42" y="26" font-size="15" font-weight="700">${esc(trunc(i.name, 17))}</text>
          <text class="m-sub" x="42" y="${hasActivePorts ? 42 : 46}">${esc(trunc(i.sub, 18))}</text>
          ${hasActivePorts ? `<text class="m-port-active-summary" x="42" y="55" font-size="10" font-weight="600" fill="var(--c-ok)">${esc(portSummaryText)}</text>` : ''}
        </g>
      `;
    }).join('');

    svg.innerHTML = links + nodeSvg;
  };
})();
