// 台账事件判读台：组长裁定页（2026-10-06，Claude）。读组长版 ../data/windows_full.json（敏感），导入同学交回的判读 JSON，逐窗口裁定并导出。
'use strict';
(() => {
  const DATA = '../data/';
  const VERDICT = [['A', 'A 台账事件', '看得到台账说的事件（类型、位置、时间都对得上）'], ['B', 'B 别的真实变化', '有真实变化，但不是台账说的那件事'],
    ['C', 'C 成像差异', '只有颜色、亮度、清晰程度、错位、云影这类差异'], ['D', 'D 看不出差别', '两期地面一样'], ['E', 'E 拿不准', '像有变化但说不准，写备注'],
    ['X', 'X 不能判', '两期里有一期基本看不清']];
  const POS = [['damage_point', '受损点附近'], ['source_area', '源区'], ['elsewhere', '窗口里别处']];
  const YN = [[true, '要'], [false, '不要']];
  const QRANK = { yes: 0, blurry: 1, partial: 2, no: 3 };
  const QNAME = { yes: '清楚', blurry: '整体模糊', partial: '局部看不清', no: '基本看不清' };
  const CHNAME = { yes: '有真实变化', imaging: '只有成像差异', no: '看不出差别', unsure: '拿不准' };
  const TAGNAME = { 'bare+': '裸土增加', 'bare-': '裸土减少', 'veg-': '植被减少', 'veg+': '植被增加', 'water+': '水面扩大', 'water-': '水面缩小', gully: '沟道冲刷堆积',
    'road+': '道路增加', 'road-': '道路减少', 'building+': '建筑增加', 'building-': '建筑减少', farm: '农田季节', unclear: '说不清' };
  const REASON = { cloud: '云', cloud_shadow: '云影', haze: '雾', terrain_shadow: '山影', missing: '缺测', stripe: '条纹', brightness: '亮暗', blur: '模糊', other: '其他' };
  const COLORS = ['#ffd400', '#00e5ff', '#ff4fd8', '#7CFC00', '#ff8c00', '#ffffff'];
  const $ = id => document.getElementById(id);
  const cvB = $('cvB'), cvA = $('cvA');
  let W = [], cur = -1, labels = {}, people = [], hidden = new Set(), verdicts = {}, v = null;
  let view = { scale: 1, ox: 0, oy: 0 }, full = false, fc = false, showQ = false, showR = true, showS = false, showAI = false, flick = false, drag = null, lastSize = null;
  const imgCache = new Map();

  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('ledger_desk_v3_leader', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const op = async (m, fn) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction('kv', m); const rq = fn(tx.objectStore('kv')); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error); }); };
    return { get: k => op('readonly', s => s.get(k)), set: (k, x) => op('readwrite', s => s.put(x, k)), keys: () => op('readonly', s => s.getAllKeys()) };
  })();
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function nowIso() { const d = new Date(), o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${o >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; }
  function toast(t, ms = 2000) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms); }
  const imgOf = (w, k) => (w.img && w.img[k]) || `img/${w.wid}/${k}.png`;

  // ---------------------------------------------------------------- 是否要裁定
  function needOf(w) {
    if (verdicts[w.wid]) return 'done';
    const L = Object.values(labels[w.wid] || {});
    if (!L.length) return 'none';
    if (L.some(x => x.change === 'yes' || x.change === 'unsure')) return 'need';
    if (L.length >= 2) {
      if (new Set(L.map(x => x.change ?? 'null')).size > 1) return 'need';
      for (const s of ['before', 'after']) {
        const r = L.map(x => QRANK[x.quality[s].level] ?? 0);
        if (Math.max(...r) - Math.min(...r) >= 2) return 'need';
      }
    }
    return 'ok';
  }

  // ---------------------------------------------------------------- 画图（同同学页）
  function getImg(path) {
    if (!imgCache.has(path)) { const im = new Image(); im.src = DATA + path; im.onload = () => draw(); im.onerror = () => { im.bad = true; }; imgCache.set(path, im); }
    const im = imgCache.get(path); return im.complete && im.naturalWidth && !im.bad ? im : null;
  }
  function fitCanvas(cv) { const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect(); const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } }
  function resetView() { const span = full ? 200 : 120, r = cvB.getBoundingClientRect(); view.scale = Math.min(r.width, r.height) / span; view.ox = 100 - r.width / 2 / view.scale; view.oy = 100 - r.height / 2 / view.scale; lastSize = { w: r.width, h: r.height }; draw(); }
  new ResizeObserver(() => {
    const r = cvB.getBoundingClientRect(); if (!r.width || !r.height) return;
    if (lastSize && cur >= 0) { const cx = view.ox + lastSize.w / 2 / view.scale, cy = view.oy + lastSize.h / 2 / view.scale, k = Math.min(r.width, r.height) / Math.min(lastSize.w, lastSize.h); if (Number.isFinite(k) && k > 0) view.scale *= k; view.ox = cx - r.width / 2 / view.scale; view.oy = cy - r.height / 2 / view.scale; }
    lastSize = { w: r.width, h: r.height }; draw();
  }).observe(cvB);
  function draw() {
    if (cur < 0) return;
    const w = W[cur], dpr = window.devicePixelRatio || 1;
    for (const [cv, side] of [[cvB, 'b'], [cvA, 'a']]) {
      fitCanvas(cv); const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
      const s = side === 'a' && flick ? 'b' : side, k = dpr * view.scale;
      ctx.setTransform(k, 0, 0, k, -view.ox * k, -view.oy * k); ctx.imageSmoothingEnabled = false;
      const base = getImg(imgOf(w, `${s}_${fc ? 'fc' : 'tc'}`)); if (base) ctx.drawImage(base, 0, 0, 200, 200);
      const lay = [[showQ, `${s}_q`], [showS, 'src'], [showR, 'rings']];
      if (showAI && w.ai && w.ai.prob) lay.push([true, null]);
      for (const [on, key] of lay) { if (!on) continue; const im = getImg(key ? imgOf(w, key) : w.ai.prob); if (im) ctx.drawImage(im, 0, 0, 200, 200); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawMarks(ctx, dpr, w);
    }
  }
  function drawMarks(ctx, dpr, w) {
    const P = (x, y) => [(x - view.ox) * view.scale * dpr, (y - view.oy) * view.scale * dpr];
    ctx.font = `${11 * dpr}px sans-serif`; ctx.textBaseline = 'bottom';
    const used = new Set((v && v.marks_used || []).map(m => `${m.from}|${m.id}`));
    people.forEach((name, pi) => {
      if (hidden.has(name)) return;
      const it = (labels[w.wid] || {})[name]; if (!it) return;
      for (const m of it.marks || []) {
        const col = COLORS[pi % COLORS.length], on = used.has(`${name}|${m.id}`);
        ctx.lineWidth = (on ? 3.5 : 2) * dpr; ctx.strokeStyle = col; ctx.fillStyle = col;
        let lx, ly;
        if (m.kind === 'point') { const [x, y] = P(...m.xy); ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2); ctx.stroke(); lx = x + 8 * dpr; ly = y - 5 * dpr; }
        else { const [x0, y0] = P(m.box[0], m.box[1]), [x1, y1] = P(m.box[2], m.box[3]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); lx = x0; ly = y0 - 2 * dpr; }
        const t = `${name}#${m.id}`; ctx.fillStyle = '#000'; ctx.fillRect(lx - 1, ly - 13 * dpr, ctx.measureText(t).width + 4 * dpr, 13 * dpr); ctx.fillStyle = col; ctx.fillText(t, lx + 1, ly);
      }
    });
  }
  for (const cv of [cvB, cvA]) {
    cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(), x = view.ox + (e.clientX - r.left) / view.scale, y = view.oy + (e.clientY - r.top) / view.scale; view.scale = Math.min(40, Math.max(Math.min(r.width, r.height) / 240, view.scale * (e.deltaY < 0 ? 1.25 : 0.8))); view.ox = x - (e.clientX - r.left) / view.scale; view.oy = y - (e.clientY - r.top) / view.scale; draw(); }, { passive: false });
    cv.addEventListener('pointerdown', e => { try { cv.setPointerCapture(e.pointerId); } catch { /* 合成事件等没有活动指针时忽略 */ } drag = { cx: e.clientX, cy: e.clientY, ox: view.ox, oy: view.oy }; });
    cv.addEventListener('pointermove', e => { if (!drag) return; view.ox = drag.ox - (e.clientX - drag.cx) / view.scale; view.oy = drag.oy - (e.clientY - drag.cy) / view.scale; draw(); });
    cv.addEventListener('pointerup', () => { drag = null; });
  }

  // ---------------------------------------------------------------- 右侧
  function renderLedger(w) {
    const recs = (w.ledger && w.ledger.records) || [], sb = (w.select && w.select.before) || {}, sa = (w.select && w.select.after) || {};
    const HOW = { fair: '；较清楚（外圈有点云）', poor: '；勉强（范围内没有更好的）', fallback: '；后备' };
    const ph = s => (s && s.date ? `${s.date}（离台账日期 ${s.days >= 0 ? '+' : ''}${s.days} 天；500 米清楚 ${Math.round((s.q500 ?? 0) * 100)}%${s.q200 != null ? `，200 米 ${Math.round(s.q200 * 100)}%` : ''}${HOW[s.how] || ''}${s.nearest_scene_days != null && Math.abs(s.days) > s.nearest_scene_days + 10 ? `；最近的一景在 ${s.nearest_scene_days} 天，更近的都有云` : ''}）` : '—');
    $('ledgerBox').innerHTML = recs.map((r, i) => `<table>
      ${recs.length > 1 ? `<tr><td>记录 ${i + 1}</td><td>台账 ${esc(r.id)}</td></tr>` : `<tr><td>台账编号</td><td>${esc(r.id)}</td></tr>`}
      <tr><td>日期</td><td>${esc(r.date)}（${esc(r.date_meaning)}）${r.daynight ? ' · ' + esc(r.daynight) : ''}</td></tr>
      <tr><td>类型</td><td><b>${esc(r.type)}</b>（${esc(r.type_group)}）</td></tr>
      <tr><td>线路</td><td>${esc(r.line)} ${esc(r.section)} ${esc(r.mileage)}</td></tr>
      <tr><td>单位</td><td>${esc(r.unit)}</td></tr>
      <tr><td>描述</td><td>${esc(r.desc)}</td></tr>
      ${r.cause ? `<tr><td>原因</td><td>${esc(r.cause)}</td></tr>` : ''}${r.remark ? `<tr><td>备注</td><td>${esc(r.remark)}</td></tr>` : ''}
      ${r.recur_label ? `<tr><td>复发</td><td>${esc(r.recur_label)}</td></tr>` : ''}
      ${r.look_1002 ? `<tr><td>10-02 看图</td><td>${esc(r.look_1002)}</td></tr>` : ''}</table>`).join('<hr>') +
      `<table><tr><td>事件前</td><td>${ph(sb)}</td></tr><tr><td>事件后</td><td>${ph(sa)}</td></tr>${aiRow(w.ai)}</table>`;
  }
  // AI 提示（T12）：只数两期都清楚、概率 ≥ 阈值的格；“集中”= 200 米内比按全窗背景应有的多 3 倍以上且 ≥ 20 格
  const aiHot = a => !!a && a.px200 >= 20 && a.exp200 != null && a.px200 >= 3 * Math.max(a.exp200, 1);
  function aiRow(a) {
    if (!a) return '<tr><td>AI 提示</td><td class="muted">没有（还没预测，或两期不全）</td></tr>';
    return `<tr><td>AI 提示</td><td>${aiHot(a) ? '<span class="tag">集中在事件点附近</span> ' : ''}200 米内疑似变化 <b>${a.px200}</b> 格（按全窗背景应有约 ${a.exp200 ?? '—'} 格），500 米内 ${a.px500} 格；全窗背景 ${a.bg_permil ?? '—'}‰。
      <br><span class="muted small">点图上方“AI 预测”看位置。1 格约 10 × 10 米；只数两期都清楚、概率 ≥ ${a.thr ?? 0.5} 的格。模型只在三个测点上训过，两期间隔长时会把季节变化也报出来，只作参考，以看图为准。</span></td></tr>`;
  }
  function renderPeople(w) {
    const L = labels[w.wid] || {};
    if (!people.length) { $('peopleBox').innerHTML = '<p class="muted small">还没导入同学的判读。点上方“导入同学判读”。</p>'; return; }
    const used = new Set((v && v.marks_used || []).map(m => `${m.from}|${m.id}`));
    $('peopleBox').innerHTML = people.map((name, pi) => {
      const it = L[name];
      if (!it) return `<div class="person muted"><span class="dot" style="background:${COLORS[pi % COLORS.length]}"></span> ${esc(name)}：没判</div>`;
      const q = s => `${QNAME[it.quality[s].level] || '—'}${it.quality[s].reasons && it.quality[s].reasons.length ? '（' + it.quality[s].reasons.map(x => REASON[x] || x).join('、') + '）' : ''}`;
      return `<div class="person"><div class="ph"><span class="dot" style="background:${COLORS[pi % COLORS.length]}"></span><b>${esc(name)}</b><span class="sp"></span>
        <label><input type="checkbox" data-hide="${esc(name)}" ${hidden.has(name) ? '' : 'checked'}>显示</label></div>
        <div>前：${q('before')}；后：${q('after')}</div>
        <div>结论：<b>${CHNAME[it.change] || '（一期看不清，没比）'}</b>${it.confidence ? ` · 把握${{ high: '高', mid: '中', low: '低' }[it.confidence]}` : ''}${it.need_hr ? ' · 要高分' : ''}${it.seconds ? ` · ${Math.round(it.seconds)} 秒` : ''}</div>
        ${(it.marks || []).map(m => `<label><input type="checkbox" data-use="${esc(name)}|${m.id}" ${used.has(`${name}|${m.id}`) ? 'checked' : ''}>#${m.id} ${m.kind === 'point' ? '点' : '框'} ${(m.tags || []).map(t => TAGNAME[t] || t).join('、')}${m.note ? '：' + esc(m.note) : ''}</label>`).join('')}
        ${it.note ? `<div class="muted">备注：${esc(it.note)}</div>` : ''}</div>`;
    }).join('');
  }
  $('peopleBox').addEventListener('change', e => {
    const h = e.target.dataset.hide, u = e.target.dataset.use;
    if (h) { if (e.target.checked) hidden.delete(h); else hidden.add(h); draw(); }
    if (u) {
      const [from, id] = u.split('|'); v.marks_used = (v.marks_used || []).filter(m => !(m.from === from && String(m.id) === id));
      if (e.target.checked) v.marks_used.push({ from, id: Number(id) });
      draw();
    }
  });
  function buildForm() {
    $('vOpts').innerHTML = VERDICT.map(([k, t, h]) => `<button data-v="${k}" title="${h}">${t}</button>`).join('');
    $('vOpts').onclick = e => { const b = e.target.closest('button'); if (!b) return; v.verdict = b.dataset.v; if (['C', 'D', 'X'].includes(v.verdict)) { v.position = null; v.to_precise = false; } renderForm(); };
    $('posOpts').innerHTML = POS.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
    $('posOpts').onclick = e => { const b = e.target.closest('button'); if (b) { v.position = b.dataset.v; renderForm(); } };
    for (const [id, key] of [['hrOpts', 'need_hr'], ['prOpts', 'to_precise']]) {
      $(id).innerHTML = YN.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join('');
      $(id).onclick = e => { const b = e.target.closest('button'); if (b) { v[key] = b.dataset.v === 'true'; renderForm(); } };
    }
    $('vnote').oninput = () => { v.note = $('vnote').value; };
    $('vhint').oninput = () => { v.hint = $('vhint').value; };
  }
  function renderForm() {
    $('vOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v.verdict));
    $('vHint').textContent = (VERDICT.find(x => x[0] === v.verdict) || [])[2] || '';
    $('posOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v.position));
    $('hrOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', v.need_hr !== null && String(v.need_hr) === b.dataset.v));
    $('prOpts').querySelectorAll('button').forEach(b => b.classList.toggle('on', v.to_precise !== null && String(v.to_precise) === b.dataset.v));
    if ($('vnote').value !== (v.note || '')) $('vnote').value = v.note || '';
    if ($('vhint').value !== (v.hint || '')) $('vhint').value = v.hint || '';
    $('msg').textContent = '';
  }
  function problems() {
    const p = [];
    if (!v.verdict) p.push('还没选结论');
    if (['A', 'B'].includes(v.verdict) && !v.position) p.push('A、B 要选位置');
    if (['A', 'B', 'E'].includes(v.verdict) && v.to_precise === null) p.push('要不要进精标');
    if (v.need_hr === null) p.push('要不要高分核实');
    return p;
  }
  async function save() {
    const p = problems(); if (p.length) { $('msg').textContent = '还差：' + p.join('；'); return; }
    v.at = nowIso(); v.by = '组长'; verdicts[W[cur].wid] = clone(v); await DB.set(`verdict|${W[cur].wid}`, verdicts[W[cur].wid]);
    toast(`已裁定 ${W[cur].wid}`); go(1);
  }

  // ---------------------------------------------------------------- 列表
  const FILTER = { need: w => needOf(w) === 'need', done: w => needOf(w) === 'done', judged: w => !!labels[w.wid], all: () => true };
  function shown() { const f = FILTER[$('filter').value]; return W.map((w, i) => [w, i]).filter(([w]) => f(w)); }
  function renderList() {
    const s = shown();
    $('wlist').innerHTML = s.map(([w, i]) => { const n = needOf(w), L = Object.values(labels[w.wid] || {});
      return `<div class="witem ${i === cur ? 'cur' : ''}" data-i="${i}"><b>${w.wid}</b><span class="pill ${n === 'need' ? 'need' : n === 'done' ? 'done' : ''}">${{ need: '待裁定', done: verdicts[w.wid] ? verdicts[w.wid].verdict : '', ok: '无需', none: '没人判' }[n]}</span>
        <span class="d">${[(w.ledger && w.ledger.records[0] && w.ledger.records[0].type) || '', `${L.length} 人判`, L.map(x => CHNAME[x.change] || '看不清').join(' / '), aiHot(w.ai) ? 'AI 集中' : ''].filter(Boolean).join(' · ')}</span></div>`; }).join('');
    $('listCount').textContent = `${s.length} 个`;
    const el = $('wlist').querySelector('.cur'); if (el) el.scrollIntoView({ block: 'nearest' });
  }
  $('wlist').addEventListener('click', e => { const el = e.target.closest('.witem'); if (el) openWin(Number(el.dataset.i)); });
  $('filter').onchange = renderList;
  function openWin(i) {
    cur = i; const w = W[i];
    v = clone(verdicts[w.wid] || { verdict: null, marks_used: [], position: null, need_hr: null, to_precise: null, note: '', hint: '' });
    $('curWid').textContent = w.wid;
    const sb = (w.select && w.select.before) || {}, sa = (w.select && w.select.after) || {};
    $('capB').textContent = `${sb.date || ''} · ${sb.sat || ''} ${sb.orbit || ''}`; $('capA').textContent = `${sa.date || ''} · ${sa.sat || ''} ${sa.orbit || ''}`;
    $('pairInfo').textContent = `台账日期 ${w.event_date}`;
    renderLedger(w); renderPeople(w); renderForm(); renderList(); resetView();
  }
  function go(d) { const s = shown().map(([, i]) => i); const k = s.indexOf(cur); const n = s[k + d] ?? s.find(i => (d > 0 ? i > cur : i < cur)); if (n !== undefined) openWin(n); else { renderList(); toast('这个列表里没有了'); } }

  // ---------------------------------------------------------------- 导入、导出
  function agree() {
    let both = 0, same = 0;
    for (const wid of Object.keys(labels)) { const L = Object.values(labels[wid]); if (L.length < 2) continue; both++; if (new Set(L.map(x => x.change ?? 'null')).size === 1) same++; }
    $('agreeInfo').textContent = both ? `两人都判过 ${both} 个，“有没有变化”一致 ${Math.round(same / both * 100)}%` : '';
    $('peopleInfo').textContent = people.length ? `已导入 ${people.length} 人：` + people.map(n => `${n} ${Object.values(labels).filter(L => L[n]).length} 个`).join('，') : '';
  }
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async e => {
    let n = 0;
    for (const f of e.target.files) {
      let js; try { js = JSON.parse(await f.text()); } catch { toast(`${f.name} 读不了`); continue; }
      if (js.schema !== 'ledger_desk_v3/labels/1') { toast(`${f.name} 不是同学判读文件`); continue; }
      for (const [wid, it] of Object.entries(js.items || {})) {
        const key = `label|${js.annotator}|${wid}`, old = await DB.get(key);
        if (old && old.saved_at >= it.saved_at) continue;
        await DB.set(key, it); n++;
      }
    }
    e.target.value = ''; await loadAll(); toast(`导入 ${n} 条`);
  };
  $('exportBtn').onclick = () => {
    const ids = Object.keys(verdicts).sort(); if (!ids.length) { toast('还没有裁定'); return; }
    const out = { schema: 'ledger_desk_v3/verdicts/1', by: '组长', exported_at: nowIso(), items: {} };
    for (const wid of ids) { const x = verdicts[wid]; out.items[wid] = { verdict: x.verdict, marks_used: x.marks_used || [], position: x.position, need_hr: x.need_hr, to_precise: x.to_precise, note: x.note || '', hint: x.hint || '', at: x.at }; }
    const d = new Date(), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    a.download = `台账裁定_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`; a.click();
    toast(`已导出 ${ids.length} 个裁定`);
  };
  $('importVBtn').onclick = () => $('importVFile').click();
  $('importVFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const js = JSON.parse(await f.text()); if (js.schema !== 'ledger_desk_v3/verdicts/1') { toast('不是裁定文件'); return; }
    for (const [wid, x] of Object.entries(js.items)) { const old = verdicts[wid]; if (!old || (x.at || '') > (old.at || '')) await DB.set(`verdict|${wid}`, x); }
    e.target.value = ''; await loadAll(); toast('已导入裁定');
  };
  async function loadAll() {
    labels = {}; verdicts = {}; const ps = new Set();
    for (const k of await DB.keys()) {
      const [kind, a, b] = String(k).split('|');
      if (kind === 'label') { (labels[b] = labels[b] || {})[a] = await DB.get(k); ps.add(a); }
      if (kind === 'verdict') verdicts[a] = await DB.get(k);
    }
    people = [...ps].sort(); agree(); renderList(); if (cur >= 0) openWin(cur);
  }

  // ---------------------------------------------------------------- 工具栏、快捷键、启动
  const toggles = { tcBtn: () => { fc = !fc; $('tcBtn').textContent = fc ? '假彩色' : '真彩色'; }, qBtn: () => { showQ = !showQ; }, rBtn: () => { showR = !showR; }, sBtn: () => { showS = !showS; }, aiBtn: () => { showAI = !showAI; }, fBtn: () => { full = !full; resetView(); } };
  for (const [id, fn] of Object.entries(toggles)) $(id).onclick = () => { fn(); if (id !== 'tcBtn') $(id).classList.toggle('on'); draw(); };
  $('saveBtn').onclick = save;
  document.addEventListener('keydown', e => {
    const t = e.target; if (t && t.matches && t.matches('input, textarea, select')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === ' ') { e.preventDefault(); if (!flick) { flick = true; $('flickTag').hidden = false; draw(); } }
    else if (/^[a-ex]$/i.test(e.key) && v) { v.verdict = e.key.toUpperCase(); renderForm(); }
  });
  document.addEventListener('keyup', e => { if (e.key === ' ' && flick) { flick = false; $('flickTag').hidden = true; draw(); } });
  async function init() {
    buildForm();
    try { const js = await fetch(DATA + 'windows_full.json', { cache: 'no-cache' }).then(r => r.json()); W = js.windows || []; }
    catch (err) { $('wlist').innerHTML = `<p class="msg" style="padding:10px">读不到 data/windows_full.json：${esc(err.message)}</p>`; return; }
    await loadAll();
    if (!shown().length) $('filter').value = 'all';
    renderList(); const s = shown(); if (s.length) openWin(s[0][1]);
  }
  window.__leader = { get v() { return v; }, get W() { return W; }, openWin, needOf, problems };
  init();
})();
