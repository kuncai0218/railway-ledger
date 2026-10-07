// 铁路沿线影像判读台：精标页（2026-10-06，Claude）。读同学版 ../data/windows_blind.json 和 ../data/precise_list.json（只有窗口号、给同学的提示和参考位置）。
// 每格四种状态：0 看过没变、1 变化、2 拿不准、3 还没看。导出时 0→0、1→1、2 和 3→255（接口约定第 7 节）。
'use strict';
(() => {
  const DATA = '../data/', LS_WHO = 'ledger_v3_who', N = 200;
  const TAGS = [['bare+', '裸土 / 施工 增加'], ['bare-', '裸土 / 施工 减少'], ['veg-', '植被 减少'], ['veg+', '植被 增加'], ['water+', '水面 扩大'], ['water-', '水面 缩小'],
    ['gully', '沟道冲刷或堆积'], ['road+', '道路 增加'], ['building+', '建筑 增加'], ['farm', '农田季节变化'], ['unclear', '说不清']];
  const $ = id => document.getElementById(id);
  const cvB = $('cvB'), cvA = $('cvA');
  let W = [], LIST = {}, who = '', cur = -1, st = null, regions = [], compMap = null, saved = {}, drafts = {}, undo = [], redo = [];
  let val = 1, size = 1, shape = 'brush', view = { scale: 1, ox: 0, oy: 0 }, lastSize = null, full = false, fc = false, showL = true, showR = true, flick = false;
  let drag = null, t0 = null, secs = 0;
  const imgCache = new Map(), layer = document.createElement('canvas'); layer.width = layer.height = N;

  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('ledger_desk_v3_precise', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const op = async (m, fn) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction('kv', m); const rq = fn(tx.objectStore('kv')); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error); }); };
    return { get: k => op('readonly', s => s.get(k)), set: (k, x) => op('readwrite', s => s.put(x, k)), keys: () => op('readonly', s => s.getAllKeys()), del: k => op('readwrite', s => s.delete(k)) };
  })();
  const pad = n => String(n).padStart(2, '0');
  function nowIso() { const d = new Date(), o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${o >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; }
  function toast(t, ms = 2000) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms); }
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // ---------------------------------------------------------------- 变化块（四邻接连通）和类型继承
  function components(s) {
    const map = new Int32Array(N * N), out = []; let k = 0;
    for (let i = 0; i < N * N; i++) {
      if (s[i] !== 1 || map[i]) continue;
      k++; let n = 0; const stack = [i]; map[i] = k;
      while (stack.length) {
        const j = stack.pop(); n++; const r = (j / N) | 0, c = j % N;
        for (const q of [r > 0 ? j - N : -1, r < N - 1 ? j + N : -1, c > 0 ? j - 1 : -1, c < N - 1 ? j + 1 : -1]) if (q >= 0 && s[q] === 1 && !map[q]) { map[q] = k; stack.push(q); }
      }
      out.push({ id: k, pixels: n });
    }
    return { map, out };
  }
  function recomputeRegions() {
    const { map, out } = components(st);
    if (compMap) {
      const best = {};
      for (let i = 0; i < N * N; i++) if (map[i] && compMap[i]) { const key = `${map[i]}|${compMap[i]}`; best[key] = (best[key] || 0) + 1; }
      const pick = {};
      for (const [key, n] of Object.entries(best)) { const [a, b] = key.split('|').map(Number); if (!pick[a] || n > pick[a][1]) pick[a] = [b, n]; }
      const old = Object.fromEntries(regions.map(r => [r.id, r]));
      for (const r of out) { const o = pick[r.id] && old[pick[r.id][0]]; r.tags = o ? [...o.tags] : []; r.note = o ? o.note || '' : ''; }
    } else for (const r of out) { r.tags = []; r.note = ''; }
    compMap = map; regions = out;
  }

  // ---------------------------------------------------------------- 画面
  function getImg(path) { if (!imgCache.has(path)) { const im = new Image(); im.src = DATA + path; im.onload = () => draw(); imgCache.set(path, im); } const im = imgCache.get(path); return im.complete && im.naturalWidth ? im : null; }
  function fitCanvas(cv) { const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect(); const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } }
  function resetView() { const span = full ? 200 : 120, r = cvB.getBoundingClientRect(); view.scale = Math.min(r.width, r.height) / span; view.ox = 100 - r.width / 2 / view.scale; view.oy = 100 - r.height / 2 / view.scale; lastSize = { w: r.width, h: r.height }; draw(); }
  new ResizeObserver(() => { const r = cvB.getBoundingClientRect(); if (!r.width || !r.height) return; if (lastSize && cur >= 0) { const cx = view.ox + lastSize.w / 2 / view.scale, cy = view.oy + lastSize.h / 2 / view.scale, k = Math.min(r.width, r.height) / Math.min(lastSize.w, lastSize.h); if (Number.isFinite(k) && k > 0) view.scale *= k; view.ox = cx - r.width / 2 / view.scale; view.oy = cy - r.height / 2 / view.scale; } lastSize = { w: r.width, h: r.height }; draw(); }).observe(cvB);
  function paintLayer() {
    const ctx = layer.getContext('2d'), im = ctx.createImageData(N, N), d = im.data;
    for (let i = 0; i < N * N; i++) {
      const v = st[i], o = i * 4;
      if (v === 1) { d[o] = 255; d[o + 1] = 59; d[o + 2] = 48; d[o + 3] = 150; }
      else if (v === 2) { d[o] = 255; d[o + 1] = 212; d[o + 2] = 0; d[o + 3] = 140; }
      else if (v === 3) { d[o + 3] = 115; }
    }
    ctx.putImageData(im, 0, 0);
  }
  function draw() {
    if (cur < 0) return;
    const w = W[cur], dpr = window.devicePixelRatio || 1, guide = (LIST[w.wid] || {}).marks || [];
    for (const [cv, side] of [[cvB, 'b'], [cvA, 'a']]) {
      fitCanvas(cv); const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
      const s = side === 'a' && flick ? 'b' : side, k = dpr * view.scale;
      ctx.setTransform(k, 0, 0, k, -view.ox * k, -view.oy * k); ctx.imageSmoothingEnabled = false;
      const base = getImg(w.img[`${s}_${fc ? 'fc' : 'tc'}`]); if (base) ctx.drawImage(base, 0, 0, N, N);
      if (showL) ctx.drawImage(layer, 0, 0, N, N);
      if (showR && w.img.rings) { const r = getImg(w.img.rings); if (r) ctx.drawImage(r, 0, 0, N, N); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const P = (x, y) => [(x - view.ox) * view.scale * dpr, (y - view.oy) * view.scale * dpr];
      ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2 * dpr;
      for (const m of guide) {
        if (m.kind === 'point') { const [x, y] = P(...m.xy); ctx.beginPath(); ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2); ctx.stroke(); }
        else { const [x0, y0] = P(m.box[0], m.box[1]), [x1, y1] = P(m.box[2], m.box[3]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); }
      }
      ctx.setLineDash([]);
      if (drag && drag.kind === 'rect') { const [x0, y0] = P(Math.min(drag.c0, drag.c1), Math.min(drag.r0, drag.r1)), [x1, y1] = P(Math.max(drag.c0, drag.c1) + 1, Math.max(drag.r0, drag.r1) + 1); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); }
    }
  }

  // ---------------------------------------------------------------- 涂
  const cell = (cv, e) => { const r = cv.getBoundingClientRect(); return [Math.floor(view.oy + (e.clientY - r.top) / view.scale), Math.floor(view.ox + (e.clientX - r.left) / view.scale)]; };
  function stamp(r, c) { const h = (size - 1) >> 1; for (let i = r - h; i <= r + h; i++) for (let j = c - h; j <= c + h; j++) if (i >= 0 && i < N && j >= 0 && j < N) st[i * N + j] = val; }
  function line(r0, c0, r1, c1) { const n = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0), 1); for (let t = 0; t <= n; t++) stamp(Math.round(r0 + (r1 - r0) * t / n), Math.round(c0 + (c1 - c0) * t / n)); }
  function pushUndo() { undo.push(st.slice()); if (undo.length > 60) undo.shift(); redo = []; }
  function changed() { recomputeRegions(); paintLayer(); renderRegions(); draw(); drafts[W[cur].wid] = true; clearTimeout(changed.t); changed.t = setTimeout(saveDraft, 500); }
  for (const cv of [cvB, cvA]) {
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(), x = view.ox + (e.clientX - r.left) / view.scale, y = view.oy + (e.clientY - r.top) / view.scale; view.scale = Math.min(40, Math.max(Math.min(r.width, r.height) / 240, view.scale * (e.deltaY < 0 ? 1.25 : 0.8))); view.ox = x - (e.clientX - r.left) / view.scale; view.oy = y - (e.clientY - r.top) / view.scale; draw(); }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      if (cur < 0) return; try { cv.setPointerCapture(e.pointerId); } catch { /* 合成的指针没有活动指针时忽略 */ }
      if (e.button !== 0) { drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, ox: view.ox, oy: view.oy }; return; }
      const [r, c] = cell(cv, e); pushUndo();
      if (shape === 'rect') { drag = { kind: 'rect', r0: r, c0: c, r1: r, c1: c, cv }; draw(); return; }
      drag = { kind: 'brush', r, c, cv }; stamp(r, c); paintLayer(); draw();
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.kind === 'pan') { view.ox = drag.ox - (e.clientX - drag.cx) / view.scale; view.oy = drag.oy - (e.clientY - drag.cy) / view.scale; draw(); return; }
      const [r, c] = cell(drag.cv, e);
      if (drag.kind === 'rect') { drag.r1 = r; drag.c1 = c; draw(); return; }
      line(drag.r, drag.c, r, c); drag.r = r; drag.c = c; paintLayer(); draw();
    });
    cv.addEventListener('pointerup', () => {
      if (!drag) return;
      if (drag.kind === 'rect') { for (let i = Math.max(0, Math.min(drag.r0, drag.r1)); i <= Math.min(N - 1, Math.max(drag.r0, drag.r1)); i++) for (let j = Math.max(0, Math.min(drag.c0, drag.c1)); j <= Math.min(N - 1, Math.max(drag.c0, drag.c1)); j++) st[i * N + j] = val; }
      const was = drag.kind; drag = null; if (was !== 'pan') changed();
    });
  }

  // ---------------------------------------------------------------- 右侧
  function renderRegions() {
    const box = $('regions');
    box.innerHTML = regions.length ? regions.map(r => `<div class="region" data-id="${r.id}"><b>块 ${r.id}</b> · ${r.pixels} 格（${(r.pixels / 100).toFixed(2)} 公顷）
      <div class="tags">${TAGS.map(([k, t]) => `<button data-tag="${k}" class="${r.tags.includes(k) ? 'on' : ''}">${t}</button>`).join('')}</div>
      <input data-note value="${(r.note || '').replace(/"/g, '&quot;')}" placeholder="备注（可不填）"></div>`).join('') : '<p class="muted small">还没有涂“变化”。</p>';
    let n = [0, 0, 0, 0]; for (let i = 0; i < N * N; i++) n[st[i]]++;
    $('countInfo').textContent = `变化 ${n[1]} 格 · 拿不准 ${n[2]} · 看过没变 ${n[0]} · 还没看 ${n[3]}（导出时记 255）`;
  }
  $('regions').addEventListener('click', e => { const b = e.target.closest('button[data-tag]'); if (!b) return; const r = regions.find(x => x.id === Number(b.closest('.region').dataset.id)); const t = b.dataset.tag; r.tags = r.tags.includes(t) ? r.tags.filter(x => x !== t) : [...r.tags, t]; renderRegions(); drafts[W[cur].wid] = true; saveDraft(); });
  $('regions').addEventListener('input', e => { if (!e.target.dataset || e.target.dataset.note === undefined) return; const r = regions.find(x => x.id === Number(e.target.closest('.region').dataset.id)); if (r) { r.note = e.target.value; drafts[W[cur].wid] = true; clearTimeout(changed.t); changed.t = setTimeout(saveDraft, 500); } });
  function seg(id, set) { $(id).onclick = e => { const b = e.target.closest('button'); if (!b) return; set(b.dataset.v); $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }; }
  seg('valOpts', v => { val = Number(v); }); seg('sizeOpts', v => { size = Number(v); }); seg('shapeOpts', v => { shape = v; });
  const pick = (id, v) => { const b = $(id).querySelector(`button[data-v="${v}"]`); if (b) b.click(); };
  $('allSeen').onclick = () => { pushUndo(); for (let i = 0; i < N * N; i++) if (st[i] === 3) st[i] = 0; changed(); };
  $('undoBtn').onclick = () => { if (!undo.length) return; redo.push(st.slice()); st = undo.pop(); changed(); };
  $('redoBtn').onclick = () => { if (!redo.length) return; undo.push(st.slice()); st = redo.pop(); changed(); };

  // ---------------------------------------------------------------- 保存
  function tick() { if (t0 !== null) { secs += (performance.now() - t0) / 1000; t0 = performance.now(); } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') t0 = performance.now(); else { tick(); t0 = null; saveDraft(); } });
  const record = () => ({ state_b64: b64(st), regions: regions.map(r => ({ id: r.id, pixels: r.pixels, tags: r.tags, note: r.note || '' })), seconds: Math.round(secs) });
  async function saveDraft() { if (cur < 0 || !drafts[W[cur].wid]) return; tick(); await DB.set(`pdraft|${who}|${W[cur].wid}`, { ...record(), updated_at: nowIso() }); }
  function problems() {
    const p = [];
    if (regions.some(r => !r.tags.length)) p.push(`块 ${regions.filter(r => !r.tags.length).map(r => r.id).join('、')} 还没选类型`);
    if (!regions.length) { let unsure = 0; for (let i = 0; i < N * N; i++) if (st[i] === 2) unsure++; if (!unsure) p.push('一格“变化”也没涂：如果你认为这里没有变化，请涂“拿不准”或在任一块写备注后，再问组长'); }
    return p;
  }
  async function save() {
    tick(); const p = problems(); if (p.length) { $('msg').textContent = '还差：\n' + p.join('\n'); return; }
    const rec = { ...record(), saved_at: nowIso() }, wid = W[cur].wid;
    saved[wid] = rec; delete drafts[wid];
    await DB.set(`psaved|${who}|${wid}`, rec); await DB.del(`pdraft|${who}|${wid}`);
    toast(`已保存 ${wid}`); renderList(); go(1);
  }
  $('saveBtn').onclick = save;

  // ---------------------------------------------------------------- 列表、切换
  function statusOf(wid) { return drafts[wid] ? (saved[wid] ? '改了没保存' : '做了一半') : saved[wid] ? '已保存' : '没做'; }
  function renderList() {
    $('wlist').innerHTML = W.map((w, i) => { const s = statusOf(w.wid); return `<div class="witem ${i === cur ? 'cur' : ''}" data-i="${i}"><b>${w.wid}</b><span class="st ${s === '已保存' ? 'saved' : s === '没做' ? '' : 'draft'}">${s}</span><span class="d">${w.before.date} → ${w.after.date}</span></div>`; }).join('');
    $('listCount').textContent = `${W.length} 个`; $('progText').textContent = `已保存 ${Object.keys(saved).length} / ${W.length}`;
  }
  $('wlist').addEventListener('click', e => { const el = e.target.closest('.witem'); if (el) openWin(Number(el.dataset.i)); });
  async function openWin(i) {
    if (i < 0 || i >= W.length) return;
    if (cur >= 0) { tick(); await saveDraft(); }
    cur = i; const w = W[i];
    const rec = (await DB.get(`pdraft|${who}|${w.wid}`)) || saved[w.wid];
    st = rec ? unb64(rec.state_b64) : new Uint8Array(N * N).fill(3);
    compMap = null; regions = (rec && rec.regions) || []; undo = []; redo = []; secs = (rec && rec.seconds) || 0; t0 = performance.now();
    const keep = regions; recomputeRegions(); regions.forEach(r => { const o = keep.find(x => x.id === r.id); if (o) { r.tags = o.tags; r.note = o.note; } });
    paintLayer(); renderRegions();
    $('curWid').textContent = w.wid; $('capB').textContent = `${w.before.date} · ${w.before.sat || ''} ${w.before.orbit || ''}`; $('capA').textContent = `${w.after.date} · ${w.after.sat || ''} ${w.after.orbit || ''}`;
    $('pairInfo').textContent = `两期相隔 ${w.gap_days} 天`;
    const h = (LIST[w.wid] || {}).hint; $('hint').hidden = !h; $('hint').textContent = h ? `组长提示：${h}（青色虚线是参考位置）` : '';
    $('msg').textContent = ''; renderList(); resetView();
  }
  function go(d) { const n = cur + d; if (n >= 0 && n < W.length) openWin(n); else toast('没有了'); }
  const toggles = { tcBtn: () => { fc = !fc; $('tcBtn').textContent = fc ? '假彩色' : '真彩色'; }, lBtn: () => { showL = !showL; }, rBtn: () => { showR = !showR; }, fBtn: () => { full = !full; resetView(); } };
  for (const [id, fn] of Object.entries(toggles)) $(id).onclick = () => { fn(); if (id !== 'tcBtn') $(id).classList.toggle('on'); draw(); };
  document.addEventListener('keydown', e => {
    const tg = e.target; if ((tg && tg.matches && tg.matches('input, textarea, select')) || !$('whoModal').hidden) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undoBtn').click(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redoBtn').click(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); go(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === ' ') { e.preventDefault(); if (!flick) { flick = true; $('flickTag').hidden = false; draw(); } }
    else if (e.key === '1') pick('valOpts', 1); else if (e.key === '2') pick('valOpts', 2); else if (e.key === '3') pick('valOpts', 0);
    else if (/^b$/i.test(e.key)) pick('shapeOpts', 'brush'); else if (/^g$/i.test(e.key)) pick('shapeOpts', 'rect');
    else if (/^t$/i.test(e.key)) $('tcBtn').click(); else if (/^f$/i.test(e.key)) $('fBtn').click(); else if (/^l$/i.test(e.key)) $('lBtn').click();
  });
  document.addEventListener('keyup', e => { if (e.key === ' ' && flick) { flick = false; $('flickTag').hidden = true; draw(); } });
  window.addEventListener('beforeunload', () => { saveDraft(); });

  // ---------------------------------------------------------------- 判读人、导出、导入
  function askWho() { $('whoInput').value = who; $('whoModal').hidden = false; }
  $('whoBtn').onclick = askWho;
  $('whoOk').onclick = async () => { const v = $('whoInput').value.trim().slice(0, 20); if (!v || /[\\/:*?"<>|]/.test(v)) { toast('名字为空或含特殊符号'); return; } who = v; localStorage.setItem(LS_WHO, who); $('whoName').textContent = who; $('whoModal').hidden = true; await loadMine(); openWin(0); };
  async function loadMine() { saved = {}; drafts = {}; for (const k of await DB.keys()) { const [kind, a, wid] = String(k).split('|'); if (a !== who) continue; if (kind === 'psaved') saved[wid] = await DB.get(k); if (kind === 'pdraft') drafts[wid] = true; } renderList(); }
  $('exportBtn').onclick = async () => {
    tick(); await saveDraft(); const ids = Object.keys(saved).sort(); if (!ids.length) { toast('还没有保存的精标'); return; }
    const out = { schema: 'ledger_desk_v3/precise/1', annotator: who, exported_at: nowIso(), size: N, items: {} };
    for (const wid of ids) {
      const s = unb64(saved[wid].state_b64), lab = new Uint8Array(N * N);
      for (let i = 0; i < N * N; i++) lab[i] = s[i] === 0 ? 0 : s[i] === 1 ? 1 : 255;
      out.items[wid] = { label_b64: b64(lab), state_b64: saved[wid].state_b64, regions: saved[wid].regions, seconds: saved[wid].seconds, saved_at: saved[wid].saved_at };
    }
    const d = new Date(), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = `影像精标_${who}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`; a.click();
    toast(`已导出 ${ids.length} 个窗口`);
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; let js; try { js = JSON.parse(await f.text()); } catch { toast('读不了'); return; }
    if (js.schema !== 'ledger_desk_v3/precise/1') { toast('不是精标导出文件'); return; }
    let n = 0; for (const [wid, it] of Object.entries(js.items)) { const k = `psaved|${js.annotator}|${wid}`, old = await DB.get(k); if (old && old.saved_at >= it.saved_at) continue; await DB.set(k, { state_b64: it.state_b64, regions: it.regions, seconds: it.seconds, saved_at: it.saved_at }); n++; }
    e.target.value = ''; if (js.annotator !== who) { who = js.annotator; localStorage.setItem(LS_WHO, who); $('whoName').textContent = who; }
    await loadMine(); if (W.length) openWin(Math.max(0, cur)); toast(`导入 ${n} 个`);
  };

  async function init() {
    let blind, list;
    try {
      blind = await fetch(DATA + 'windows_blind.json', { cache: 'no-cache' }).then(r => r.json());
      list = await fetch(DATA + 'precise_list.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('没有 precise_list.json'); return r.json(); });
    } catch (err) { $('wlist').innerHTML = `<p class="msg" style="padding:10px">${err.message}：组长裁定后才有要精标的窗口。</p>`; return; }
    LIST = Object.fromEntries((list.windows || []).map(x => [x.wid, x]));
    W = (blind.windows || []).filter(w => LIST[w.wid]);
    who = localStorage.getItem(LS_WHO) || ''; $('whoName').textContent = who || '未填写';
    if (!who) { renderList(); askWho(); return; }
    await loadMine(); if (W.length) openWin(0);
  }
  window.__precise = { get st() { return st; }, get regions() { return regions; }, get W() { return W; }, openWin, save, problems };
  init();
})();
