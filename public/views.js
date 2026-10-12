'use strict';
(() => {
  const { esc, $ } = M;
  const th = () => M.S.settings.thresholds;
  const devs = () => (M.S.snap ? M.S.snap.devices : []);
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const STATE_RANK = { down: 0, warning: 1, unknown: 2, up: 3, maint: 4 };

  const defaultSort = (a, b) =>
    STATE_RANK[a.status] - STATE_RANK[b.status] ||
    (a.status === 'down' ? SEV_RANK[b.severity] - SEV_RANK[a.severity] : 0) ||
    a.name.localeCompare(b.name);

  const sortDevices = (list) => {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    if (Array.isArray(saved) && saved.length) {
      const orderMap = new Map(saved.map((id, idx) => [Number(id), idx]));
      return [...list].sort((a, b) => {
        const ia = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
        const ib = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;
        if (ia !== ib) return ia - ib;
        return defaultSort(a, b);
      });
    }
    return [...list].sort(defaultSort);
  };

  // ---------- shared widgets ----------
  const level = (v, key) => (v >= th()[key] ? 'crit' : v >= th()[key] - 10 ? 'hi' : '');
  const bar = (label, v, key) => `<div class="bar ${level(v, key)}">${label} ${Math.round(v)}%<i><b style="width:${Math.min(100, v)}%"></b></i></div>`;

  M.tile = (d) => {
    const ago = M.fmtDur((Date.now() - d.since) / 1000);
    let sub;
    if (d.status === 'down') sub = `${d.reasons[0] || 'Mất kết nối'} · ${ago}`;
    else if (d.status === 'warning') sub = d.reasons[0];
    else if (d.status === 'maint') sub = 'Đang bảo trì (tắt cảnh báo)';
    else if (d.status === 'unknown') sub = 'Chưa có dữ liệu';
    else sub = [d.address, d.rtt != null ? `${d.rtt} ms` : null, d.uptime != null ? `up ${M.fmtDur(d.uptime)}` : null].filter(Boolean).join(' · ');
    let bars = '';
    if (d.status === 'up' || d.status === 'warning') {
      const metrics = [['CPU', d.cpu, 'cpu'], ['RAM', d.ram, 'ram'], ['Disk', d.disk, 'disk']]
        .filter(([, value]) => value != null);
      if (metrics.length) bars = `<div class="bars">${metrics.map(([label, value, key]) => bar(label, value, key)).join('')}</div>`;
      else if (d.toner != null) bars = `<div class="bars"><div class="bar ${d.toner <= 10 ? 'crit' : d.toner <= 25 ? 'hi' : ''}">Mực ${d.toner}%<i><b style="width:${d.toner}%"></b></i></div></div>`;
    }
    return `<a class="tile ${M.statusClass(d)}" href="#/device/${d.id}" data-id="${d.id}" draggable="false">
      <div class="t-top"><span class="t-ico">${M.ICON[d.type] || ''}</span><span class="t-name" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="t-state">${M.STATE_NAME[d.status]}</span></div><div class="t-sub" title="${esc(sub)}">${esc(sub)}</div>${bars}</a>`;
  };

  const groupDevices = (g) => devs().filter((d) => d.groups.includes(g.id));
  const groupClass = (list) => {
    const s = M.summarize(list);
    if (!s.total) return { s, cls: '' };
    const downs = list.filter((d) => d.status === 'down');
    if (downs.length) return { s, cls: `down sev-${downs.reduce((m, d) => (SEV_RANK[d.severity] > SEV_RANK[m] ? d.severity : m), 'low')}` };
    if (s.warning) return { s, cls: 'warning' };
    return { s, cls: s.unknown === s.total ? '' : 'up' };
  };
  M.groupTile = (g) => {
    const { s, cls } = groupClass(groupDevices(g));
    return `<a class="tile group ${cls}" href="#/group/${g.id}"><div class="t-top"><span class="t-ico">🗂️</span>
      <span class="t-name">${esc(g.name)}</span><span class="t-state">${s.down ? `${s.down} down` : s.warning ? `${s.warning} cảnh báo` : s.total ? 'Ổn định' : 'Trống'}</span></div>
      <div class="g-count">${s.alive}<small>/${s.total}</small></div><div class="t-sub">${esc(g.description || '')}</div></a>`;
  };

  M.gauge = (label, v, key, sub) => {
    const C = 2 * Math.PI * 52;
    const lv = level(v, key);
    const col = lv === 'crit' ? 'var(--c-critical)' : lv === 'hi' ? 'var(--c-medium)' : 'var(--c-ok)';
    return `<div class="gauge"><svg viewBox="0 0 130 130"><circle cx="65" cy="65" r="52" fill="none" stroke="var(--panel2)" stroke-width="12"/>
      <circle cx="65" cy="65" r="52" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(v / 100) * C} ${C}" transform="rotate(-90 65 65)"/>
      <text x="65" y="74" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text)">${Math.round(v)}%</text></svg>
      <div class="g-label">${label}${sub ? `<br>${sub}` : ''}</div></div>`;
  };

  M.chart = (pts, series, range, max, fmtY) => {
    const W = 600, H = 170, L = fmtY ? 54 : 34, R = 8, T = 8, B = 20;
    if (pts.length < 2) return '<div class="muted" style="padding:30px;text-align:center">Chưa đủ dữ liệu lịch sử</div>';
    const x0 = pts[0].ts, x1 = pts[pts.length - 1].ts;
    const yMax = max || Math.max(1, ...series.flatMap((s) => pts.map((p) => p[s.key] ?? 0))) * 1.2;
    const sx = (t) => L + (W - L - R) * ((t - x0) / (x1 - x0 || 1));
    const sy = (v) => T + (H - T - B) * (1 - v / yMax);
    const paths = series.map((s) => {
      let d = '', pen = false;
      for (const p of pts) {
        if (p[s.key] == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${sx(p.ts).toFixed(1)} ${sy(p[s.key]).toFixed(1)}`;
        pen = true;
      }
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }).join('');
    const fmt = (t) => new Date(t).toLocaleString('vi-VN', range === '7d' || range === '24h' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    const formatY = fmtY || ((v) => Math.round(v));
    const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${sy(yMax * f)}" y2="${sy(yMax * f)}"/><text x="${L - 4}" y="${sy(yMax * f) + 3}" text-anchor="end">${formatY(yMax * f)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}
      <text x="${L}" y="${H - 4}">${fmt(x0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${fmt(x1)}</text></svg>
      <div class="legend">${series.map((s) => `<span style="--lc:${s.color}">${s.label}</span>`).join('')}</div>`;
  };

  M.eventsTable = (events, showDevice) => {
    if (!events.length) return '<div class="muted">Chưa có sự kiện</div>';
    const badge = (e) => (e.kind === 'audit' ? 'ok' : e.severity);
    const label = { down: 'Mất kết nối', up: 'Phục hồi', warning: 'Cảnh báo', audit: 'Hệ thống' };
    return `<table class="tbl"><thead><tr><th>Thời gian</th>${showDevice ? '<th>Thiết bị</th>' : ''}<th>Loại</th><th>Nội dung</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${M.fmtTime(e.ts)}</td>${showDevice ? `<td>${e.device_id ? `<a href="#/device/${e.device_id}">${esc(e.device_name)}</a>` : esc(e.device_name)}</td>` : ''}
      <td><span class="sev-badge ${badge(e)}">${label[e.kind] || e.kind}</span></td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table>`;
  };

  // ---------- dashboard ----------
  const F = { q: '', status: '', type: '' };
  let isDragging = false;
  let draggedId = null;

  function saveDeviceOrder(visibleIds) {
    const snap = M.S.snap;
    if (!snap || !snap.devices) return;
    const allIds = snap.devices.map((d) => d.id);
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    if (!saved.length) saved = sortDevices(snap.devices).map((d) => d.id);
    else {
      const set = new Set(allIds);
      saved = saved.filter((id) => set.has(id));
      for (const id of allIds) if (!saved.includes(id)) saved.push(id);
    }
    const visSet = new Set(visibleIds);
    const slots = [];
    for (let i = 0; i < saved.length; i++) {
      if (visSet.has(saved[i])) slots.push(i);
    }
    for (let i = 0; i < slots.length && i < visibleIds.length; i++) {
      saved[slots[i]] = visibleIds[i];
    }
    localStorage.setItem('device_order', JSON.stringify(saved));
    const resetBtn = $('#btn-reset-order');
    if (resetBtn) resetBtn.style.display = 'inline-block';
  }

  function reorderDevices(srcId, dstId) {
    const snap = M.S.snap;
    if (!snap || !snap.devices) return;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('device_order') || '[]'); } catch {}
    const defaultIds = snap.devices.map((d) => d.id);
    if (!saved.length) saved = sortDevices(snap.devices).map((d) => d.id);
    else {
      const set = new Set(defaultIds);
      saved = saved.filter((id) => set.has(id));
      for (const id of defaultIds) if (!saved.includes(id)) saved.push(id);
    }
    const fromIdx = saved.indexOf(srcId);
    const toIdx = saved.indexOf(dstId);
    if (fromIdx !== -1 && toIdx !== -1) {
      saved.splice(fromIdx, 1);
      saved.splice(toIdx, 0, srcId);
      localStorage.setItem('device_order', JSON.stringify(saved));
      M.views.dashboard.update(M.S.snap);
    }
  }

  let dualTab = localStorage.getItem('dual_tab') || 'map';
  let currentDualMapId = null;
  let cachedDualMap = null;

  M.views.dashboard = {
    render(el) {
      if (M.S.dual) {
        el.innerHTML = `
          <div class="dual-layout">
            <div class="dual-pane dual-pane-main">
              <div class="kpis" id="kpis"></div>
              <div id="groups-sec"></div>
              <div class="row" style="margin:20px 0 10px"><h2 style="margin:0">Thiết bị</h2>
                <button class="btn sm" id="btn-reset-order" style="display:none;margin-left:8px" title="Khôi phục thứ tự mặc định">↺ Thứ tự mặc định</button>
                <span class="spacer"></span>
                <input class="inp" id="f-q" placeholder="Tìm thiết bị…" style="width:160px" value="${esc(F.q)}">
                <select class="sel" id="f-status"><option value="">Tất cả trạng thái</option><option value="problem">Chỉ có vấn đề</option>
                  <option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Hoạt động</option></select>
                <select class="sel" id="f-type"><option value="">Mọi loại</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
              </div>
              <div class="grid" id="grid"></div>
            </div>
            <div class="dual-pane dual-pane-sub">
              <div class="dual-pane-head">
                <span class="dual-title">🖥️ Màn hình 2</span>
                <div class="dual-tabs">
                  <button class="btn sm ${dualTab === 'map' ? 'primary' : ''}" id="dual-tab-map">🗺️ Topology</button>
                  <button class="btn sm ${dualTab === 'groups' ? 'primary' : ''}" id="dual-tab-groups">🗂️ Nhóm</button>
                  <button class="btn sm ${dualTab === 'problems' ? 'primary' : ''}" id="dual-tab-problems">⚠️ Cảnh báo</button>
                </div>
                <span class="spacer"></span>
                <button class="btn sm" id="btn-dual-popout" title="Mở cửa sổ tách biệt cho màn hình phụ thứ hai">🗗 Cửa sổ riêng</button>
                <button class="btn sm" id="btn-dual-close" title="Tắt chế độ màn hình đôi">✕</button>
              </div>
              <div class="dual-pane-body" id="dual-pane-body"></div>
            </div>
          </div>`;

        const tabMap = $('#dual-tab-map');
        const tabGroups = $('#dual-tab-groups');
        const tabProblems = $('#dual-tab-problems');
        const switchDualTab = (t) => {
          dualTab = t;
          localStorage.setItem('dual_tab', t);
          tabMap?.classList.toggle('primary', t === 'map');
          tabGroups?.classList.toggle('primary', t === 'groups');
          tabProblems?.classList.toggle('primary', t === 'problems');
          this.updateDualPane(M.S.snap);
        };
        if (tabMap) tabMap.onclick = () => switchDualTab('map');
        if (tabGroups) tabGroups.onclick = () => switchDualTab('groups');
        if (tabProblems) tabProblems.onclick = () => switchDualTab('problems');

        const popoutBtn = $('#btn-dual-popout');
        if (popoutBtn) popoutBtn.onclick = () => {
          window.open(location.origin + '/#/secondary', 'monitoring_secondary_screen', 'width=1366,height=800,menubar=no,toolbar=no');
        };
        const closeBtn = $('#btn-dual-close');
        if (closeBtn) closeBtn.onclick = () => M.toggleDual(false);
      } else {
        el.innerHTML = `<div class="kpis" id="kpis"></div>
          <div id="groups-sec"></div>
          <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">Thiết bị</h2>
            <button class="btn sm" id="btn-reset-order" style="display:none;margin-left:8px" title="Khôi phục thứ tự mặc định">↺ Thứ tự mặc định</button>
            <span class="spacer"></span>
            <input class="inp" id="f-q" placeholder="Tìm thiết bị…" style="width:200px" value="${esc(F.q)}">
            <select class="sel" id="f-status"><option value="">Tất cả trạng thái</option><option value="problem">Chỉ có vấn đề</option>
              <option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Hoạt động</option></select>
            <select class="sel" id="f-type"><option value="">Mọi loại</option>${Object.entries(M.TYPE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="grid" id="grid"></div>`;
      }

      $('#f-status').value = F.status; $('#f-type').value = F.type;
      $('#f-q').addEventListener('input', (e) => { F.q = e.target.value; this.update(M.S.snap); });
      $('#f-status').addEventListener('change', (e) => { F.status = e.target.value; this.update(M.S.snap); });
      $('#f-type').addEventListener('change', (e) => { F.type = e.target.value; this.update(M.S.snap); });
      const resetBtn = $('#btn-reset-order');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          localStorage.removeItem('device_order');
          this.update(M.S.snap);
          M.toast('Đã khôi phục thứ tự mặc định');
        });
      }
      this.bindDragDrop();
    },
    destroy() {
      if (this.cleanupDrag) this.cleanupDrag();
    },
    bindDragDrop() {
      const grid = $('#grid');
      if (!grid) return;

      let session = null;
      let suppressClickUntil = 0;
      let scrollSpeed = 0;
      let scrollRaf = null;
      let lastSwapTime = 0;

      const stopAutoScroll = () => {
        scrollSpeed = 0;
        if (scrollRaf) {
          cancelAnimationFrame(scrollRaf);
          scrollRaf = null;
        }
      };

      const updateAutoScroll = (clientY) => {
        const edge = 75;
        const maxSpeed = 14;
        if (clientY < edge) {
          scrollSpeed = -Math.round((1 - Math.max(0, clientY) / edge) * maxSpeed);
        } else if (clientY > window.innerHeight - edge) {
          scrollSpeed = Math.round((1 - Math.max(0, window.innerHeight - clientY) / edge) * maxSpeed);
        } else {
          scrollSpeed = 0;
        }
        if (scrollSpeed !== 0 && !scrollRaf) {
          const loop = () => {
            if (scrollSpeed !== 0 && isDragging) {
              window.scrollBy(0, scrollSpeed);
              scrollRaf = requestAnimationFrame(loop);
            } else {
              scrollRaf = null;
            }
          };
          scrollRaf = requestAnimationFrame(loop);
        }
      };

      const detachWindowListeners = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', cancelDrag);
        window.removeEventListener('keydown', onKeyDown);
      };

      const cancelDrag = () => {
        if (!session) return;
        stopAutoScroll();
        detachWindowListeners();
        if (session.holdTimer) {
          clearTimeout(session.holdTimer);
          session.holdTimer = null;
        }
        if (session.started) {
          if (session.clone) session.clone.remove();
          if (session.tile) {
            session.tile.classList.remove('tile-placeholder');
            session.tile.style.transform = '';
            session.tile.style.transition = '';
          }
          grid.classList.remove('is-dragging');
          grid.style.touchAction = '';
          if (session.initialIds && session.initialIds.length) {
            const tileMap = new Map();
            grid.querySelectorAll('.tile').forEach((t) => {
              tileMap.set(Number(t.dataset.id), t);
              t.style.transform = '';
              t.style.transition = '';
            });
            for (const id of session.initialIds) {
              const el = tileMap.get(id);
              if (el) grid.appendChild(el);
            }
          }
          suppressClickUntil = Date.now() + 200;
          setTimeout(() => { isDragging = false; draggedId = null; }, 50);
        }
        session = null;
      };

      this.cleanupDrag = cancelDrag;

      const startDragging = (s, clientX, clientY) => {
        if (s.started) return;
        const tile = s.tile;
        if (!tile || !tile.dataset.id) return;
        const allTiles = Array.from(grid.querySelectorAll('.tile'));
        if (allTiles.length <= 1) return;

        s.started = true;
        isDragging = true;
        draggedId = Number(tile.dataset.id);
        s.initialIds = allTiles.map((t) => Number(t.dataset.id));

        const rect = tile.getBoundingClientRect();
        s.grabOffsetX = clientX - rect.left;
        s.grabOffsetY = clientY - rect.top;
        s.tileWidth = rect.width;
        s.tileHeight = rect.height;

        const clone = tile.cloneNode(true);
        clone.classList.add('tile-drag-clone');
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
        clone.style.left = '0px';
        clone.style.top = '0px';
        clone.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.04)`;
        document.body.appendChild(clone);
        s.clone = clone;

        tile.classList.add('tile-placeholder');
        grid.classList.add('is-dragging');
        grid.style.touchAction = 'none';

        if (navigator.vibrate) {
          try { navigator.vibrate(30); } catch {}
        }
      };

      const onPointerMove = (e) => {
        if (!session || e.pointerId !== session.pointerId) return;

        const dx = e.clientX - session.startX;
        const dy = e.clientY - session.startY;
        const dist = Math.hypot(dx, dy);

        if (!session.started) {
          if (session.pointerType === 'mouse') {
            if (dist > 4) {
              startDragging(session, e.clientX, e.clientY);
            }
          } else {
            if (dist > 8 && session.holdTimer) {
              clearTimeout(session.holdTimer);
              session.holdTimer = null;
              detachWindowListeners();
              session = null;
              return;
            }
          }
          return;
        }

        e.preventDefault();
        const curX = e.clientX - session.grabOffsetX;
        const curY = e.clientY - session.grabOffsetY;
        session.clone.style.transform = `translate3d(${curX}px, ${curY}px, 0) scale(1.04)`;

        updateAutoScroll(e.clientY);

        const cx = curX + session.tileWidth / 2;
        const cy = curY + session.tileHeight / 2;
        const allTiles = Array.from(grid.querySelectorAll('.tile'));
        let targetTile = null;

        for (const t of allTiles) {
          if (t === session.tile) continue;
          const r = t.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
            targetTile = t;
            break;
          }
        }

        if (!targetTile && allTiles.length > 1) {
          let closestDist = Infinity;
          for (const t of allTiles) {
            if (t === session.tile) continue;
            const r = t.getBoundingClientRect();
            const tcx = r.left + r.width / 2;
            const tcy = r.top + r.height / 2;
            const d = Math.hypot(cx - tcx, cy - tcy);
            if (d < closestDist && d < Math.max(r.width, r.height) * 0.85) {
              closestDist = d;
              targetTile = t;
            }
          }
        }

        const now = Date.now();
        if (targetTile && targetTile !== session.tile && (now - lastSwapTime > 75)) {
          const currentTiles = Array.from(grid.children).filter((el) => el.classList.contains('tile'));
          const pIdx = currentTiles.indexOf(session.tile);
          const tIdx = currentTiles.indexOf(targetTile);
          if (pIdx !== -1 && tIdx !== -1 && pIdx !== tIdx) {
            lastSwapTime = now;
            const firstRects = new Map();
            for (const t of currentTiles) {
              if (t !== session.tile) {
                firstRects.set(t, t.getBoundingClientRect());
              }
            }

            if (pIdx < tIdx) {
              grid.insertBefore(session.tile, targetTile.nextSibling);
            } else {
              grid.insertBefore(session.tile, targetTile);
            }

            for (const [t, oldRect] of firstRects.entries()) {
              const newRect = t.getBoundingClientRect();
              const diffX = oldRect.left - newRect.left;
              const diffY = oldRect.top - newRect.top;
              if (diffX !== 0 || diffY !== 0) {
                t.style.transition = 'none';
                t.style.transform = `translate(${diffX}px, ${diffY}px)`;
              }
            }

            grid.offsetHeight;

            requestAnimationFrame(() => {
              for (const [t] of firstRects) {
                t.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
                t.style.transform = '';
              }
            });
          }
        }
      };

      const onPointerUp = (e) => {
        if (!session || e.pointerId !== session.pointerId) return;

        stopAutoScroll();
        detachWindowListeners();

        if (session.holdTimer) {
          clearTimeout(session.holdTimer);
          session.holdTimer = null;
        }

        if (!session.started) {
          session = null;
          return;
        }

        e.preventDefault();
        const clone = session.clone;
        const tile = session.tile;
        const destRect = tile.getBoundingClientRect();

        grid.classList.remove('is-dragging');
        grid.style.touchAction = '';
        suppressClickUntil = Date.now() + 250;

        clone.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease, box-shadow 0.2s ease';
        clone.style.transform = `translate3d(${destRect.left}px, ${destRect.top}px, 0) scale(1)`;
        clone.style.boxShadow = '0 0 10px rgba(0,0,0,0.2)';
        clone.style.opacity = '1';

        const finalize = () => {
          if (clone.parentNode) clone.remove();
          tile.classList.remove('tile-placeholder');
          grid.querySelectorAll('.tile').forEach((t) => {
            t.style.transform = '';
            t.style.transition = '';
          });
          const newOrder = Array.from(grid.querySelectorAll('.tile'))
            .map((t) => Number(t.dataset.id))
            .filter(Boolean);
          saveDeviceOrder(newOrder);
          setTimeout(() => {
            isDragging = false;
            draggedId = null;
          }, 50);
        };

        let handled = false;
        clone.addEventListener('transitionend', () => {
          if (handled) return;
          handled = true;
          finalize();
        }, { once: true });
        setTimeout(() => {
          if (handled) return;
          handled = true;
          finalize();
        }, 220);

        session = null;
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape' && isDragging) {
          cancelDrag();
        }
      };

      grid.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const tile = e.target.closest('.tile');
        if (!tile || !tile.dataset.id) return;
        if (grid.querySelectorAll('.tile').length <= 1) return;

        session = {
          tile,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          pointerType: e.pointerType,
          started: false,
          holdTimer: null,
          clone: null,
        };

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp, { passive: false });
        window.addEventListener('pointercancel', cancelDrag);
        window.addEventListener('keydown', onKeyDown);

        if (e.pointerType === 'touch') {
          session.holdTimer = setTimeout(() => {
            if (session && !session.started) {
              startDragging(session, e.clientX, e.clientY);
            }
          }, 180);
        }
      });

      grid.addEventListener('dragstart', (e) => {
        e.preventDefault();
      });

      grid.addEventListener('click', (e) => {
        if (isDragging || Date.now() < suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    },
    update(snap) {
      if (!snap || !$('#kpis') || isDragging) return;
      const s = snap.summary;
      const k = (cls, label, v, zero) => `<div class="kpi ${cls} ${zero && !v ? 'zero' : ''}"><div class="label">${label}</div><div class="val">${v}</div></div>`;
      $('#kpis').innerHTML = `<div class="kpi big"><div class="label">Thiết bị đang hoạt động</div><div class="val">${s.alive}<small>/${s.total}</small></div></div>
        ${k('k-down', 'Mất kết nối', s.down, true)}${k('k-warn', 'Cảnh báo', s.warning, true)}${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance)}`;
      $('#groups-sec').innerHTML = M.S.groups.length
        ? `<h2>Nhóm thiết bị</h2><div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>` : '';
      const resetBtn = $('#btn-reset-order');
      if (resetBtn) resetBtn.style.display = localStorage.getItem('device_order') ? 'inline-block' : 'none';
      let list = snap.devices;
      if (F.q) list = list.filter((d) => (d.name + d.address + d.location).toLowerCase().includes(F.q.toLowerCase()));
      if (F.type) list = list.filter((d) => d.type === F.type);
      if (F.status === 'problem') list = list.filter((d) => d.status === 'down' || d.status === 'warning');
      else if (F.status) list = list.filter((d) => d.status === F.status);
      $('#grid').innerHTML = list.length ? sortDevices(list).map(M.tile).join('')
        : `<div class="muted">${snap.devices.length ? 'Không có thiết bị phù hợp' : 'Chưa có thiết bị nào. Vào mục "Thiết bị" để thêm.'}</div>`;

      if (M.S.dual) {
        this.updateDualPane(snap);
      }
    },
    updateDualPane(snap) {
      const body = $('#dual-pane-body');
      if (!body || !snap) return;
      if (dualTab === 'map') {
        if (M.S.maps && M.S.maps.length > 0) {
          const mapId = currentDualMapId || M.S.maps[0].id;
          let selectHtml = '';
          if (M.S.maps.length > 1) {
            selectHtml = `<div style="margin-bottom:8px"><select class="sel" id="dual-map-sel">${M.S.maps.map((m) => `<option value="${m.id}" ${m.id === mapId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`;
          }
          if (!$('#dual-map-box')) {
            body.innerHTML = `${selectHtml}<div class="map-box" id="dual-map-box" style="overflow:hidden"><svg id="dual-map-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet"></svg></div>`;
          }
          const mapSel = $('#dual-map-sel');
          if (mapSel) {
            mapSel.onchange = async (e) => {
              currentDualMapId = Number(e.target.value);
              cachedDualMap = await M.api('GET', `/api/maps/${currentDualMapId}`);
              M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
            };
          }
          if (!cachedDualMap || cachedDualMap.id !== mapId) {
            M.api('GET', `/api/maps/${mapId}`).then((mData) => {
              cachedDualMap = mData;
              M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
            }).catch(() => {});
          } else {
            M.renderMapSvg($('#dual-map-svg'), cachedDualMap);
          }
        } else {
          body.innerHTML = `<div class="panel" style="text-align:center;padding:36px 16px">
            <div style="font-size:36px;margin-bottom:8px">🗺️</div>
            <h3 style="margin:0 0 8px">Chưa có sơ đồ mạng Topology</h3>
            <p class="muted" style="margin:0 0 14px">Tạo sơ đồ mạng để theo dõi trực quan liên kết giữa các thiết bị trên màn hình thứ hai.</p>
            ${M.S.user.role !== 'viewer' ? '<a class="btn primary" href="#/maps">+ Tạo sơ đồ Topology</a>' : ''}
          </div>`;
        }
      } else if (dualTab === 'groups') {
        body.innerHTML = M.S.groups.length
          ? `<div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))">${M.S.groups.map(M.groupTile).join('')}</div>`
          : '<div class="muted">Chưa có nhóm thiết bị nào.</div>';
      } else if (dualTab === 'problems') {
        const probs = snap.devices.filter((d) => d.status === 'down' || d.status === 'warning');
        if (!probs.length) {
          body.innerHTML = `<div class="panel" style="text-align:center;padding:36px 16px;border-color:var(--c-ok)">
            <div style="font-size:40px;margin-bottom:8px">✅</div>
            <h3 style="color:var(--c-ok);margin:0 0 6px">Hệ thống đang hoạt động ổn định</h3>
            <p class="muted" style="margin:0">Tất cả thiết bị đều đang trực tuyến, không có cảnh báo.</p>
          </div>`;
        } else {
          body.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr))">${sortDevices(probs).map(M.tile).join('')}</div>`;
        }
      }
    },
  };

  // ---------- secondary screen (detached popout window) ----------
  M.views.secondary = {
    async render(el) {
      await Promise.all([M.loadGroups(), M.loadMaps()]);
      let secTab = localStorage.getItem('secondary_tab') || 'map';
      el.innerHTML = `
        <div class="secondary-screen-view">
          <div class="row" style="margin-bottom:14px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div class="brand" style="font-size:20px">◉ MÀN HÌNH PHỤ (SECONDARY)</div>
            <span class="chip" id="sec-chip">–/–</span>
            <div class="dual-tabs">
              <button class="btn sm ${secTab === 'map' ? 'primary' : ''}" id="sec-tab-map">🗺️ Sơ đồ Topology</button>
              <button class="btn sm ${secTab === 'groups' ? 'primary' : ''}" id="sec-tab-groups">🗂️ Nhóm thiết bị</button>
              <button class="btn sm ${secTab === 'problems' ? 'primary' : ''}" id="sec-tab-problems">⚠️ Cảnh báo</button>
              <button class="btn sm ${secTab === 'wallboard' ? 'primary' : ''}" id="sec-tab-wallboard">📊 Wallboard</button>
            </div>
            <span class="spacer"></span>
            <button class="icon-btn" id="sec-btn-fullscreen" title="Phóng to toàn màn hình (phím F)">📺 Toàn màn hình</button>
            <select class="sel" id="sec-theme-sel" title="Giao diện">
              <option value="neon">Neon</option><option value="dark">Tối</option><option value="light">Sáng</option>
            </select>
          </div>
          <div id="sec-body"></div>
        </div>`;

      $('#sec-theme-sel').value = document.documentElement.dataset.theme;
      $('#sec-theme-sel').onchange = (e) => M.applyTheme(e.target.value);
      $('#sec-btn-fullscreen').onclick = () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
        else document.exitFullscreen?.();
      };

      const switchTab = (t) => {
        secTab = t;
        localStorage.setItem('secondary_tab', t);
        $('#sec-tab-map')?.classList.toggle('primary', t === 'map');
        $('#sec-tab-groups')?.classList.toggle('primary', t === 'groups');
        $('#sec-tab-problems')?.classList.toggle('primary', t === 'problems');
        $('#sec-tab-wallboard')?.classList.toggle('primary', t === 'wallboard');
        this.update(M.S.snap);
      };
      $('#sec-tab-map').onclick = () => switchTab('map');
      $('#sec-tab-groups').onclick = () => switchTab('groups');
      $('#sec-tab-problems').onclick = () => switchTab('problems');
      $('#sec-tab-wallboard').onclick = () => switchTab('wallboard');
      this.update(M.S.snap);
    },
    update(snap) {
      if (!snap || !$('#sec-body')) return;
      const s = snap.summary;
      const chip = $('#sec-chip');
      if (chip) chip.textContent = `${s.alive}/${s.total} hoạt động`;
      const body = $('#sec-body');
      const tab = localStorage.getItem('secondary_tab') || 'map';
      if (tab === 'map') {
        if (M.S.maps && M.S.maps.length) {
          body.innerHTML = `<div class="map-box" style="height:calc(100vh - 120px)"><svg id="sec-map-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" style="height:100%"></svg></div>`;
          M.api('GET', `/api/maps/${M.S.maps[0].id}`).then((m) => {
            M.renderMapSvg($('#sec-map-svg'), m);
          }).catch(() => {});
        } else {
          body.innerHTML = '<div class="panel muted" style="padding:40px;text-align:center">Chưa có sơ đồ Topology nào.</div>';
        }
      } else if (tab === 'groups') {
        body.innerHTML = `<div class="grid">${M.S.groups.map(M.groupTile).join('')}</div>`;
      } else if (tab === 'problems') {
        const probs = snap.devices.filter((d) => d.status === 'down' || d.status === 'warning');
        body.innerHTML = probs.length
          ? `<div class="grid">${sortDevices(probs).map(M.tile).join('')}</div>`
          : '<div class="panel" style="text-align:center;padding:40px;border-color:var(--c-ok);color:var(--c-ok)"><h3>✅ Tất cả thiết bị đang hoạt động ổn định</h3></div>';
      } else if (tab === 'wallboard') {
        const k = (cls, label, v, zero) => `<div class="kpi ${cls} ${zero && !v ? 'zero' : ''}"><div class="label">${label}</div><div class="val">${v}</div></div>`;
        body.innerHTML = `
          <div class="kpis">
            <div class="kpi big"><div class="label">Thiết bị đang hoạt động</div><div class="val">${s.alive}<small>/${s.total}</small></div></div>
            ${k('k-down', 'Mất kết nối', s.down, true)}${k('k-warn', 'Cảnh báo', s.warning, true)}${k('k-unk', 'Chưa rõ / Bảo trì', `${s.unknown}${s.maintenance ? `<small> / ${s.maintenance}</small>` : ''}`, !s.unknown && !s.maintenance)}
          </div>
          <div class="grid" style="margin-top:20px">${sortDevices(snap.devices).map(M.tile).join('')}</div>`;
      }
    },
  };

  // ---------- groups ----------
  M.views.groups = {
    async render(el) {
      await M.loadGroups();
      el.innerHTML = `<div class="row"><h1>Nhóm / cụm thiết bị</h1><span class="spacer"></span>
        ${M.S.user.role === 'admin' ? '<button class="btn primary" id="g-add">+ Thêm nhóm</button>' : ''}</div><div class="grid" id="g-grid"></div>`;
      const add = $('#g-add');
      if (add) add.onclick = () => M.editGroup(null);
    },
    update() { $('#g-grid') && ($('#g-grid').innerHTML = M.S.groups.map(M.groupTile).join('') || '<div class="muted">Chưa có nhóm. Nhóm giúp gom các thiết bị (ví dụ: Tầng 1, Cụm DB) để theo dõi riêng.</div>'); },
  };

  M.views.group = {
    async render(el, id) {
      await M.loadGroups();
      const g = M.S.groups.find((x) => x.id === Number(id));
      if (!g) { el.innerHTML = '<div class="panel err">Không tìm thấy nhóm</div>'; return; }
      this.g = g;
      el.innerHTML = `<div id="grp-hero"></div><h2>Thiết bị trong nhóm</h2><div class="grid" id="grp-grid"></div>`;
    },
    update(snap) {
      const g = this.g;
      if (!g || !$('#grp-hero')) return;
      const list = snap.devices.filter((d) => d.groups.includes(g.id));
      const { s, cls } = groupClass(list);
      const avg = (k) => { const v = list.map((d) => d[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      $('#grp-hero').innerHTML = `<div class="hero ${cls}"><div class="h-ico">🗂️</div><div style="flex:1"><h1>${esc(g.name)}</h1>
        <div class="muted">${esc(g.description || '')}</div></div>
        <div style="text-align:right"><div class="h-state">${s.alive}/${s.total} hoạt động</div>
        <div class="muted">${s.down} mất kết nối · ${s.warning} cảnh báo</div></div>
        ${M.S.user.role === 'admin' ? '<button class="btn" id="g-edit">Sửa nhóm</button>' : ''}</div>
        <div class="gauges panel" style="margin-top:14px">${['cpu', 'ram', 'disk'].map((k) => (avg(k) != null ? M.gauge(`${k.toUpperCase()} trung bình`, avg(k), k) : '')).join('') || '<span class="muted">Nhóm chưa có thiết bị cài agent</span>'}</div>`;
      $('#grp-grid').innerHTML = sortDevices(list).map(M.tile).join('') || '<div class="muted">Nhóm chưa có thiết bị</div>';
      const e = $('#g-edit');
      if (e) e.onclick = () => M.editGroup(g);
    },
  };

  // ---------- device ----------
  M.views.device = {
    async render(el, id) {
      this.id = Number(id); this.range = this.range || '1h'; this.busy = false;
      el.innerHTML = `<div id="d-hero"></div><div class="panel" id="d-gauges" style="margin-top:14px"></div>
        <div class="cols"><div>
          <div class="panel"><div class="row"><h2 style="margin:0">Lịch sử</h2><span class="spacer"></span>
            <select class="sel" id="d-range"><option value="1h">1 giờ</option><option value="6h">6 giờ</option><option value="24h">24 giờ</option><option value="7d">7 ngày</option></select></div>
            <div id="d-charts"></div></div>
          <div class="panel" style="margin-top:14px"><h2 style="margin:0 0 10px">Sự kiện gần đây</h2><div id="d-events"></div></div>
        </div><div class="panel" id="d-info"></div></div>`;
      $('#d-range').value = this.range;
      this._infoHtml = null;
      if (!M.profiles) M.profiles = await M.api('GET', '/api/snmp/profiles').then((r) => r.profiles).catch(() => []);
      $('#d-range').onchange = (e) => { this.range = e.target.value; this.loadCharts(); };
      await this.load();
      this.loadCharts(); this.loadEvents();
      this.t1 = setInterval(() => this.loadCharts(), 30000);
      this.t2 = setInterval(() => this.loadEvents(), 10000);
    },
    destroy() { clearInterval(this.t1); clearInterval(this.t2); this.D = null; },
    update(snap) {
      const latest = snap && snap.devices.find((x) => x.id === this.id);
      if (latest) {
        this.D = { ...this.D, ...latest };
        this.paint();
      }
      this.load();
    },
    async load() {
      if (this.busy) return;
      this.busy = true;
      try { this.D = await M.api('GET', `/api/devices/${this.id}`); this.paint(); } catch (e) {
        if ($('#d-hero')) $('#d-hero').innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
      } finally { this.busy = false; }
    },
    paint() {
      const d = this.D;
      if (!d || !$('#d-hero')) return;
      const role = M.S.user.role;
      $('#d-hero').innerHTML = `<div class="hero ${M.statusClass(d)}"><div class="h-ico">${M.ICON[d.type] || ''}</div>
        <div style="flex:1;min-width:0"><h1>${esc(d.name)}</h1><div class="h-state">${M.STATE_NAME[d.status]}
        <span class="muted" style="font-size:14px;text-transform:none"> · từ ${M.fmtTime(d.since)} (${M.fmtDur((Date.now() - d.since) / 1000)})</span></div>
        ${d.reasons.map((r) => `<div class="reason">• ${esc(r)}</div>`).join('')}</div>
        <div class="row">${d.status === 'down' && !d.acked && role !== 'viewer' ? '<button class="btn" id="d-ack">Đã biết</button>' : ''}
        ${role === 'admin' ? `<button class="btn" id="d-maint">${d.maintenance ? 'Kết thúc bảo trì' : 'Bảo trì'}</button><button class="btn" id="d-edit">Sửa</button>` : ''}
        <button class="btn" id="d-back">← Quay lại</button></div></div>`;
      const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
      on('#d-back', () => history.back());
      on('#d-ack', async () => { await M.api('POST', `/api/devices/${d.id}/ack`, {}); });
      on('#d-maint', async () => { await M.api('PUT', `/api/devices/${d.id}`, { maintenance: !d.maintenance }); });
      on('#d-edit', () => M.editDevice(d.id));

      const a = d.agent;
      const gs = [];
      if (d.cpu != null) gs.push(M.gauge('CPU', d.cpu, 'cpu', a && a.cores ? `${a.cores} nhân` : ''));
      if (d.ram != null) gs.push(M.gauge('RAM', d.ram, 'ram', a && a.ram.total ? `${M.fmtBytes(a.ram.used)} / ${M.fmtBytes(a.ram.total)}` : ''));
      if (d.disk != null) gs.push(M.gauge('Ổ đĩa (cao nhất)', d.disk, 'disk'));
      const stat = (label, v) => `<div class="gauge"><div style="font-size:30px;font-weight:700;padding:38px 0 6px">${v}</div><div class="g-label">${label}</div></div>`;
      gs.push(stat('Thời gian chạy', M.fmtDur(d.uptime)), stat('Ping', d.rtt != null ? `${d.rtt} ms` : '—'));
      if (d.net_in != null || d.net_out != null) {
        const netHtml = `<div style="font-size:18px;font-weight:700;padding:26px 0 2px;line-height:1.3"><span style="color:var(--c-low)">↓ ${M.fmtRate(d.net_in || 0)}</span><br><span style="color:var(--c-maint);font-size:15px">↑ ${M.fmtRate(d.net_out || 0)}</span></div>`;
        gs.push(`<div class="gauge">${netHtml}<div class="g-label">Băng thông hiện tại</div></div>`);
      }
      if (d.toner != null) gs.push(M.gauge('Mực in', d.toner, 'cpu'));
      if (d.temperature != null) gs.push(stat('Nhiệt độ', `${d.temperature}°C`));
      $('#d-gauges').innerHTML = `<div class="gauges" style="margin:0">${gs.join('')}</div>`;

      const names = d.groups.map((id) => (M.S.groups.find((g) => g.id === id) || {}).name).filter(Boolean);
      const chk = [d.check_icmp && 'ICMP ping', d.check_agent && 'Agent', d.snmp_enabled && 'SNMP'].filter(Boolean).join(', ') || '—';
      const kv = (k, v) => `<dt>${k}</dt><dd>${v == null || v === '' ? '—' : esc(v)}</dd>`;
      let html = `<h2 style="margin:0 0 10px">Thông tin</h2><dl class="kv">${kv('Loại', M.TYPE_NAME[d.type])}${kv('Địa chỉ', d.address)}${kv('Vị trí', d.location)}
        <dt>Mức cảnh báo</dt><dd><span class="sev-badge ${d.severity}">${M.SEV_NAME[d.severity]}</span>${d.severity_override ? '' : ' <span class="muted">(theo loại)</span>'}</dd>
        ${kv('Nhóm', names.join(', '))}${kv('Kiểm tra', chk)}${kv('Ghi chú', d.notes)}</dl>`;
      if (a) {
        html += `<h2>Agent</h2><dl class="kv">${kv('Hostname', a.hostname)}${kv('Hệ điều hành', a.os)}${kv('IP', a.ip)}${kv('Phiên bản', a.version)}
          ${kv('Báo cáo cuối', d.last_agent_at ? M.fmtTime(d.last_agent_at) : '')}</dl>`;
        if (a.disks.length) {
          html += `<h2>Ổ đĩa</h2><table class="tbl"><tbody>${a.disks.map((x) => `<tr><td>${esc(x.mount)}</td><td>${M.fmtBytes(x.used)} / ${M.fmtBytes(x.total)}</td>
            <td style="width:70px">${bar('', x.percent ?? 0, 'disk')}</td></tr>`).join('')}</tbody></table>`;
        }
      }
      if (d.snmp_enabled) html += this.snmpSection(d, kv);
      if (d.agent_token) {
        html += `<h2>Agent token</h2><details><summary class="muted">Hiện token (bí mật)</summary><code style="word-break:break-all">${esc(d.agent_token)}</code>
          <div style="margin-top:6px"><button class="btn sm danger" id="d-regen">Tạo token mới</button></div></details>`;
      }
      const open = $('#d-info details') && $('#d-info details').open;
      if (html !== this._infoHtml) { // keep the profile dropdown usable while live updates arrive
        this._infoHtml = html;
        $('#d-info').innerHTML = html;
        if (open && $('#d-info details')) $('#d-info details').open = true;
        this.bindSnmp(d);
      }
      const rg = $('#d-regen');
      if (rg) rg.onclick = () => M.confirm('Tạo token mới? Agent đang dùng token cũ sẽ bị từ chối.', async () => {
        await M.api('POST', `/api/devices/${d.id}/regen-token`, {});
        this.load();
      });
    },
    snmpSection(d, kv) {
      const s = d.snmp;
      const pr = s && s.profile;
      let h = '<h2>SNMP</h2>';
      if (d.snmp_error) h += `<div class="reason">• Lần đọc SNMP gần nhất lỗi: ${esc(d.snmp_error.message)}</div>`;
      if (s) {
        h += `<dl class="kv">${kv('sysName', s.sysName)}${kv('sysDescr', s.sysDescr)}${kv('sysObjectID', s.sysObjectID)}
          ${pr ? kv('Hồ sơ đang dùng', `${pr.name} (${pr.auto ? 'tự nhận diện' : 'chọn tay'})`) : ''}</dl>`;
        if (pr && pr.missing) h += `<div class="reason">• Hồ sơ đã chọn "${esc(pr.requested)}" không còn tồn tại, đang tự nhận diện.</div>`;
        const rows = Object.entries(s.diag || {}).map(([k, m]) => {
          const val = (x) => (k === 'uptime' ? M.fmtDur(x) : `${x}${m.unit || ''}`);
          if (m.ok) {
            const note = [m.source > 0 ? `nguồn dự phòng #${m.source + 1}` : '', m.unverified ? 'chưa kiểm chứng' : ''].filter(Boolean).join(' · ');
            return `<tr><td>${esc(m.label)}</td><td><b>${esc(val(m.value))}</b></td><td class="muted">${esc(note)}</td></tr>`;
          }
          const tried = (m.tried || []).map((t) => t.oid).join(', ');
          return `<tr><td>${esc(m.label)}</td><td>—</td><td class="${m.optional ? 'muted' : ''}" ${m.optional ? '' : 'style="color:var(--c-high)"'}>
            ${m.optional ? 'Không có: ' : 'Không đọc được: '}${esc(m.message)}<br><span class="muted">đã thử OID: ${esc(tried)}</span></td></tr>`;
        });
        if (rows.length) h += `<table class="tbl"><thead><tr><th>Chỉ số</th><th>Giá trị</th><th>Ghi chú / lý do</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
      } else if (!d.snmp_error) h += '<div class="muted">Chưa có dữ liệu SNMP.</div>';
      if (M.S.user.role === 'admin') {
        const opts = (M.profiles || []).map((p) => `<option value="${esc(p.id)}" ${p.id === d.snmp_profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        h += `<div class="row" style="margin-top:10px"><select class="sel" id="d-prof" title="Hồ sơ SNMP"><option value="">Tự nhận diện</option>${opts}</select>
          <button class="btn sm" id="d-walk">Xuất dữ liệu SNMP</button></div>
          <div class="muted" style="font-size:12px;margin-top:4px">Nhận diện sai? Chọn hồ sơ khác. Thiết bị chưa được hỗ trợ? Xuất dữ liệu SNMP và gửi file .walk cho nhà phát triển.</div>`;
      }
      return h;
    },
    bindSnmp(d) {
      const sel = $('#d-prof');
      if (sel) sel.onchange = async () => {
        try { await M.api('PUT', `/api/devices/${d.id}`, { snmp_profile: sel.value }); M.toast('Đã đổi hồ sơ SNMP, đang đọc lại...'); } catch (e) { M.toast(e.message); }
      };
      const btn = $('#d-walk');
      if (btn) btn.onclick = async () => {
        btn.disabled = true; btn.textContent = 'Đang đọc thiết bị...';
        try {
          const r = await fetch(`/api/devices/${d.id}/snmp-walk`, { method: 'POST', headers: { 'X-Requested-With': 'monitor' }, credentials: 'same-origin' });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await r.blob());
          a.download = `${d.name.replace(/[^\w.-]+/g, '-')}.walk`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          M.toast('Đã xuất file .walk');
        } catch (e) { M.toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Xuất dữ liệu SNMP'; }
      };
    },
    async loadCharts() {
      if (!$('#d-charts')) return;
      const { points } = await M.api('GET', `/api/devices/${this.id}/history?range=${this.range}`);
      if (!$('#d-charts')) return;
      const has = (k) => points.some((p) => p[k] != null);
      let html = '';
      if (has('cpu')) html += `<h2>CPU / RAM / Ổ đĩa (%)</h2>${M.chart(points, [{ key: 'cpu', color: 'var(--c-low)', label: 'CPU' }, { key: 'ram', color: 'var(--c-medium)', label: 'RAM' }, { key: 'disk', color: 'var(--c-high)', label: 'Disk' }], this.range, 100)}`;
      if (has('rtt')) html += `<h2>Độ trễ ping (ms)</h2>${M.chart(points, [{ key: 'rtt', color: 'var(--c-ok)', label: 'RTT' }], this.range)}`;
      if (has('net_in') || has('net_out')) {
        html += `<h2>Tổng băng thông sử dụng</h2>${M.chart(points, [
          { key: 'net_in', color: 'var(--c-low)', label: 'Tải xuống (In)' },
          { key: 'net_out', color: 'var(--c-maint)', label: 'Tải lên (Out)' },
        ], this.range, null, M.fmtRate)}`;
      }
      $('#d-charts').innerHTML = html || '<div class="muted" style="padding:20px">Chưa có dữ liệu lịch sử</div>';
    },
    async loadEvents() {
      if (!$('#d-events')) return;
      const { events } = await M.api('GET', `/api/events?device=${this.id}&limit=15`);
      if ($('#d-events')) $('#d-events').innerHTML = M.eventsTable(events, false);
    },
  };

  // ---------- events ----------
  M.views.events = {
    async render(el) {
      el.innerHTML = `<div class="row"><h1>Nhật ký sự kiện</h1><span class="spacer"></span>
        <select class="sel" id="ev-kind"><option value="">Tất cả</option><option value="down">Mất kết nối</option><option value="warning">Cảnh báo</option><option value="up">Phục hồi</option><option value="audit">Hệ thống</option></select></div>
        <div class="panel" id="ev-body"></div>`;
      $('#ev-kind').onchange = () => this.load();
      await this.load();
      this.t = setInterval(() => this.load(), 10000);
    },
    destroy() { clearInterval(this.t); },
    async load() {
      const { events } = await M.api('GET', '/api/events?limit=300');
      const k = $('#ev-kind') && $('#ev-kind').value;
      if ($('#ev-body')) $('#ev-body').innerHTML = M.eventsTable(k ? events.filter((e) => e.kind === k) : events, true);
    },
  };
})();
