// 铁路沿线影像判读台：同学判读页（2026-10-06，Claude）。数据接口见本台“任务\接口约定.md”。
// 只读同学版 ../data/windows_blind.json，不连任何网络服务；结果存在本机浏览器（IndexedDB），导出 JSON 交回。
'use strict';
(() => {
  const DATA = '../data/';
  const LS_WHO = 'ledger_v3_who';
  const QL = [
    { k: 'yes', t: '清楚', h: '地面看得清清楚楚' },
    { k: 'blurry', t: '整体模糊，但还能看', h: '整幅发灰、发雾或偏暗，地物认得出' },
    { k: 'partial', t: '有些地方看不清', h: '局部被云、云影、黑块挡住' },
    { k: 'no', t: '基本看不清', h: '整幅被云雾盖住，这一对不用再比' },
  ];
  const REASONS = [['cloud', '云'], ['cloud_shadow', '云影'], ['haze', '雾 / 霾'], ['terrain_shadow', '山影 / 阴影'], ['missing', '黑块 / 缺测'],
    ['stripe', '条纹'], ['brightness', '太亮 / 太暗'], ['blur', '模糊'], ['other', '其他']];
  const CHANGE = [['yes', '有真实变化'], ['imaging', '只有成像差异'], ['no', '看不出差别'], ['unsure', '拿不准']];
  const CHANGE_HINT = {
    yes: '地面本身变了：新的裸土、施工、植被没了或长出来、水面变大变小、沟道冲刷堆积等。在图上标出来。',
    imaging: '只是颜色、亮度、清晰程度、错位或云影位置不同，地面本身没变。',
    no: '仔细看过，两期地面一样。',
    unsure: '看着像变了又说不准，在图上标出你拿不准的地方，写备注。',
  };
  const TAGS = [['bare+', '裸土 / 施工 增加'], ['bare-', '裸土 / 施工 减少'], ['veg-', '植被 减少'], ['veg+', '植被 增加'], ['water+', '水面 扩大'],
    ['water-', '水面 缩小'], ['gully', '沟道冲刷或堆积'], ['road+', '道路 增加'], ['road-', '道路 减少'], ['building+', '建筑 增加'],
    ['building-', '建筑 减少'], ['farm', '农田季节变化'], ['unclear', '有差别，说不清']];
  const CONF = [['high', '高'], ['mid', '中'], ['low', '低']];
  const HR = [[true, '要'], [false, '不要']];
  const SIDE_NAME = { before: '① 前一期', after: '② 后一期' };

  const $ = id => document.getElementById(id);
  const cvB = $('cvB'), cvA = $('cvA');
  let W = [], META = {}, who = '', cur = -1, item = null, saved = {}, drafts = {};
  let view = { scale: 1, ox: 0, oy: 0 };
  let full = false, fc = false, showQ = false, showR = true, showS = false, mode = 'pan', flick = false, selMark = null;
  let drag = null, timerT0 = null, draftTimer = null;
  const imgCache = new Map();

  // ---------------------------------------------------------------- 本机存储（IndexedDB）
  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('ledger_desk_v3', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const op = async (m, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', m); const rq = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error);
      });
    };
    return { get: k => op('readonly', s => s.get(k)), set: (k, v) => op('readwrite', s => s.put(v, k)),
      keys: () => op('readonly', s => s.getAllKeys()), del: k => op('readwrite', s => s.delete(k)) };
  })();

  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  function nowIso() {
    const d = new Date(), off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }
  function toast(t, ms = 1800) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms); }
  function blank(wid) {
    return { wid, quality: { before: { level: null, reasons: [], note: '' }, after: { level: null, reasons: [], note: '' } },
      change: null, marks: [], confidence: null, need_hr: null, note: '', seconds: 0, next_id: 1, updated_at: null };
  }

  async function loadMine() {
    saved = {}; drafts = {};
    for (const k of await DB.keys()) {
      const [kind, w, wid] = String(k).split('|');
      if (w !== who) continue;
      if (kind === 'saved') saved[wid] = await DB.get(k);
      if (kind === 'draft') drafts[wid] = await DB.get(k);
    }
  }
  function statusOf(wid) {
    if (drafts[wid]) return saved[wid] ? 'changed' : 'draft';
    return saved[wid] ? 'saved' : 'todo';
  }

  // ---------------------------------------------------------------- 影像
  function getImg(path) {
    if (!path) return null;
    if (!imgCache.has(path)) {
      const im = new Image(); im.src = DATA + path; im.onload = () => draw(); imgCache.set(path, im);
    }
    const im = imgCache.get(path);
    return im.complete && im.naturalWidth ? im : null;
  }
  function preload(i) { const w = W[i]; if (w) Object.values(w.img).forEach(p => getImg(p)); }

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }
  let lastSize = null;
  function resetView() {
    const span = full ? 200 : 120, r = cvB.getBoundingClientRect();
    view.scale = Math.min(r.width, r.height) / span;
    view.ox = 100 - r.width / 2 / view.scale; view.oy = 100 - r.height / 2 / view.scale;
    lastSize = { w: r.width, h: r.height };
    draw();
  }
  // 窗口大小变了：保持画面中心那一点不动，放大倍数按画布短边等比例缩放
  new ResizeObserver(() => {
    const r = cvB.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (lastSize && cur >= 0) {
      const cx = view.ox + lastSize.w / 2 / view.scale, cy = view.oy + lastSize.h / 2 / view.scale;
      const k = Math.min(r.width, r.height) / Math.min(lastSize.w, lastSize.h);
      if (Number.isFinite(k) && k > 0) view.scale *= k;
      view.ox = cx - r.width / 2 / view.scale; view.oy = cy - r.height / 2 / view.scale;
    }
    lastSize = { w: r.width, h: r.height };
    draw();
  }).observe(cvB);
  const toImg = (cv, e) => { const r = cv.getBoundingClientRect(); return [view.ox + (e.clientX - r.left) / view.scale, view.oy + (e.clientY - r.top) / view.scale]; };

  function draw() {
    if (cur < 0) return;
    const w = W[cur], dpr = window.devicePixelRatio || 1;
    for (const [cv, side] of [[cvB, 'b'], [cvA, 'a']]) {
      fitCanvas(cv);
      const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
      const s = side === 'a' && flick ? 'b' : side, k = dpr * view.scale;
      ctx.setTransform(k, 0, 0, k, -view.ox * k, -view.oy * k);
      ctx.imageSmoothingEnabled = false;
      const base = getImg(w.img[`${s}_${fc ? 'fc' : 'tc'}`]);
      if (base) ctx.drawImage(base, 0, 0, 200, 200);
      if (showQ) { const q = getImg(w.img[`${s}_q`]); if (q) ctx.drawImage(q, 0, 0, 200, 200); }
      if (showS && w.img.src) { const q = getImg(w.img.src); if (q) ctx.drawImage(q, 0, 0, 200, 200); }
      if (showR && w.img.rings) { const q = getImg(w.img.rings); if (q) ctx.drawImage(q, 0, 0, 200, 200); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawMarks(ctx, dpr);
    }
  }
  function drawMarks(ctx, dpr) {
    const P = (x, y) => [(x - view.ox) * view.scale * dpr, (y - view.oy) * view.scale * dpr];
    ctx.font = `${12 * dpr}px sans-serif`; ctx.textBaseline = 'bottom';
    for (const m of item ? item.marks : []) {
      const sel = selMark === m.id;
      ctx.lineWidth = (sel ? 3 : 2) * dpr; ctx.strokeStyle = '#ffd400'; ctx.fillStyle = '#ffd400';
      let lx, ly;
      if (m.kind === 'point') {
        const [x, y] = P(m.xy[0], m.xy[1]);
        ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2); ctx.strokeStyle = '#000'; ctx.lineWidth = (sel ? 5 : 4) * dpr; ctx.stroke();
        ctx.strokeStyle = '#ffd400'; ctx.lineWidth = (sel ? 3 : 2) * dpr; ctx.stroke();
        lx = x + 8 * dpr; ly = y - 6 * dpr;
      } else {
        const [x0, y0] = P(m.box[0], m.box[1]), [x1, y1] = P(m.box[2], m.box[3]);
        ctx.strokeStyle = '#000'; ctx.lineWidth = (sel ? 5 : 4) * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = '#ffd400'; ctx.lineWidth = (sel ? 3 : 2) * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        lx = x0; ly = y0 - 2 * dpr;
      }
      ctx.fillStyle = '#000'; ctx.fillRect(lx - 1, ly - 14 * dpr, ctx.measureText(String(m.id)).width + 6 * dpr, 14 * dpr);
      ctx.fillStyle = '#ffd400'; ctx.fillText(String(m.id), lx + 2 * dpr, ly);
    }
    if (drag && drag.kind === 'box') {
      const [x0, y0] = P(drag.x0, drag.y0), [x1, y1] = P(drag.x1, drag.y1);
      ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2 * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    }
  }

  // ---------------------------------------------------------------- 鼠标
  function hit(x, y) {
    const tol = 8 / view.scale;
    for (const m of [...item.marks].reverse()) {
      if (m.kind === 'point' && Math.hypot(m.xy[0] - x, m.xy[1] - y) <= tol) return m.id;
      if (m.kind === 'box' && x >= m.box[0] - tol && x <= m.box[2] + tol && y >= m.box[1] - tol && y <= m.box[3] + tol) return m.id;
    }
    return null;
  }
  function marksAllowed() { return item && (item.change === 'yes' || item.change === 'unsure'); }
  for (const cv of [cvB, cvA]) {
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const [x, y] = toImg(cv, e), r = cv.getBoundingClientRect();
      const f = e.deltaY < 0 ? 1.25 : 0.8, minS = Math.min(r.width, r.height) / 240, maxS = 40;
      view.scale = Math.min(maxS, Math.max(minS, view.scale * f));
      view.ox = x - (e.clientX - r.left) / view.scale; view.oy = y - (e.clientY - r.top) / view.scale;
      draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      if (cur < 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* 合成的指针没有活动指针时忽略 */ }
      const [x, y] = toImg(cv, e);
      if (mode === 'pan' || e.button !== 0) {
        const h = e.button === 0 ? hit(x, y) : null;
        if (h !== null) { selMark = h; renderMarks(); draw(); }
        drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, ox: view.ox, oy: view.oy, cv };
        return;
      }
      if (!marksAllowed()) { toast('先在③选“有真实变化”或“拿不准”，再标位置'); return; }
      if (mode === 'point') { addMark({ kind: 'point', xy: [round1(x), round1(y)] }); return; }
      if (mode === 'box') drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, cv };
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        view.ox = drag.ox - (e.clientX - drag.cx) / view.scale; view.oy = drag.oy - (e.clientY - drag.cy) / view.scale; draw();
      } else { [drag.x1, drag.y1] = toImg(drag.cv, e); draw(); }
    });
    cv.addEventListener('pointerup', () => {
      if (drag && drag.kind === 'box') {
        const b = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)].map(v => round1(Math.min(200, Math.max(0, v))));
        drag = null;
        if (b[2] - b[0] >= 1 && b[3] - b[1] >= 1) addMark({ kind: 'box', box: b }); else draw();
        return;
      }
      drag = null;
    });
  }
  const round1 = v => Math.round(v * 10) / 10;

  // ---------------------------------------------------------------- 表单
  function buildStatic() {
    document.querySelectorAll('.opts.q').forEach(box => {
      const side = box.dataset.side;
      box.innerHTML = QL.map((q, i) => `<button data-q="${q.k}" title="${q.h}（快捷键 ${i + 1}）">${q.t}<small>${q.h}</small></button>`).join('');
      box.onclick = e => { const b = e.target.closest('button'); if (b) setQuality(side, b.dataset.q); };
    });
    document.querySelectorAll('.reasons').forEach(box => {
      const side = box.dataset.side;
      box.innerHTML = REASONS.map(([k, t]) => `<label><input type="checkbox" value="${k}">${t}</label>`).join('');
      box.onchange = () => {
        const q = item.quality[side];
        if (!q.level || q.level === 'yes') { renderForm(); return; }   // 清楚的那一期不收原因
        q.reasons = [...box.querySelectorAll('input:checked')].map(i => i.value); changed(); renderForm();
      };
    });
    document.querySelectorAll('.qnote').forEach(inp => { inp.oninput = () => { item.quality[inp.dataset.side].note = inp.value; changed(); }; });
    $('changeOpts').innerHTML = CHANGE.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
    $('changeOpts').onclick = e => { const b = e.target.closest('button'); if (!b) return; item.change = b.dataset.v; if (marksAllowed() && mode === 'pan') setMode('point'); changed(); renderForm(); };
    $('confOpts').innerHTML = CONF.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
    $('confOpts').onclick = e => { const b = e.target.closest('button'); if (!b) return; item.confidence = b.dataset.v; changed(); renderForm(); };
    $('hrOpts').innerHTML = HR.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
    $('hrOpts').onclick = e => { const b = e.target.closest('button'); if (!b) return; item.need_hr = b.dataset.v === 'true'; changed(); renderForm(); };
    $('note').oninput = () => { item.note = $('note').value; changed(); };
  }
  function setQuality(side, level) {
    item.quality[side].level = level;
    if (level === 'yes') { item.quality[side].reasons = []; item.quality[side].note = ''; }
    changed(); renderForm();
  }
  const anyNo = () => item.quality.before.level === 'no' || item.quality.after.level === 'no';
  function renderForm() {
    if (!item) return;
    for (const side of ['before', 'after']) {
      const q = item.quality[side];
      document.querySelectorAll(`.opts.q[data-side="${side}"] button`).forEach(b => b.classList.toggle('on', b.dataset.q === q.level));
      const rb = document.querySelector(`.reasons[data-side="${side}"]`);
      rb.hidden = !q.level || q.level === 'yes';
      rb.querySelectorAll('input').forEach(i => { i.checked = q.reasons.includes(i.value); });
      const nt = document.querySelector(`.qnote[data-side="${side}"]`);
      nt.hidden = !q.reasons.includes('other'); if (nt.value !== q.note) nt.value = q.note;
    }
    const qDone = item.quality.before.level && item.quality.after.level, no = anyNo();
    $('stepA').classList.toggle('off', !item.quality.before.level);
    $('stepC').classList.toggle('off', !qDone || no);
    $('stepM').classList.toggle('off', !qDone || no || !marksAllowed());
    $('stepE').classList.toggle('off', !qDone || no);
    $('changeOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === item.change));
    $('changeHint').textContent = no ? '有一期基本看不清，这一对不用比，直接保存。' : (CHANGE_HINT[item.change] || '');
    $('confOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === item.confidence));
    $('hrOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', item.need_hr !== null && String(item.need_hr) === b.dataset.v));
    if ($('note').value !== item.note) $('note').value = item.note;
    renderMarks();
    showProblems(false);
  }
  function renderMarks() {
    const box = $('marks');
    if (!item.marks.length) { box.innerHTML = `<p class="muted small">${marksAllowed() ? '还没有标。点上方“点”或“框”，在左右任一图上标。' : '③ 选“有真实变化”或“拿不准”后再标。'}</p>`; return; }
    box.innerHTML = item.marks.map(m => `<div class="mark ${selMark === m.id ? 'sel' : ''}" data-id="${m.id}">
      <div class="mh"><b>${m.id}</b><span>${m.kind === 'point' ? '点' : '框'}</span><span class="sp"></span>
      <button class="ghost small" data-act="go">看这里</button><button class="ghost small" data-act="del">删除</button></div>
      <div class="tags">${TAGS.map(([k, t]) => `<button data-tag="${k}" class="${m.tags.includes(k) ? 'on' : ''}">${t}</button>`).join('')}</div>
      <input data-act="note" value="${(m.note || '').replace(/"/g, '&quot;')}" placeholder="这一处的备注（可不填）"></div>`).join('');
  }
  $('marks').addEventListener('click', e => {
    const card = e.target.closest('.mark'); if (!card) return;
    const m = item.marks.find(x => x.id === Number(card.dataset.id)); if (!m) return;
    selMark = m.id;
    const b = e.target.closest('button');
    if (b && b.dataset.tag) { const t = b.dataset.tag; m.tags = m.tags.includes(t) ? m.tags.filter(x => x !== t) : [...m.tags, t]; changed(); }
    else if (b && b.dataset.act === 'del') { item.marks = item.marks.filter(x => x.id !== m.id); selMark = null; changed(); }
    else if (b && b.dataset.act === 'go') {
      const [cx, cy] = m.kind === 'point' ? m.xy : [(m.box[0] + m.box[2]) / 2, (m.box[1] + m.box[3]) / 2], r = cvB.getBoundingClientRect();
      view.ox = cx - r.width / 2 / view.scale; view.oy = cy - r.height / 2 / view.scale;
    }
    renderMarks(); draw();
  });
  $('marks').addEventListener('input', e => {
    if (e.target.dataset.act !== 'note') return;
    const m = item.marks.find(x => x.id === Number(e.target.closest('.mark').dataset.id)); if (m) { m.note = e.target.value; changed(); }
  });
  function addMark(m) {
    m.id = item.next_id++; m.tags = []; m.note = '';
    item.marks.push(m); selMark = m.id; changed(); renderMarks(); draw();
  }
  function problems() {
    const p = [];
    for (const side of ['before', 'after']) {
      const q = item.quality[side];
      if (!q.level) { p.push(`${SIDE_NAME[side]}：还没选清不清楚`); continue; }
      if (q.level !== 'yes' && !q.reasons.length) p.push(`${SIDE_NAME[side]}：不清楚的要选原因`);
      if (q.reasons.includes('other') && !q.note.trim()) p.push(`${SIDE_NAME[side]}：选了“其他”要写明`);
    }
    if (item.quality.before.level && item.quality.after.level && !anyNo()) {
      if (!item.change) p.push('③ 还没选有没有变化');
      if (marksAllowed() && !item.marks.length) p.push('④ 选了“有”或“拿不准”，要在图上至少标一处');
      if (item.change === 'yes' && item.marks.some(m => !m.tags.length)) p.push(`④ 第 ${item.marks.filter(m => !m.tags.length).map(m => m.id).join('、')} 处还没选变化类型`);
      if (!item.confidence) p.push('⑤ 还没选把握');
      if (item.need_hr === null) p.push('⑤ 还没选要不要高分影像');
    }
    return p;
  }
  function showProblems(force) {
    const p = problems(), el = $('msg');
    if (force && p.length) { el.className = 'msg'; el.textContent = '还差：\n' + p.join('\n'); }
    else if (!p.length) { el.className = 'msg ok'; el.textContent = '都填好了，可以保存。'; }
    else { el.className = 'msg'; el.textContent = ''; }
  }

  // ---------------------------------------------------------------- 存草稿、保存、计时
  function tick() {
    if (timerT0 !== null && item) { item.seconds = Math.round((item.seconds || 0) + (performance.now() - timerT0) / 1000); timerT0 = performance.now(); }
  }
  function startTimer() { timerT0 = document.visibilityState === 'visible' ? performance.now() : null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') startTimer(); else { tick(); timerT0 = null; flushDraft(); } });
  function changed() {
    if (!item) return;
    item.updated_at = nowIso();
    drafts[item.wid] = item;
    clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 400);
    renderListItem(cur);
  }
  async function flushDraft() {
    clearTimeout(draftTimer);
    if (!item || !drafts[item.wid]) return;
    tick();
    await DB.set(`draft|${who}|${item.wid}`, clone(item));
  }
  async function save(next) {
    tick();
    const p = problems();
    if (p.length) { showProblems(true); return; }
    const out = clone(item);
    for (const s of ['before', 'after']) if (out.quality[s].level === 'yes') { out.quality[s].reasons = []; out.quality[s].note = ''; }
    if (anyNo()) { out.change = null; out.marks = []; out.confidence = out.confidence || null; out.need_hr = out.need_hr ?? null; }
    out.saved_at = nowIso();
    saved[out.wid] = out; delete drafts[out.wid];
    await DB.set(`saved|${who}|${out.wid}`, out); await DB.del(`draft|${who}|${out.wid}`);
    item = clone(out);
    toast(`已保存 ${out.wid}`); renderList(); updateProgress();
    if (next) go(1); else renderForm();
  }

  // ---------------------------------------------------------------- 列表与切换
  const filterFns = {
    all: () => true, todo: w => statusOf(w.wid) === 'todo', draft: w => ['draft', 'changed'].includes(statusOf(w.wid)),
    saved: w => statusOf(w.wid) === 'saved', unsure: w => (drafts[w.wid] || saved[w.wid] || {}).change === 'unsure',
    change: w => (drafts[w.wid] || saved[w.wid] || {}).change === 'yes',
  };
  const ST = { todo: ['没做', ''], draft: ['做了一半', 'draft'], changed: ['改了没保存', 'draft'], saved: ['已保存', 'saved'] };
  function renderList() {
    const f = filterFns[$('filter').value] || filterFns.all;
    const shown = W.map((w, i) => [w, i]).filter(([w]) => f(w));
    $('wlist').innerHTML = shown.map(([w, i]) => itemHtml(w, i)).join('');
    $('listCount').textContent = `${shown.length} 个`;
    const el = $('wlist').querySelector('.cur'); if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function itemHtml(w, i) {
    const [t, c] = ST[statusOf(w.wid)];
    return `<div class="witem ${i === cur ? 'cur' : ''}" data-i="${i}"><b>${w.wid}</b><span class="st ${c}">${t}</span><span class="d">${w.before.date} → ${w.after.date}</span></div>`;
  }
  function renderListItem(i) {
    const el = $('wlist').querySelector(`.witem[data-i="${i}"]`); if (el) el.outerHTML = itemHtml(W[i], i);
  }
  $('wlist').addEventListener('click', e => { const el = e.target.closest('.witem'); if (el) openWin(Number(el.dataset.i)); });
  $('filter').onchange = renderList;
  function updateProgress() { $('progText').textContent = `已保存 ${Object.keys(saved).length} / ${W.length}`; }
  async function openWin(i) {
    if (i < 0 || i >= W.length) return;
    tick(); await flushDraft();
    cur = i; const w = W[i];
    item = clone(drafts[w.wid] || saved[w.wid] || blank(w.wid));
    if (!item.next_id) item.next_id = Math.max(0, ...item.marks.map(m => m.id)) + 1;
    selMark = null; drag = null;
    $('curWid').textContent = w.wid;
    $('capB').textContent = `${w.before.date} · ${w.before.sat || ''} ${w.before.orbit || ''}`;
    $('capA').textContent = `${w.after.date} · ${w.after.sat || ''} ${w.after.orbit || ''}`;
    $('pairInfo').textContent = `两期相隔 ${w.gap_days} 天${w.before.orbit && w.after.orbit && w.before.orbit !== w.after.orbit ? ' · 不同轨道（颜色可能整体不同）' : ''}`;
    $('sBtn').disabled = !w.img.src;
    if (!w.img.src && showS) { showS = false; $('sBtn').classList.remove('on'); }
    try { localStorage.setItem(`ledger_v3_last|${who}`, w.wid); } catch { /* ignore */ }
    renderList(); renderForm(); resetView(); startTimer(); preload(i + 1);
    $('timeInfo').textContent = item.seconds ? `这个窗口已用 ${Math.round(item.seconds / 60 * 10) / 10} 分钟` : '';
  }
  function go(d) {
    const f = filterFns[$('filter').value] || filterFns.all;
    for (let i = cur + d; i >= 0 && i < W.length; i += d) if (f(W[i]) || $('filter').value === 'all') return openWin(i);
    toast(d > 0 ? '已经是最后一个' : '已经是第一个');
  }

  // ---------------------------------------------------------------- 工具栏、快捷键
  function setMode(m) { mode = m; document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m)); }
  $('modeSeg').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); };
  const toggles = { tcBtn: () => { fc = !fc; $('tcBtn').textContent = fc ? '假彩色' : '真彩色'; }, qBtn: () => { showQ = !showQ; }, rBtn: () => { showR = !showR; },
    sBtn: () => { showS = !showS; }, fBtn: () => { full = !full; resetView(); } };
  for (const [id, fn] of Object.entries(toggles)) $(id).onclick = () => { fn(); if (id !== 'tcBtn') $(id).classList.toggle('on'); draw(); };
  $('saveBtn').onclick = () => save(true);
  document.addEventListener('keydown', e => {
    const tg = e.target;
    if ((tg && tg.matches && tg.matches('input, textarea, select')) || !$('whoModal').hidden || !$('keysModal').hidden) return;
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); go(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (k === 'Enter') { e.preventDefault(); save(true); }
    else if (k === ' ') { e.preventDefault(); if (!flick) { flick = true; $('flickTag').hidden = false; draw(); } }
    else if (k === 'Escape') { drag = null; draw(); }
    else if (/^[1-4]$/.test(k) && item) { const side = !item.quality.before.level ? 'before' : 'after'; setQuality(side, QL[Number(k) - 1].k); }
    else if (/^[hpb]$/i.test(k)) setMode({ h: 'pan', p: 'point', b: 'box' }[k.toLowerCase()]);
    else if (/^t$/i.test(k)) $('tcBtn').click();
    else if (/^q$/i.test(k)) $('qBtn').click();
    else if (/^r$/i.test(k)) $('rBtn').click();
    else if (/^s$/i.test(k)) { if (!$('sBtn').disabled) $('sBtn').click(); }
    else if (/^f$/i.test(k)) $('fBtn').click();
  });
  document.addEventListener('keyup', e => { if (e.key === ' ' && flick) { flick = false; $('flickTag').hidden = true; draw(); } });
  window.addEventListener('resize', () => draw());
  window.addEventListener('beforeunload', () => { tick(); if (item && drafts[item.wid]) DB.set(`draft|${who}|${item.wid}`, clone(item)); });

  // ---------------------------------------------------------------- 判读人、导出、导入
  function askWho() { $('whoInput').value = who; $('whoModal').hidden = false; setTimeout(() => $('whoInput').focus(), 50); }
  $('whoBtn').onclick = askWho;
  $('whoOk').onclick = async () => {
    const v = $('whoInput').value.trim().slice(0, 20);
    if (!v) { toast('请填名字'); return; }
    if (/[\\/:*?"<>|]/.test(v)) { toast('名字里不要有 \\ / : * ? " < > | 这些符号'); return; }
    tick(); await flushDraft();
    who = v; localStorage.setItem(LS_WHO, who); $('whoName').textContent = who; $('whoModal').hidden = true;
    await loadMine(); updateProgress();
    const last = localStorage.getItem(`ledger_v3_last|${who}`), i = W.findIndex(w => w.wid === last);
    openWin(i >= 0 ? i : 0);
  };
  $('whoInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('whoOk').click(); });
  $('keysBtn').onclick = () => { $('keysModal').hidden = false; };
  document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => { b.closest('.modal').hidden = true; }; });

  function strip(it) {
    const q = clone(it.quality);
    for (const s of ['before', 'after']) if (q[s].level === 'yes') { q[s].reasons = []; q[s].note = ''; }
    return { quality: q, change: it.change, marks: it.marks.map(m => (m.kind === 'point' ? { id: m.id, kind: 'point', xy: m.xy, tags: m.tags, note: m.note || '' }
      : { id: m.id, kind: 'box', box: m.box, tags: m.tags, note: m.note || '' })), confidence: it.confidence, need_hr: it.need_hr, note: it.note || '',
      seconds: it.seconds || 0, saved_at: it.saved_at };
  }
  $('exportBtn').onclick = async () => {
    tick(); await flushDraft();
    const ids = Object.keys(saved).sort();
    if (!ids.length) { toast('还没有保存的结果'); return; }
    const out = { schema: 'ledger_desk_v3/labels/1', annotator: who, package: META.package || '', exported_at: nowIso(), items: {} };
    for (const wid of ids) out.items[wid] = strip(saved[wid]);
    const d = new Date(), name = `影像判读_${who}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const nd = Object.keys(drafts).length;
    toast(`已导出 ${ids.length} 个窗口：${name}${nd ? `；还有 ${nd} 个做了一半的没导出` : ''}`, 4000);
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async e => {
    let n = 0, skip = 0;
    for (const f of e.target.files) {
      let js;
      try { js = JSON.parse(await f.text()); } catch { toast(`${f.name} 不是有效的 JSON`); continue; }
      if (js.schema !== 'ledger_desk_v3/labels/1' || !js.items) { toast(`${f.name} 不是本台导出的文件`); continue; }
      if (js.annotator !== who && !confirm(`文件里的判读人是“${js.annotator}”，现在是“${who}”。要导入到“${js.annotator}”名下吗？（导入后会切换到这个名字）`)) continue;
      const owner = js.annotator;
      for (const [wid, it] of Object.entries(js.items)) {
        if (!W.some(w => w.wid === wid)) { skip++; continue; }
        const key = `saved|${owner}|${wid}`, old = await DB.get(key);
        if (old && old.saved_at && it.saved_at && old.saved_at >= it.saved_at) { skip++; continue; }
        const rec = { ...blank(wid), ...clone(it), wid, next_id: Math.max(0, ...(it.marks || []).map(m => m.id)) + 1 };
        await DB.set(key, rec); n++;
      }
      if (owner !== who) { who = owner; localStorage.setItem(LS_WHO, who); $('whoName').textContent = who; }
    }
    e.target.value = '';
    await loadMine(); updateProgress(); renderList(); if (cur >= 0) openWin(cur);
    toast(`导入 ${n} 个窗口${skip ? `，跳过 ${skip} 个（本机的更新或不在本包里）` : ''}`, 3500);
  };

  // ---------------------------------------------------------------- 启动
  async function init() {
    buildStatic();
    try { META = await fetch(DATA + 'windows_blind.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }); }
    catch (err) { $('wlist').innerHTML = `<p class="msg" style="padding:10px">读不到 data/windows_blind.json（${err.message}）。请用“启动判读台.bat”打开。</p>`; return; }
    W = META.windows || [];
    who = localStorage.getItem(LS_WHO) || '';
    $('whoName').textContent = who || '未填写';
    if (!who) { renderList(); askWho(); return; }
    await loadMine(); updateProgress();
    const last = localStorage.getItem(`ledger_v3_last|${who}`), i = W.findIndex(w => w.wid === last);
    openWin(i >= 0 ? i : 0);
  }
  window.__desk = { get item() { return item; }, get W() { return W; }, get view() { return view; }, save, openWin, problems };
  init();
})();
