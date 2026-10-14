'use strict';
// Topology maps: live status view + drag & drop editor.
(() => {
  const { esc, $ } = M;
  const W = 1600, H = 900, NW = 176, NH = 60;
  const canEdit = () => M.S.user.role !== 'viewer';
  const COL = { critical: 'var(--c-critical)', high: 'var(--c-high)', medium: 'var(--c-medium)', low: 'var(--c-low)', up: 'var(--c-ok)', unknown: 'var(--c-unknown)', none: 'var(--muted)' };
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

  M.views.maps = {
    async render(el) {
      await M.loadMaps();
      el.innerHTML = `<div class="row"><h1>Sơ đồ topology</h1><span class="spacer"></span>
        ${canEdit() ? '<button class="btn primary" id="mp-add">+ Tạo sơ đồ</button>' : ''}</div>
        <div class="grid">${M.S.maps.map((m) => `<a class="tile up" href="#/map/${m.id}"><div class="t-top"><span class="t-ico">🗺️</span><span class="t-name">${esc(m.name)}</span></div></a>`).join('')
    || '<div class="muted">Chưa có sơ đồ nào.</div>'}</div>`;
      const add = $('#mp-add');
      if (add) add.onclick = () => M.modal('Tạo sơ đồ', '<div class="field"><label>Tên sơ đồ</label><input class="inp" name="name" maxlength="80" required></div>', async (f) => {
        const r = await M.api('POST', '/api/maps', { name: new FormData(f).get('name'), nodes: [], links: [] });
        M.S.mapEdit = true;
        location.hash = `#/map/${r.id}`;
      }, { submit: 'Tạo' });
    },
  };

  const uid = () => `n${Math.random().toString(36).slice(2, 10)}`;

  M.views.map = {
    async render(el, id) {
      const m = await M.api('GET', `/api/maps/${id}`);
      this.m = m;
      this.edit = !!M.S.mapEdit && canEdit();
      M.S.mapEdit = false;
      this.sel = null; this.linkMode = false; this.linkFrom = null; this.drag = null; this.dirty = false;
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
      const t = $('#mp-tools');
      if (!canEdit()) { t.innerHTML = ''; return; }
      if (!this.edit) {
        t.innerHTML = '<button class="btn" id="mp-edit">✏️ Chỉnh sửa</button>';
        $('#mp-edit').onclick = () => { this.edit = true; this.tools(); this.draw(); };
        return;
      }
      const onMap = new Set(m.nodes.filter((n) => n.kind === 'device').map((n) => n.ref));
      const gOn = new Set(m.nodes.filter((n) => n.kind === 'group').map((n) => n.ref));
      const devOpts = M.S.snap ? M.S.snap.devices.filter((d) => !onMap.has(d.id)).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('') : '';
      const grpOpts = M.S.groups.filter((g) => !gOn.has(g.id)).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      t.innerHTML = `<select class="sel" id="mp-dev"><option value="">+ Thiết bị…</option>${devOpts}</select>
        <select class="sel" id="mp-grp"><option value="">+ Nhóm…</option>${grpOpts}</select>
        <button class="btn" id="mp-lbl">+ Nhãn</button>
        <button class="btn ${this.linkMode ? 'primary' : ''}" id="mp-link">🔗 Nối dây</button>
        <button class="btn" id="mp-ren">Đổi tên</button>
        <button class="btn danger" id="mp-del">Xóa mục chọn</button>
        <button class="btn primary" id="mp-save">💾 Lưu</button><button class="btn" id="mp-cancel">Đóng</button>
        <button class="btn danger" id="mp-rm">Xóa sơ đồ</button>`;
      const add = (node) => { m.nodes.push({ id: uid(), x: 200 + (m.nodes.length % 8) * 40, y: 120 + (m.nodes.length % 8) * 40, ...node }); this.dirty = true; this.tools(); this.draw(); };
      $('#mp-dev').onchange = (e) => { if (e.target.value) add({ kind: 'device', ref: Number(e.target.value), label: '' }); };
      $('#mp-grp').onchange = (e) => { if (e.target.value) add({ kind: 'group', ref: Number(e.target.value), label: '' }); };
      $('#mp-lbl').onclick = () => add({ kind: 'label', ref: null, label: 'Nhãn mới' });
      $('#mp-link').onclick = () => { this.linkMode = !this.linkMode; this.linkFrom = null; this.tools(); this.draw(); if (this.linkMode) M.toast('Bấm lần lượt 2 thiết bị để nối dây'); };
      $('#mp-ren').onclick = () => {
        const n = this.sel && this.sel.type === 'node' && m.nodes.find((x) => x.id === this.sel.id);
        if (!n || n.kind !== 'label') return M.toast('Chọn một nhãn để đổi tên');
        M.modal('Đổi tên nhãn', `<div class="field"><input class="inp" name="l" maxlength="80" value="${esc(n.label)}" required></div>`, (f) => { n.label = new FormData(f).get('l'); this.dirty = true; this.draw(); });
      };
      $('#mp-del').onclick = () => {
        if (!this.sel) return M.toast('Chưa chọn mục nào');
        if (this.sel.type === 'node') {
          m.nodes = m.nodes.filter((n) => n.id !== this.sel.id);
          m.links = m.links.filter((l) => l.from !== this.sel.id && l.to !== this.sel.id);
        } else m.links.splice(this.sel.index, 1);
        this.sel = null; this.dirty = true; this.tools(); this.draw();
      };
      $('#mp-save').onclick = async () => {
        await M.api('PUT', `/api/maps/${m.id}`, { name: m.name, nodes: m.nodes, links: m.links });
        this.dirty = false; M.toast('Đã lưu sơ đồ');
      };
      $('#mp-cancel').onclick = async () => {
        const go = async () => { this.m = await M.api('GET', `/api/maps/${m.id}`); this.edit = false; this.sel = null; this.linkMode = false; this.tools(); this.draw(); };
        if (this.dirty) M.confirm('Bỏ các thay đổi chưa lưu?', go); else go();
      };
      $('#mp-rm').onclick = () => M.confirm(`Xóa sơ đồ "${m.name}"?`, async () => { await M.api('DELETE', `/api/maps/${m.id}`); location.hash = '#/maps'; });
    },

    // Resolve a node to display info + status class from live data
    info(n) {
      const snap = M.S.snap;
      if (n.kind === 'label') return { name: n.label, sub: '', cls: 'label', rank: 'unknown', icon: '' };
      if (n.kind === 'device') {
        const d = snap && snap.devices.find((x) => x.id === n.ref);
        if (!d) return { name: '(đã xóa)', sub: '', cls: '', rank: 'unknown', icon: '❓' };
        return { name: d.name, sub: M.STATE_NAME[d.status], cls: M.statusClass(d), icon: M.ICON[d.type] || '', rank: d.status === 'down' ? d.severity : d.status === 'warning' ? 'medium' : d.status === 'up' ? 'up' : 'unknown', href: `#/device/${d.id}` };
      }
      const g = M.S.groups.find((x) => x.id === n.ref);
      if (!g) return { name: '(đã xóa)', sub: '', cls: '', rank: 'unknown', icon: '❓' };
      const list = snap ? snap.devices.filter((d) => d.groups.includes(g.id)) : [];
      const s = M.summarize(list);
      const downs = list.filter((d) => d.status === 'down');
      const worst = downs.reduce((a, d) => (SEV_RANK[d.severity] > SEV_RANK[a] ? d.severity : a), 'low');
      const cls = downs.length ? `down sev-${worst}` : s.warning ? 'warning' : s.total && s.unknown < s.total ? 'up' : '';
      return { name: g.name, sub: `${s.alive}/${s.total} hoạt động`, cls, icon: '🗂️', rank: downs.length ? worst : s.warning ? 'medium' : cls === 'up' ? 'up' : 'unknown', href: `#/group/${g.id}` };
    },

    draw() {
      const svg = $('#mp-svg');
      if (!svg || !this.m) return;
      const m = this.m;
      const nodes = new Map(m.nodes.map((n) => [n.id, n]));
      const infos = new Map(m.nodes.map((n) => [n.id, this.info(n)]));
      $('#mp-box').classList.toggle('editing', this.edit);
      const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);
      const links = m.links.map((l, i) => {
        const a = nodes.get(l.from), b = nodes.get(l.to);
        if (!a || !b) return '';
        const ia = infos.get(a.id), ib = infos.get(b.id);
        const r = score(ia.rank) >= score(ib.rank) ? ia.rank : ib.rank;
        const bad = SEV_RANK[r];
        const sel = this.sel && this.sel.type === 'link' && this.sel.index === i;
        return `<line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r]}${sel ? ';stroke-width:7' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>
          ${this.edit ? `<line data-link="${i}" stroke="transparent" stroke-width="18" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" style="cursor:pointer"/>` : ''}`;
      }).join('');
      const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
      const nodeSvg = m.nodes.map((n) => {
        const i = infos.get(n.id);
        const sel = (this.sel && this.sel.type === 'node' && this.sel.id === n.id) || this.linkFrom === n.id;
        if (n.kind === 'label') {
          return `<g class="m-node m-label ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
            <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
        }
        return `<g class="m-node ${i.cls} ${sel ? 'sel' : ''}" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - NH / 2})">
          <rect width="${NW}" height="${NH}" rx="10"/><text x="12" y="27" font-size="22">${i.icon}</text>
          <text x="42" y="26" font-size="16" font-weight="700">${esc(trunc(i.name, 17))}</text><text class="m-sub" x="42" y="46">${esc(i.sub)}</text></g>`;
      }).join('');
      svg.innerHTML = links + nodeSvg;
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
        const g = e.target.closest('[data-id]');
        const lk = e.target.closest('[data-link]');
        if (!this.edit) { return; }
        if (g) {
          const n = this.m.nodes.find((x) => x.id === g.dataset.id);
          if (this.linkMode) {
            if (!this.linkFrom) this.linkFrom = n.id;
            else if (this.linkFrom !== n.id) {
              const dup = this.m.links.some((l) => (l.from === this.linkFrom && l.to === n.id) || (l.from === n.id && l.to === this.linkFrom));
              if (!dup) { this.m.links.push({ from: this.linkFrom, to: n.id }); this.dirty = true; }
              this.linkFrom = null;
            }
          } else {
            this.sel = { type: 'node', id: n.id };
            const p = pt(e);
            this.drag = { n, dx: n.x - p.x, dy: n.y - p.y };
            svg.setPointerCapture(e.pointerId);
          }
        } else if (lk) this.sel = { type: 'link', index: Number(lk.dataset.link) };
        else { this.sel = null; this.linkFrom = null; }
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

  M.renderMapSvg = (svg, m) => {
    if (!svg || !m) return;
    const nodes = new Map(m.nodes.map((n) => [n.id, n]));
    const infos = new Map(m.nodes.map((n) => [n.id, M.views.map.info(n)]));
    const score = (r) => (SEV_RANK[r] ? 10 + SEV_RANK[r] : r === 'up' ? 1 : 0);
    const links = (m.links || []).map((l) => {
      const a = nodes.get(l.from), b = nodes.get(l.to);
      if (!a || !b) return '';
      const ia = infos.get(a.id), ib = infos.get(b.id);
      const r = score(ia ? ia.rank : 'unknown') >= score(ib ? ib.rank : 'unknown') ? (ia ? ia.rank : 'unknown') : (ib ? ib.rank : 'unknown');
      const bad = SEV_RANK[r];
      return `<line class="m-link ${bad ? 'down' : ''}" style="stroke:${COL[r] || 'var(--c-ok)'}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    }).join('');
    const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
    const nodeSvg = (m.nodes || []).map((n) => {
      const i = infos.get(n.id) || { name: '', sub: '', cls: '', icon: '' };
      if (n.kind === 'label') {
        return `<g class="m-node m-label" data-id="${n.id}" transform="translate(${n.x - NW / 2},${n.y - 22})">
          <rect width="${NW}" height="44" rx="8"/><text x="${NW / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(trunc(i.name, 22))}</text></g>`;
      }
      return `<g class="m-node ${i.cls}" data-id="${n.id}" data-href="${i.href || ''}" style="cursor:pointer" transform="translate(${n.x - NW / 2},${n.y - NH / 2})">
        <rect width="${NW}" height="${NH}" rx="10"/><text x="12" y="27" font-size="22">${i.icon}</text>
        <text x="42" y="26" font-size="16" font-weight="700">${esc(trunc(i.name, 17))}</text><text class="m-sub" x="42" y="46">${esc(i.sub)}</text></g>`;
    }).join('');
    svg.innerHTML = links + nodeSvg;
  };
})();
