'use strict';
// Topology maps: live status view + top-down clean link routing + integrated Port Inspector.
(() => {
  const { esc, $, t } = M;
  const W = 1600, H = 900, NW = 180, NH = 60;
  const canEdit = () => M.S.user && M.S.user.role !== 'viewer';
  const COL = {
    critical: 'var(--c-critical)',
    high: 'var(--c-high)',
    medium: 'var(--c-medium)',
    low: 'var(--c-low)',
    up: 'var(--c-ok)',
    degraded: 'var(--c-high)',
    unknown: 'var(--c-unknown)',
    none: 'var(--muted)',
  };
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

  // Cache trạng thái cổng SNMP theo thiết bị để tính màu đường dây LACP / Bonding (UP / Degraded / DOWN)
  if (!M.S.snmpPorts) M.S.snmpPorts = new Map();
  const snmpPortInflight = new Set();

  function isSnmpCapableDevice(dev) {
    return Boolean(dev && dev.id && dev.address && (dev.snmp_enabled || (dev.checks && dev.checks.snmp) || ['switch', 'router', 'firewall', 'ap', 'printer'].includes(dev.type)));
  }

  function requestDeviceSnmpPorts(dev, onUpdated) {
    if (!isSnmpCapableDevice(dev)) return;
    const cached = M.S.snmpPorts.get(dev.id);
    if (cached && Date.now() - cached.at < 15000) return;
    if (snmpPortInflight.has(dev.id)) return;
    snmpPortInflight.add(dev.id);
    M.api('GET', `/api/devices/${dev.id}/ports`)
      .then((res) => {
        if (res && Array.isArray(res.ports) && res.ports.length > 0) {
          M.S.snmpPorts.set(dev.id, { at: Date.now(), ports: res.ports });
          if (typeof onUpdated === 'function') onUpdated();
        }
      })
      .catch(() => {})
      .finally(() => {
        snmpPortInflight.delete(dev.id);
      });
  }

  // Chuẩn hóa vị trí neo: Xuất phát từ cạnh dưới (đáy) của card phía trên
  // và cắm thẳng vào cạnh trên (đỉnh) của card phía dưới (chuẩn sơ đồ cây phân cấp)
  // Nếu 2 thiết bị nằm ngang cùng hàng hoặc là đường mlag_peer, neo ngang từ cạnh trái sang cạnh phải.
  function getLinkEndpoints(a, b, linkType) {
    if (linkType === 'mlag_peer' || Math.abs(a.y - b.y) <= 25) {
      if (a.x <= b.x) {
        return { x1: a.x + NW / 2, y1: a.y, x2: b.x - NW / 2, y2: b.y };
      }
      return { x1: a.x - NW / 2, y1: a.y, x2: b.x + NW / 2, y2: b.y };
    }
    if (a.y <= b.y) {
      return {
        x1: a.x,
        y1: a.y + NH / 2, // Cạnh dưới (đáy) của card phía trên (a)
        x2: b.x,
        y2: b.y - NH / 2, // Cạnh trên (đỉnh) của card phía dưới (b)
      };
    } else {
      return {
        x1: a.x,
        y1: a.y - NH / 2, // Cạnh trên (đỉnh) của card phía dưới (a)
        x2: b.x,
        y2: b.y + NH / 2, // Cạnh dưới (đáy) của card phía trên (b)
      };
    }
  }

  const getEdgeEndpoints = getLinkEndpoints;

  // Tính tọa độ 2 đường thẳng song song cho bó cáp LACP / MLAG Peer
  function getParallelLines(x1, y1, x2, y2, gap = 3.5) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * gap;
    const ny = (dx / len) * gap;
    const r = (v) => Math.round(v * 10) / 10;
    return {
      line1: { x1: r(x1 + nx), y1: r(y1 + ny), x2: r(x2 + nx), y2: r(y2 + ny) },
      line2: { x1: r(x1 - nx), y1: r(y1 - ny), x2: r(x2 - nx), y2: r(y2 - ny) },
    };
  }

  // Tính tọa độ trung tâm cho badge cổng bám dọc theo đường dây, nằm sát ngay điểm neo của thiết bị
  function getBadgeCoords(ptFrom, ptTo, offsetDist, maxRatio) {
    const dx = ptTo.x - ptFrom.x;
    const dy = ptTo.y - ptFrom.y;
    const dist = Math.hypot(dx, dy) || 1;
    // Đảm bảo không bao giờ trôi quá 35% chiều dài dây (hoặc 28% khi có badge LACP ở giữa) và luôn bám sát thiết bị xuất phát
    const ratio = maxRatio || 0.35;
    const offset = Math.min(offsetDist || 18, dist * ratio);
    return {
      x: ptFrom.x + (dx / dist) * offset,
      y: ptFrom.y + (dy / dist) * offset,
    };
  }

  // Định dạng rút gọn tên cổng hiển thị trên badge nổi (vd: 1 -> P1, port23 -> P23, ether1 -> eth1, Gi1/0/24 -> GI1/0/24)
  function formatPortBadgeLabel(raw) {
    if (!raw) return '';
    const str = String(raw).trim();
    if (/^\d+$/.test(str)) return `P${str}`;
    if (/^port\s*(\d+)$/i.test(str)) return `P${RegExp.$1}`;
    if (/^p(\d+)$/i.test(str)) return `P${RegExp.$1}`;
    if (/^ether(\d+)$/i.test(str)) return `eth${RegExp.$1}`;
    if (/^(gi|fa|te|ge)(\d+.*)$/i.test(str)) return `${RegExp.$1.toUpperCase()}${RegExp.$2}`;
    return str.length > 7 ? str.slice(0, 6) : str;
  }

  // Định dạng hợp lý cụm port vật lý khi cấu hình LACP (vd: ["port23", "port24"] -> "P23-24", ["port1", "port2", "port4"] -> "P1-2,4")
  function formatBundlePortsBadgeLabel(ports) {
    if (!Array.isArray(ports) || !ports.length) return '';
    const clean = [...new Set(ports.map((p) => String(p || '').trim()).filter(Boolean))];
    if (!clean.length) return '';
    if (clean.length === 1) return formatPortBadgeLabel(clean[0]);

    // Kiểm tra nếu các cổng có chung tiền tố và hậu tố số (vd: port23, port24 hoặc Gi1/0/23, Gi1/0/24)
    const parsed = clean.map((p) => {
      const m1 = /^(?:port\s*|p)?(\d+)$/i.exec(p);
      if (m1) return { prefix: 'P', num: Number(m1[1]) };
      const m2 = /^ether(\d+)$/i.exec(p);
      if (m2) return { prefix: 'eth', num: Number(m2[1]) };
      const m3 = /^([a-zA-Z0-9/_-]*?[a-zA-Z/])(\d+)$/.exec(p);
      if (m3) return { prefix: m3[1].toUpperCase(), num: Number(m3[2]) };
      return null;
    });

    if (parsed.every((x) => x !== null && x.prefix === parsed[0].prefix)) {
      const prefix = parsed[0].prefix;
      const nums = [...new Set(parsed.map((x) => x.num))].sort((a, b) => a - b);
      const ranges = [];
      let start = nums[0], prev = nums[0];
      for (let i = 1; i <= nums.length; i++) {
        if (i < nums.length && nums[i] === prev + 1) {
          prev = nums[i];
        } else {
          ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
          if (i < nums.length) { start = nums[i]; prev = nums[i]; }
        }
      }
      const joined = ranges.join(',');
      const full = `${prefix}${joined}`;
      return full.length <= 12 ? full : `${prefix}${ranges[0]},+${ clean.length - 1 }`;
    }

    const shortList = clean.map(formatPortBadgeLabel);
    if (shortList.length === 2) return `${shortList[0]},${shortList[1]}`;
    return `${shortList[0]},${shortList[1]}+${shortList.length - 2}`;
  }

  // Đọc trạng thái SNMP của 1 cổng cụ thể trên thiết bị ('up' | 'down' | null)
  function getDevicePortSnmpStatus(dev, portRef) {
    if (!dev || !portRef) return null;
    const ref = String(portRef).trim();
    if (!ref) return null;

    if (dev.port_status && typeof dev.port_status === 'object') {
      const direct = dev.port_status[ref] || dev.port_status[ref.toLowerCase()];
      if (direct === 'up' || direct === 'down') return direct;
    }

    const cachedEntry = M.S.snmpPorts && M.S.snmpPorts.get(dev.id);
    const ports = (Array.isArray(dev.ports) && dev.ports)
      || (Array.isArray(dev.snmp_ports) && dev.snmp_ports)
      || (dev.snmp && Array.isArray(dev.snmp.ports) && dev.snmp.ports)
      || (cachedEntry && Array.isArray(cachedEntry.ports) && cachedEntry.ports)
      || null;

    if (!ports || !ports.length) return null;

    const refLower = ref.toLowerCase();
    let found = ports.find((p) => {
      if (!p) return false;
      return [p.name, p.descr, p.alias, String(p.index), `port${p.index}`, `p${p.index}`]
        .some((v) => v !== undefined && v !== null && String(v).trim().toLowerCase() === refLower);
    });

    if (!found) {
      const numMatch = /^(?:port\s*|p|eth(?:er)?\s*)?(\d+)$/i.exec(ref);
      if (numMatch) {
        const portNum = Number(numMatch[1]);
        const endRe = new RegExp(`(?:^|[^0-9])${portNum}$`, 'i');
        found = ports.find((p) => p && (Number(p.index) === portNum || endRe.test(String(p.name || '').trim())));
      }
    }

    if (!found) return null;
    if (found.admin_status && found.admin_status !== 'up') return 'down';
    const oper = found.oper_status || found.status;
    if (oper === 'up') return 'up';
    if (oper) return 'down';
    return null;
  }

  // Thuật toán đánh giá trạng thái và màu sắc đường cáp (Single / LACP Bundle / MLAG Peer)
  function evaluateLinkHealth(l, ia, ib) {
    const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);
    const rA = ia ? ia.rank : 'unknown';
    const rB = ib ? ib.rank : 'unknown';
    const worstRank = score(rA) >= score(rB) ? rA : rB;
    const isMlag = l.link_type === 'mlag_peer';
    const isBundle = Boolean(l.is_bundle || l.link_type === 'lacp');
    const members = Array.isArray(l.members) ? l.members.filter((m) => m && (m.src || m.dst)) : [];

    // Với đường dây thường (Single link) và không phải MLAG Peer: Giữ nguyên cách tính màu cũ
    if (!isBundle && !isMlag) {
      const bad = Boolean(SEV_RANK[worstRank]);
      return {
        isBundle: false,
        isMlag: false,
        state: bad ? 'down' : 'up',
        badgeState: bad ? 'down' : 'up',
        stroke: COL[worstRank] || 'var(--c-ok)',
        upCount: bad ? 0 : 1,
        totalCount: 1,
        memberDetails: [],
      };
    }

    const devA = ia && ia.rawDevice;
    const devB = ib && ib.rawDevice;
    const endpointDown = (devA && devA.status === 'down')
      || (devB && devB.status === 'down')
      || (!devA && !devB && Boolean(SEV_RANK[worstRank]));

    if (endpointDown) {
      const total = members.length || 2;
      return {
        isBundle,
        isMlag,
        state: 'down',
        badgeState: 'down',
        stroke: COL.critical,
        upCount: 0,
        totalCount: total,
        memberDetails: members.map((m) => ({ src: m.src, dst: m.dst, status: 'down' })),
      };
    }

    if (members.length > 0) {
      const memberDetails = members.map((m) => {
        const explicit = m.oper_status || m.status;
        const stA = getDevicePortSnmpStatus(devA, m.src);
        const stB = getDevicePortSnmpStatus(devB, m.dst);
        let st = 'up';
        if (explicit === 'down' || stA === 'down' || stB === 'down') st = 'down';
        else if (explicit === 'up' || stA === 'up' || stB === 'up') st = 'up';
        else st = SEV_RANK[worstRank] && worstRank === 'critical' ? 'down' : 'up';
        return { src: m.src, dst: m.dst, status: st, stA, stB };
      });

      const upCount = memberDetails.filter((m) => m.status === 'up').length;
      const downCount = memberDetails.length - upCount;

      if (upCount === memberDetails.length) {
        // Tất cả cổng thành viên UP -> màu xanh lá
        return {
          isBundle,
          isMlag,
          state: 'up',
          badgeState: 'up',
          stroke: COL.up,
          upCount,
          totalCount: memberDetails.length,
          memberDetails,
        };
      }
      if (upCount > 0 && downCount > 0) {
        // Có cổng UP cổng DOWN (đứt 1 chân dự phòng) -> màu vàng cam (Degraded)
        return {
          isBundle,
          isMlag,
          state: 'degraded',
          badgeState: 'warning',
          stroke: COL.degraded,
          upCount,
          totalCount: memberDetails.length,
          memberDetails,
        };
      }
      // Toàn bộ cổng thành viên DOWN -> màu đỏ
      return {
        isBundle,
        isMlag,
        state: 'down',
        badgeState: 'down',
        stroke: COL.critical,
        upCount: 0,
        totalCount: memberDetails.length,
        memberDetails,
      };
    }

    // Bundle hoặc MLAG chưa khai báo chi tiết từng cặp port -> dựa theo trạng thái 2 đầu thiết bị
    const bad = Boolean(SEV_RANK[worstRank]);
    return {
      isBundle,
      isMlag,
      state: bad ? 'down' : 'up',
      badgeState: bad ? 'down' : 'up',
      stroke: bad ? (COL[worstRank] || COL.critical) : COL.up,
      upCount: bad ? 0 : 2,
      totalCount: 2,
      memberDetails: [],
    };
  }

  M.evaluateLinkHealth = evaluateLinkHealth;
  M.formatBundlePortsBadgeLabel = formatBundlePortsBadgeLabel;

  // Determine fallback physical port count when SNMP port list is unavailable (always 48 suggestion table unless configured > 48)
  function getNodePortCount(n, snap) {
    if (!n || n.kind !== 'device') return 48;
    const d = snap && snap.devices && snap.devices.find((x) => x.id === n.ref);
    if (!d) return 48;
    if (d.port_count !== undefined && d.port_count !== null && Number(d.port_count) > 48) return Number(d.port_count);
    return 48;
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
      // Pre-fetch SNMP physical port lists for devices on the map so Link Config Modal opens with exact ports ready
      if (M.S.snap && Array.isArray(M.S.snap.devices) && Array.isArray(m.nodes)) {
        m.nodes.forEach((n) => {
          if (n.kind === 'device') {
            const dev = M.S.snap.devices.find((d) => d.id === n.ref);
            if (dev) requestDeviceSnmpPorts(dev, () => { if (this.m && !this.drag) this.draw(); });
          }
        });
      }
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

    // Modal to configure ports at both ends of a cable link (Single Link, LACP / Bonding Bundle, MLAG Peer)
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

      // Fallback port count (48 ports suggestion table unless device has explicit port_count configured)
      const fallbackCountA = getNodePortCount(nodeA, snap) || 48;
      const fallbackCountB = getNodePortCount(nodeB, snap) || 48;

      const cachedSnmpA = devA && M.S.snmpPorts && M.S.snmpPorts.get(devA.id);
      const cachedSnmpB = devB && M.S.snmpPorts && M.S.snmpPorts.get(devB.id);
      const initSnmpPortsA = cachedSnmpA && Array.isArray(cachedSnmpA.ports) && cachedSnmpA.ports.length > 0 ? cachedSnmpA.ports : null;
      const initSnmpPortsB = cachedSnmpB && Array.isArray(cachedSnmpB.ports) && cachedSnmpB.ports.length > 0 ? cachedSnmpB.ports : null;

      const curFrom = l.from_port || '';
      const curTo = l.to_port || '';
      const curLinkType = ['single', 'lacp', 'mlag_peer'].includes(l.link_type)
        ? l.link_type
        : (l.is_bundle ? 'lacp' : 'single');
      const curIsBundle = Boolean(l.is_bundle || curLinkType === 'lacp');
      const curBundleName = l.bundle_name || '';
      const curMembers = Array.isArray(l.members) ? l.members : [];

      const normalizePortKey = (val) => {
        if (!val) return '';
        const s = String(val).trim();
        const m = /^(?:port\s*|p)?(\d+)$/i.exec(s);
        return m ? `port${m[1]}` : s.toLowerCase();
      };

      const formatChkLabel = (raw) => {
        if (!raw) return '';
        const str = String(raw).trim();
        const mPort = /^(?:port\s*|p)(\d+)$/i.exec(str);
        if (mPort) return `P${mPort[1]}`;
        if (/^\d+$/.test(str)) return `P${str}`;
        return str.length > 9 ? str.slice(0, 8) : str;
      };

      const selectedSrcKeys = new Set(curMembers.map((m) => normalizePortKey(m.src)).filter(Boolean));
      const selectedDstKeys = new Set(curMembers.map((m) => normalizePortKey(m.dst)).filter(Boolean));
      if (!curMembers.length && curFrom) selectedSrcKeys.add(normalizePortKey(curFrom));
      if (!curMembers.length && curTo) selectedDstKeys.add(normalizePortKey(curTo));

      // Render <datalist> options: exact SNMP physical ports if available, otherwise fallback suggestion table (48 ports)
      const makeDatalistOptions = (fallbackCount, current, snmpPorts) => {
        const opts = [];
        const seen = new Set();
        if (current) {
          opts.push(`<option value="${esc(current)}">${t('Đang chọn:')} ${esc(current)}</option>`);
          seen.add(String(current).toLowerCase());
        }
        if (Array.isArray(snmpPorts) && snmpPorts.length > 0) {
          snmpPorts.forEach((p) => {
            const pName = String(p.name || '').trim();
            if (!pName || seen.has(pName.toLowerCase())) return;
            const st = p.oper_status === 'up' ? '🟢 UP' : '⚪ DOWN';
            const spd = p.speed_label ? ` (${esc(p.speed_label)})` : '';
            opts.push(`<option value="${esc(pName)}">${esc(pName)} [${st}]${spd}</option>`);
            seen.add(pName.toLowerCase());
          });
          return opts.join('');
        }
        const max = fallbackCount > 0 ? fallbackCount : 48;
        for (let i = 1; i <= max; i++) {
          const val = String(i);
          if (!seen.has(val)) {
            opts.push(`<option value="${val}">Port ${i} (P${i})</option>`);
            seen.add(val);
          }
        }
        return opts.join('');
      };

      // Render LACP multi-port checkboxes: exact SNMP physical ports if available, otherwise fallback suggestion table (48 ports)
      const makeMultiPortCheckboxes = (fallbackCount, side, selectedKeys, snmpPorts) => {
        if (Array.isArray(snmpPorts) && snmpPorts.length > 0) {
          return snmpPorts.map((p) => {
            const val = String(p.name || `port${p.index}`).trim();
            const normVal = normalizePortKey(val);
            const isChecked = selectedKeys.has(normVal) || selectedKeys.has(val.toLowerCase());
            const checkedAttr = isChecked ? 'checked' : '';
            const isUp = p.oper_status === 'up';
            const snmpCls = isUp ? 'snmp-up' : 'snmp-down';
            const titleText = `${val} [${isUp ? 'UP' : 'DOWN'}]${p.speed_label ? ` ${p.speed_label}` : ''}`;
            const shortLbl = formatChkLabel(val);
            return `
              <label class="lacp-port-chk ${isChecked ? 'active' : ''} ${snmpCls}" data-port-val="${esc(val)}" title="${esc(titleText)}">
                <input type="checkbox" name="lacp_${side}_port" value="${esc(val)}" ${checkedAttr}>
                <span>${esc(shortLbl)}</span>
              </label>
            `;
          }).join('');
        }
        const max = fallbackCount > 0 ? fallbackCount : 48;
        const items = [];
        for (let i = 1; i <= max; i++) {
          const val = `port${i}`;
          const checked = selectedKeys.has(val) ? 'checked' : '';
          items.push(`
            <label class="lacp-port-chk ${checked ? 'active' : ''}" data-port-val="${val}">
              <input type="checkbox" name="lacp_${side}_port" value="${val}" ${checked}>
              <span>P${i}</span>
            </label>
          `);
        }
        return items.join('');
      };

      const makeLacpHeaderText = (infoName, fallbackCount, snmpPorts) => {
        if (Array.isArray(snmpPorts) && snmpPorts.length > 0) {
          return `${esc(infoName)} — ${t('Chọn cổng vật lý thực tế')} (${snmpPorts.length} port SNMP)`;
        }
        const max = fallbackCount > 0 ? fallbackCount : 48;
        return `${esc(infoName)} — ${t('Bảng gợi ý chọn cổng')} (1..${max})`;
      };

      const makeHintHtml = (dev, fallbackCount, snmpPorts, loading = false) => {
        if (Array.isArray(snmpPorts) && snmpPorts.length > 0) {
          const upCnt = snmpPorts.filter((p) => p && p.oper_status === 'up').length;
          return `<span style="color:var(--c-ok)">✓ ${t('Đã đọc đúng')} <b>${snmpPorts.length}</b> ${t('cổng vật lý thực tế từ SNMP')} (${upCnt} UP / ${snmpPorts.length - upCnt} DOWN)</span>`;
        }
        if (loading) {
          return `<span class="muted">⏳ ${t('Đang đọc bảng danh sách cổng vật lý thực tế qua SNMP...')}</span>`;
        }
        const max = fallbackCount > 0 ? fallbackCount : 48;
        return `<span style="color:var(--c-warn)">⚠ ${t('Không đọc được SNMP — đang hiển thị bảng gợi ý')} (${max} port)</span>`;
      };

      const loadingA = Boolean(devA && devA.id && devA.address && !initSnmpPortsA);
      const loadingB = Boolean(devB && devB.id && devB.address && !initSnmpPortsB);

      const bodyHtml = `
        <div style="margin-bottom:12px;font-size:13px" class="muted">
          ${t('Cấu hình cổng vật lý kết nối cho 2 đầu dây cáp. Hỗ trợ cáp đơn (Single), gộp cổng LACP / Port-Channel (Bonding) và đường đồng bộ MLAG Peer-Link.')}
        </div>
        <div class="row" style="gap:14px;margin-bottom:14px;padding:10px 14px;background:var(--panel2);border:1px solid var(--border);border-radius:8px">
          <label class="field inline" style="margin:0;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px">
            <input type="checkbox" id="inp-is-bundle" name="is_bundle" ${curIsBundle ? 'checked' : ''}>
            <span>${t('Liên kết gộp LACP / Bonding')}</span>
          </label>
          <span class="spacer"></span>
          <div class="row" style="gap:6px">
            <label style="font-size:12px;color:var(--muted)" for="inp-link-type">${t('Kiểu liên kết:')}</label>
            <select class="sel" id="inp-link-type" name="link_type" style="padding:5px 10px;font-size:13px">
              <option value="single" ${curLinkType === 'single' ? 'selected' : ''}>${t('Single (Cáp đơn)')}</option>
              <option value="lacp" ${curLinkType === 'lacp' ? 'selected' : ''}>${t('LACP / Port-Channel (Trunk)')}</option>
              <option value="mlag_peer" ${curLinkType === 'mlag_peer' ? 'selected' : ''}>${t('MLAG Peer-Link (Core Switch)')}</option>
            </select>
          </div>
        </div>

        <div id="single-port-section" class="${curIsBundle ? 'hidden' : ''}">
          <div class="field-grid">
            <div class="field">
              <label>${esc(infoA.name)}</label>
              <input class="inp" list="dl-port-a" id="inp-port-a" name="from_port" placeholder="${t('Chọn hoặc nhập cổng (vd: 1, Gi1/0/25)...')}" value="${esc(curFrom)}" autocomplete="off" style="width:100%">
              <datalist id="dl-port-a">${makeDatalistOptions(fallbackCountA, curFrom, initSnmpPortsA)}</datalist>
              <div id="snmp-ports-a" class="muted" style="font-size:11px;margin-top:4px">${makeHintHtml(devA, fallbackCountA, initSnmpPortsA, loadingA)}</div>
            </div>
            <div class="field">
              <label>${esc(infoB.name)}</label>
              <input class="inp" list="dl-port-b" id="inp-port-b" name="to_port" placeholder="${t('Chọn hoặc nhập cổng (vd: 2, ether2)...')}" value="${esc(curTo)}" autocomplete="off" style="width:100%">
              <datalist id="dl-port-b">${makeDatalistOptions(fallbackCountB, curTo, initSnmpPortsB)}</datalist>
              <div id="snmp-ports-b" class="muted" style="font-size:11px;margin-top:4px">${makeHintHtml(devB, fallbackCountB, initSnmpPortsB, loadingB)}</div>
            </div>
          </div>
        </div>

        <div id="lacp-bundle-section" class="${curIsBundle ? '' : 'hidden'}">
          <div class="field">
            <label for="inp-bundle-name">${t('Tên bó cáp / Nhóm LACP (Bundle Name)')}</label>
            <input class="inp" id="inp-bundle-name" name="bundle_name" placeholder="${t('VD: Po1, Bond1...')}" value="${esc(curBundleName)}" maxlength="40" autocomplete="off">
          </div>
          <div class="field-grid">
            <div class="field">
              <label id="lacp-label-a">${makeLacpHeaderText(infoA.name, fallbackCountA, initSnmpPortsA)}</label>
              <div class="lacp-port-grid" id="lacp-ports-a">${makeMultiPortCheckboxes(fallbackCountA, 'src', selectedSrcKeys, initSnmpPortsA)}</div>
              <div id="snmp-lacp-hint-a" class="muted" style="font-size:11px;margin-top:4px">${makeHintHtml(devA, fallbackCountA, initSnmpPortsA, loadingA)}</div>
            </div>
            <div class="field">
              <label id="lacp-label-b">${makeLacpHeaderText(infoB.name, fallbackCountB, initSnmpPortsB)}</label>
              <div class="lacp-port-grid" id="lacp-ports-b">${makeMultiPortCheckboxes(fallbackCountB, 'dst', selectedDstKeys, initSnmpPortsB)}</div>
              <div id="snmp-lacp-hint-b" class="muted" style="font-size:11px;margin-top:4px">${makeHintHtml(devB, fallbackCountB, initSnmpPortsB, loadingB)}</div>
            </div>
          </div>
          <div class="lacp-member-preview" id="lacp-members-preview"></div>
        </div>
      `;

      const { form } = M.modal(t('🔌 Cấu hình cổng kết nối liên kết (Đến 48 Port / LACP / MLAG)'), bodyHtml, (f) => {
        const fd = new FormData(f);
        const isBundleChk = $('#inp-is-bundle', f).checked;
        const linkTypeVal = $('#inp-link-type', f).value;
        const bName = String(fd.get('bundle_name') || '').trim();

        if (isBundleChk || linkTypeVal === 'lacp') {
          const srcChecked = Array.from(f.querySelectorAll('input[name="lacp_src_port"]:checked')).map((el) => el.value);
          const dstChecked = Array.from(f.querySelectorAll('input[name="lacp_dst_port"]:checked')).map((el) => el.value);
          const pairLen = Math.max(srcChecked.length, dstChecked.length);
          const members = [];
          for (let k = 0; k < pairLen; k++) {
            const src = srcChecked[k] || srcChecked[srcChecked.length - 1] || '';
            const dst = dstChecked[k] || dstChecked[dstChecked.length - 1] || '';
            if (src || dst) members.push({ src, dst });
          }
          l.is_bundle = true;
          l.link_type = linkTypeVal === 'mlag_peer' ? 'mlag_peer' : 'lacp';
          l.bundle_name = bName || (l.link_type === 'mlag_peer' ? 'MLAG' : 'Po1');
          l.members = members;
          l.from_port = srcChecked[0] || l.from_port || null;
          l.to_port = dstChecked[0] || l.to_port || null;
        } else {
          const fp = String(fd.get('from_port') || '').trim();
          const tp = String(fd.get('to_port') || '').trim();
          l.is_bundle = false;
          l.link_type = linkTypeVal === 'mlag_peer' ? 'mlag_peer' : 'single';
          l.bundle_name = linkTypeVal === 'mlag_peer' ? (bName || 'MLAG') : '';
          l.members = [];
          l.from_port = fp || null;
          l.to_port = tp || null;
        }
        this.dirty = true;
        this.draw();
        M.toast(t('Đã cập nhật cổng kết nối'));
      }, { submit: t('Lưu cổng'), wide: true });

      const bundleChk = $('#inp-is-bundle', form);
      const linkTypeSel = $('#inp-link-type', form);
      const singleSec = $('#single-port-section', form);
      const lacpSec = $('#lacp-bundle-section', form);
      const previewEl = $('#lacp-members-preview', form);

      const updatePreview = () => {
        const srcChecked = Array.from(form.querySelectorAll('input[name="lacp_src_port"]:checked')).map((el) => el.value);
        const dstChecked = Array.from(form.querySelectorAll('input[name="lacp_dst_port"]:checked')).map((el) => el.value);
        form.querySelectorAll('.lacp-port-chk').forEach((lbl) => {
          const inp = lbl.querySelector('input[type="checkbox"]');
          lbl.classList.toggle('active', Boolean(inp && inp.checked));
        });
        if (!previewEl) return;
        const pairLen = Math.max(srcChecked.length, dstChecked.length);
        if (pairLen === 0) {
          previewEl.innerHTML = `<span class="muted">${t('Chưa chọn cổng thành viên nào. Hãy tích chọn các cổng ở hai cột trên (VD: P23, P24 ↔ P47, P48).')}</span>`;
          return;
        }
        const pairs = [];
        for (let k = 0; k < pairLen; k++) {
          const s = srcChecked[k] || srcChecked[srcChecked.length - 1] || '—';
          const d = dstChecked[k] || dstChecked[dstChecked.length - 1] || '—';
          pairs.push(`<span class="lacp-pair-chip">${esc(s)} ↔ ${esc(d)}</span>`);
        }
        previewEl.innerHTML = `<b>${t('Cặp cổng thành viên')} (${pairLen} links):</b> ${pairs.join(' ')}`;
      };

      const bindCheckboxEvents = (container) => {
        if (!container) return;
        container.querySelectorAll('input[name="lacp_src_port"], input[name="lacp_dst_port"]').forEach((chk) => {
          chk.addEventListener('change', updatePreview);
        });
      };

      const syncBundleMode = (fromCheckbox) => {
        if (fromCheckbox) {
          if (bundleChk.checked && linkTypeSel.value === 'single') {
            linkTypeSel.value = 'lacp';
          } else if (!bundleChk.checked && linkTypeSel.value === 'lacp') {
            linkTypeSel.value = 'single';
          }
        } else {
          if (linkTypeSel.value === 'lacp') {
            bundleChk.checked = true;
          } else if (linkTypeSel.value === 'single') {
            bundleChk.checked = false;
          }
        }
        const showBundle = bundleChk.checked || linkTypeSel.value === 'lacp';
        singleSec.classList.toggle('hidden', showBundle);
        lacpSec.classList.toggle('hidden', !showBundle);
        updatePreview();
      };

      bundleChk.addEventListener('change', () => syncBundleMode(true));
      linkTypeSel.addEventListener('change', () => syncBundleMode(false));
      bindCheckboxEvents(form);
      updatePreview();

      // Async enrich with real SNMP physical ports: replaces the 48-port fallback suggestion list when SNMP succeeds
      const enrichWithSnmp = async (dev, infoName, side, fallbackCount, curSingleVal, initSelectedKeys, ids) => {
        if (!dev || !dev.id || !dev.address) return;
        const dl = $(`#${ids.datalistId}`, form);
        const hint = $(`#${ids.hintId}`, form);
        const lacpLabel = $(`#${ids.lacpLabelId}`, form);
        const lacpGrid = $(`#${ids.lacpGridId}`, form);
        const lacpHint = $(`#${ids.lacpHintId}`, form);
        try {
          const res = await M.api('GET', `/api/devices/${dev.id}/ports`);
          if (res && Array.isArray(res.ports) && res.ports.length > 0) {
            M.S.snmpPorts.set(dev.id, { at: Date.now(), ports: res.ports });
            if (dl) {
              const singleInp = $(`#${ids.inputId}`, form);
              const curVal = (singleInp && singleInp.value) || curSingleVal;
              dl.innerHTML = makeDatalistOptions(fallbackCount, curVal, res.ports);
            }
            if (lacpLabel) {
              lacpLabel.innerHTML = makeLacpHeaderText(infoName, fallbackCount, res.ports);
            }
            if (lacpGrid) {
              // Preserve any selections currently checked in the modal or from initial link state
              const currentChecked = Array.from(lacpGrid.querySelectorAll(`input[name="lacp_${side}_port"]:checked`))
                .map((el) => normalizePortKey(el.value))
                .filter(Boolean);
              const activeKeys = new Set([...initSelectedKeys, ...currentChecked]);
              lacpGrid.innerHTML = makeMultiPortCheckboxes(fallbackCount, side, activeKeys, res.ports);
              bindCheckboxEvents(lacpGrid);
              updatePreview();
            }
            const okHtml = makeHintHtml(dev, fallbackCount, res.ports, false);
            if (hint) hint.innerHTML = okHtml;
            if (lacpHint) lacpHint.innerHTML = okHtml;
          } else {
            // SNMP returned 0 physical ports -> keep fallback suggestion table
            const warnHtml = makeHintHtml(dev, fallbackCount, null, false);
            if (hint) hint.innerHTML = warnHtml;
            if (lacpHint) lacpHint.innerHTML = warnHtml;
          }
        } catch {
          // SNMP failed / timed out -> keep 48-port fallback suggestion table
          const cached = M.S.snmpPorts && M.S.snmpPorts.get(dev.id);
          const ports = cached && Array.isArray(cached.ports) && cached.ports.length > 0 ? cached.ports : null;
          const warnHtml = makeHintHtml(dev, fallbackCount, ports, false);
          if (hint) hint.innerHTML = warnHtml;
          if (lacpHint) lacpHint.innerHTML = warnHtml;
        }
      };

      enrichWithSnmp(devA, infoA.name, 'src', fallbackCountA, curFrom, selectedSrcKeys, {
        inputId: 'inp-port-a',
        datalistId: 'dl-port-a',
        hintId: 'snmp-ports-a',
        lacpLabelId: 'lacp-label-a',
        lacpGridId: 'lacp-ports-a',
        lacpHintId: 'snmp-lacp-hint-a',
      });
      enrichWithSnmp(devB, infoB.name, 'dst', fallbackCountB, curTo, selectedDstKeys, {
        inputId: 'inp-port-b',
        datalistId: 'dl-port-b',
        hintId: 'snmp-ports-b',
        lacpLabelId: 'lacp-label-b',
        lacpGridId: 'lacp-ports-b',
        lacpHintId: 'snmp-lacp-hint-b',
      });
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

    // Shared renderer for Single Link, LACP Port-Channel Bundle, and MLAG Peer Link
    renderLinkItem(l, i, a, b, ia, ib, opts = {}) {
      const editable = !!opts.editable;
      const sel = !!opts.selected;
      const onSnmpReady = opts.onSnmpReady;

      const isMlag = l.link_type === 'mlag_peer';
      const isBundle = Boolean(l.is_bundle || l.link_type === 'lacp');

      if ((isBundle || isMlag) && ia && ia.rawDevice) requestDeviceSnmpPorts(ia.rawDevice, onSnmpReady);
      if ((isBundle || isMlag) && ib && ib.rawDevice) requestDeviceSnmpPorts(ib.rawDevice, onSnmpReady);

      const health = evaluateLinkHealth(l, ia, ib);
      const { state, badgeState, stroke, upCount, totalCount, memberDetails } = health;
      const isDown = state === 'down';
      const isDegraded = state === 'degraded';

      // Chuẩn hóa neo đường dây
      const { x1, y1, x2, y2 } = getLinkEndpoints(a, b, l.link_type);
      const ptA = { x: x1, y: y1 };
      const ptB = { x: x2, y: y2 };

      // Xác định hiển thị cổng vật lý 2 đầu (giữ nguyên cho cáp đơn, gộp cụm thông minh cho LACP)
      let pLblA = '';
      let pLblB = '';
      let rawTitleA = '';
      let rawTitleB = '';

      if (isBundle || (isMlag && Array.isArray(l.members) && l.members.length > 0)) {
        const srcPorts = Array.isArray(l.members) && l.members.length
          ? l.members.map((m) => m && m.src).filter(Boolean)
          : (l.from_port ? [l.from_port] : []);
        const dstPorts = Array.isArray(l.members) && l.members.length
          ? l.members.map((m) => m && m.dst).filter(Boolean)
          : (l.to_port ? [l.to_port] : []);
        pLblA = formatBundlePortsBadgeLabel(srcPorts);
        pLblB = formatBundlePortsBadgeLabel(dstPorts);
        rawTitleA = srcPorts.join(', ');
        rawTitleB = dstPorts.join(', ');
      } else {
        pLblA = l.from_port ? formatPortBadgeLabel(l.from_port) : '';
        pLblB = l.to_port ? formatPortBadgeLabel(l.to_port) : '';
        rawTitleA = l.from_port || '';
        rawTitleB = l.to_port || '';
      }

      const dataLinkAttr = i !== undefined && i !== null ? `data-link="${i}"` : '';
      let badgesHtml = '';
      const bh = 17;
      const maxBadgeRatio = (isBundle || isMlag) ? 0.26 : 0.35;
      const badgeDist = (isBundle || isMlag) ? 20 : 18;

      if (pLblA) {
        const bCoordA = getBadgeCoords(ptA, ptB, badgeDist, maxBadgeRatio);
        const bwA = Math.max(28, Math.min(78, pLblA.length * 6.8 + 10));
        badgesHtml += `
          <g class="m-port-badge" ${dataLinkAttr} transform="translate(${bCoordA.x - bwA / 2}, ${bCoordA.y - bh / 2})">
            <rect width="${bwA}" height="${bh}" rx="4" class="m-port-badge-bg ${badgeState}"/>
            <text x="${bwA / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblA)}</text>
            <title>${esc(t('Cổng'))}: ${esc(rawTitleA)} (${esc(ia ? ia.name : '')})</title>
          </g>
        `;
      }

      if (pLblB) {
        const bCoordB = getBadgeCoords(ptB, ptA, badgeDist, maxBadgeRatio);
        const bwB = Math.max(28, Math.min(78, pLblB.length * 6.8 + 10));
        badgesHtml += `
          <g class="m-port-badge" ${dataLinkAttr} transform="translate(${bCoordB.x - bwB / 2}, ${bCoordB.y - bh / 2})">
            <rect width="${bwB}" height="${bh}" rx="4" class="m-port-badge-bg ${badgeState}"/>
            <text x="${bwB / 2}" y="${bh / 2 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text)">${esc(pLblB)}</text>
            <title>${esc(t('Cổng'))}: ${esc(rawTitleB)} (${esc(ib ? ib.name : '')})</title>
          </g>
        `;
      }

      // Xây dựng Tooltip chi tiết
      let tooltip = `${ia ? ia.name : ''}${rawTitleA ? ` [Port ${rawTitleA}]` : ''} ➔ ${ib ? ib.name : ''}${rawTitleB ? ` [Port ${rawTitleB}]` : ''}`;
      if (isBundle || isMlag) {
        const bName = (l.bundle_name && String(l.bundle_name).trim()) ? String(l.bundle_name).trim() : (isMlag ? 'MLAG' : 'Po1');
        const linkCnt = (Array.isArray(l.members) && l.members.length > 0) ? l.members.length : (totalCount || 2);
        const stateLabel = isDown ? 'DOWN' : (isDegraded ? `DEGRADED (${upCount}/${linkCnt} UP)` : `UP (${linkCnt}/${linkCnt} UP)`);
        const memberStr = memberDetails.length
          ? ` · Members: ${memberDetails.map((m) => `${m.src}↔${m.dst} [${m.status.toUpperCase()}]`).join(', ')}`
          : '';
        tooltip = `[${isMlag ? 'MLAG Peer' : 'LACP'} ${bName}: ${linkCnt} links — ${stateLabel}] ${tooltip}${memberStr}`;

        // Badge trung tâm đường cáp: hiển thị tên bó cáp kèm số cổng (Ví dụ: "Po1: 2 links")
        const mx = Math.round(((x1 + x2) / 2) * 10) / 10;
        const my = Math.round(((y1 + y2) / 2) * 10) / 10;
        const centerText = `${bName}: ${linkCnt} ${linkCnt === 1 ? 'link' : 'links'}`;
        const cw = Math.max(68, Math.min(148, centerText.length * 6.8 + 16));
        const ch = 19;
        badgesHtml += `
          <g class="m-lacp-badge" ${dataLinkAttr} transform="translate(${mx - cw / 2}, ${my - ch / 2})">
            <rect width="${cw}" height="${ch}" rx="9" class="m-lacp-badge-bg ${badgeState}"/>
            <text x="${cw / 2}" y="${ch / 2 + 3.5}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">${esc(centerText)}</text>
            <title>${esc(tooltip)}</title>
          </g>
        `;
      }

      const selStyle = sel ? ';stroke-width:6;filter:drop-shadow(0 0 6px var(--accent))' : '';
      const hitAreaHtml = editable ? `<line data-link="${i}" stroke="transparent" stroke-width="22" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="cursor:pointer"/>` : '';

      // 1. Đường MLAG Peer: Vẽ đường nét đứt đôi nối ngang giữa 2 Switch Core
      if (isMlag) {
        const { line1, line2 } = getParallelLines(x1, y1, x2, y2, 3.5);
        const stCls = isDown ? 'down' : (isDegraded ? 'degraded' : 'up');
        return `
          <g class="m-link-bundle m-link-mlag-group ${stCls}" ${dataLinkAttr}>
            <line class="m-link m-link-mlag ${stCls}" style="stroke:${stroke}${selStyle}" stroke-dasharray="8 5" x1="${line1.x1}" y1="${line1.y1}" x2="${line1.x2}" y2="${line1.y2}">
              <title>${esc(tooltip)}</title>
            </line>
            <line class="m-link m-link-mlag ${stCls}" style="stroke:${stroke}${selStyle}" stroke-dasharray="8 5" x1="${line2.x1}" y1="${line2.y1}" x2="${line2.x2}" y2="${line2.y2}">
              <title>${esc(tooltip)}</title>
            </line>
            ${!isDown ? `<line class="m-link-flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` : ''}
          </g>
          ${hitAreaHtml}
          ${badgesHtml}
        `;
      }

      // 2. Đường LACP Bundle (is_bundle = true): Vẽ đường cáp đôi (2 nét song song chạy sát nhau)
      if (isBundle) {
        const { line1, line2 } = getParallelLines(x1, y1, x2, y2, 3.5);
        const stCls = isDown ? 'down' : (isDegraded ? 'degraded' : 'up');
        return `
          <g class="m-link-bundle ${stCls}" ${dataLinkAttr}>
            <line class="m-link m-link-lacp ${stCls}" style="stroke:${stroke}${selStyle}" x1="${line1.x1}" y1="${line1.y1}" x2="${line1.x2}" y2="${line1.y2}">
              <title>${esc(tooltip)}</title>
            </line>
            <line class="m-link m-link-lacp ${stCls}" style="stroke:${stroke}${selStyle}" x1="${line2.x1}" y1="${line2.y1}" x2="${line2.x2}" y2="${line2.y2}">
              <title>${esc(tooltip)}</title>
            </line>
            ${!isDown ? `
              <line class="m-link-flow" x1="${line1.x1}" y1="${line1.y1}" x2="${line1.x2}" y2="${line1.y2}"/>
              <line class="m-link-flow" x1="${line2.x1}" y1="${line2.y1}" x2="${line2.x2}" y2="${line2.y2}"/>
            ` : ''}
          </g>
          ${hitAreaHtml}
          ${badgesHtml}
        `;
      }

      // 3. Đường dây đơn bình thường (is_bundle = false): Giữ nguyên cách vẽ 1 sợi dây + hiệu ứng dòng dữ liệu khi UP
      return `
        <line class="m-link ${isDown ? 'down' : 'up'}" style="stroke:${stroke}${selStyle}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
          <title>${esc(tooltip)}</title>
        </line>
        ${!isDown ? `<line class="m-link-flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` : ''}
        ${hitAreaHtml}
        ${badgesHtml}
      `;
    },

    draw() {
      const svg = $('#mp-svg');
      if (!svg || !this.m) return;
      const m = this.m;
      const nodes = new Map(m.nodes.map((n) => [n.id, n]));
      const infos = new Map(m.nodes.map((n) => [n.id, this.info(n)]));
      $('#mp-box').classList.toggle('editing', this.edit);

      // Render Clean Top-Down Links with Snap-to-Device Port Badges & LACP / MLAG support
      const linksHtml = m.links.map((l, i) => {
        const a = nodes.get(l.from), b = nodes.get(l.to);
        if (!a || !b) return '';
        const ia = infos.get(a.id), ib = infos.get(b.id);
        const sel = this.sel && this.sel.type === 'link' && this.sel.index === i;
        return this.renderLinkItem(l, i, a, b, ia, ib, {
          editable: this.edit,
          selected: sel,
          onSnmpReady: () => { if (this.m && !this.drag) this.draw(); },
        });
      }).join('');

      const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

      // Render Node Cards sạch sẽ, thanh lịch (Glassmorphism + Soft Glow / Pulse)
      const nodeSvg = m.nodes.map((n) => {
        const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
        const sel = (this.sel && this.sel.type === 'node' && this.sel.id === n.id) || this.linkFrom === n.id;

        if (n.kind === 'label') {
          return `<g class="m-node m-label ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
            <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
        }

        const isNetDevice = n.kind === 'device' && i.rawDevice && isSnmpCapableDevice(i.rawDevice);

        // Nút mở Port Inspector chi tiết ở góc trên phải nếu là thiết bị mạng
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
            <text x="12" y="37" font-size="22">${i.icon}</text>
            <text x="42" y="27" font-size="15" font-weight="700">${esc(trunc(i.name, isNetDevice ? 14 : 17))}</text>
            <text class="m-sub" x="42" y="47">${esc(trunc(i.sub, 18))}</text>
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
                this.m.links.push({
                  from: this.linkFrom,
                  to: n.id,
                  from_port: null,
                  to_port: null,
                  is_bundle: false,
                  bundle_name: '',
                  members: [],
                  link_type: 'single',
                });
                const newIdx = this.m.links.length - 1;
                this.sel = { type: 'link', index: newIdx };
                this.dirty = true;
                this.linkFrom = null;
                this.tools();
                this.draw();
                this.openLinkConfigModal(newIdx);
                return;
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

      // Double-click on link to configure wire ports
      svg.addEventListener('dblclick', (e) => {
        if (!this.edit || !this.m) return;
        const lk = e.target.closest('[data-link]');
        if (lk) {
          this.openLinkConfigModal(Number(lk.dataset.link));
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

  // Reusable lightweight SVG map renderer (dashboard, secondary views)
  M.renderMapSvg = (svg, m) => {
    if (!svg || !m) return;
    const nodes = new Map((m.nodes || []).map((n) => [n.id, n]));
    const infos = new Map((m.nodes || []).map((n) => [n.id, M.views.map.info(n)]));

    const links = (m.links || []).map((l, i) => {
      const a = nodes.get(l.from), b = nodes.get(l.to);
      if (!a || !b) return '';
      const ia = infos.get(a.id), ib = infos.get(b.id);
      return M.views.map.renderLinkItem(l, i, a, b, ia, ib, {
        editable: false,
        selected: false,
        onSnmpReady: () => { if (document.body.contains(svg)) M.renderMapSvg(svg, m); },
      });
    }).join('');

    const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
    const nodeSvg = (m.nodes || []).map((n) => {
      const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
      if (n.kind === 'label') {
        return `<g class="m-node m-label" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
          <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
      }

      return `
        <g class="m-node ${i.cls}" data-id="${n.id}" data-href="${i.href || ''}" style="cursor:pointer" transform="translate(${n.x - NW / 2},${n.y - NH / 2})">
          <rect width="${NW}" height="${NH}" rx="10"/>
          <text x="12" y="37" font-size="22">${i.icon}</text>
          <text x="42" y="27" font-size="15" font-weight="700">${esc(trunc(i.name, 17))}</text>
          <text class="m-sub" x="42" y="47">${esc(trunc(i.sub, 18))}</text>
        </g>
      `;
    }).join('');

    svg.innerHTML = links + nodeSvg;
  };
})();
