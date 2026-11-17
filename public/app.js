const MVDIS_SIGNUP = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';
const REFRESH_MS = 30_000;
const WATCH_KEY = 'mvdis-watch:watchlist';
const TOKEN_KEY = 'mvdis-watch:admin-token';
const STAR_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';
const EXTERNAL_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const form = $('#filters');

let meta = null;
let overview = [];
let stationByNo = new Map();
let licenseByCode = new Map();
let watch = loadWatch();
let timer = null;

/** 照類分組。API 一次只吃一個 licenseType，所以分組是在前端過濾的。 */
const TYPE_GROUPS = [
  { key: '', name: '全部', codes: null },
  { key: 'moto', name: '機車', codes: ['5', '3'] },
  { key: 'car', name: '汽車', codes: ['A', 'B'] },
  { key: 'big', name: '大型車', codes: ['C', 'D', 'E', 'F', 'G', 'H'] },
];
let activeGroup = '';

/* ---------- 小工具 ---------- */

/** API 與官網來的字串（場次附註、webhook 網址、錯誤訊息）一律跳脫後才放進 innerHTML */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (n) => Number(n ?? 0).toLocaleString('zh-TW');
const shortType = (code) => (licenseByCode.get(code)?.name ?? code).replace(' (50cc以下)', '');
const typeName = (code) => licenseByCode.get(code)?.name ?? code;
const stationName = (no) => stationByNo.get(no)?.name ?? no;
const absTime = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false });
/** 給 <time datetime> 用；遇到不合法的時間不要讓整個列表渲染失敗 */
const isoTime = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 場次附註：官網的 sec_desc 第一行是「上午場次, 組別 3」，跟 session/grp 重複，只取後面的說明 */
function sessionNote(desc) {
  const lines = String(desc ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(1).join(' ');
}

/* ---------- 追蹤清單 ---------- */

function loadWatch() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]')); }
  catch { return new Set(); }
}
const saveWatch = () => { try { localStorage.setItem(WATCH_KEY, JSON.stringify([...watch])); } catch {} };
const watchKey = (t, d) => `${t}|${d}`;

/* ---------- 篩選條件 <-> 網址 ---------- */

function filtersFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = q.get(el.name);
    if (el.type === 'checkbox') el.checked = v === '1';
    else if (v !== null) el.value = v;
  }
  activeGroup = q.get('group') ?? '';
}

function currentFilters() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') { if (el.checked) out[el.name] = '1'; }
    else if (el.value) out[el.name] = el.value;
  }
  if (activeGroup) out.group = activeGroup;
  return out;
}

function syncUrl(f) {
  const q = new URLSearchParams(f).toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

/* ---------- 載入 ---------- */

async function loadMeta() {
  meta = await (await fetch('/api/meta')).json();
  stationByNo = new Map(meta.stations.map((s) => [s.no, s]));
  licenseByCode = new Map(meta.licenseTypes.map((t) => [t.code, t]));

  const cty = form.elements.county;
  for (const c of [...new Set(meta.stations.map((s) => s.county))]) cty.add(new Option(c, c));
  fillStations();
  renderHealth();
}

function fillStations() {
  const sel = form.elements.dmvNo;
  const keep = sel.value;
  const county = form.elements.county.value;
  const lv1 = form.elements.lv1.value;
  sel.length = 1;
  for (const s of meta.stations) {
    if (county && s.county !== county) continue;
    if (lv1 && s.lv1 !== lv1) continue;
    sel.add(new Option(`${s.name}（${s.county}）`, s.no));
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
}

async function refresh() {
  const f = currentFilters();
  syncUrl(f);

  // 照類分組與追蹤是前端概念，伺服器不認得
  const q = new URLSearchParams(f);
  q.delete('watchedOnly');
  q.delete('group');
  q.delete('lv1');
  q.set('limit', '600');

  const [ov, avail, events] = await Promise.all([
    fetch('/api/overview').then((r) => r.json()),
    fetch(`/api/available?${q}`).then((r) => r.json()),
    fetch('/api/events?limit=60').then((r) => r.json()),
  ]);
  overview = ov.rows ?? [];

  let rows = avail.rows ?? [];
  const lv1 = form.elements.lv1.value;
  if (lv1) rows = rows.filter((r) => stationByNo.get(r.dmv_no)?.lv1 === lv1);
  const codes = TYPE_GROUPS.find((g) => g.key === activeGroup)?.codes;
  if (codes) rows = rows.filter((r) => codes.includes(r.license_type));
  if (f.licenseType) rows = rows.filter((r) => r.license_type === f.licenseType);
  if (f.watchedOnly) rows = rows.filter((r) => watch.has(watchKey(r.license_type, r.dmv_no)));

  renderCards();
  renderStationLinks();
  renderTypeControls();
  renderDateChips();
  renderActiveTags(f);
  renderTable(rows, f);
  renderEvents(events.rows ?? []);
  updateBadge(avail.rows ?? []);
  renderLastScan();
}

/* ---------- 分區總覽 ---------- */

function renderCards() {
  const byLv1 = new Map(meta.offices.map((o) => [o.lv1, new Set()]));
  for (const s of meta.stations) byLv1.get(s.lv1)?.add(s.no);

  const agg = new Map(meta.offices.map((o) => [o.lv1, { slots: 0, seats: 0 }]));
  for (const r of overview) {
    const st = stationByNo.get(r.dmv_no);
    if (!st) continue;
    const a = agg.get(st.lv1);
    if (a) { a.slots += r.slots; a.seats += r.seats ?? 0; }
  }

  const max = Math.max(1, ...[...agg.values()].map((a) => a.slots));
  const total = [...agg.values()].reduce((x, a) => x + a.slots, 0);
  const seats = [...agg.values()].reduce((x, a) => x + a.seats, 0);
  $('#ovSummary').innerHTML = total
    ? `<span><b>${fmtNum(total)}</b>場</span><span><b>${fmtNum(seats)}</b>位</span>`
    : '全台額滿';

  const active = form.elements.lv1.value;
  const sorted = meta.offices
    .map((o) => ({ ...o, ...agg.get(o.lv1), total: byLv1.get(o.lv1)?.size ?? 0 }))
    .sort((a, b) => b.slots - a.slots);

  $('#cards').replaceChildren(
    ...sorted.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `card${o.slots === 0 ? ' zero' : ''}${active === o.lv1 ? ' on' : ''}`;
      b.dataset.lv1 = o.lv1;
      b.setAttribute('aria-pressed', String(active === o.lv1));
      b.title = `${o.total} 個監理站`;
      const short = o.name.replace(/（.*）/, '');
      const area = (o.name.match(/（(.*)）/) || [, ''])[1];
      b.innerHTML = `
        <span class="nm">${esc(short)}${area ? `<span class="area">${esc(area)}</span>` : ''}</span>
        <span class="big">${o.slots === 0 ? '<b>額滿</b>' : `<b>${fmtNum(o.slots)}</b>場<span class="seats">${fmtNum(o.seats)} 位</span>`}</span>
        <span class="bar"><i style="width:${(o.slots / max) * 100}%"></i></span>`;
      return b;
    }),
  );
}

/* ---------- 各監理站頁面入口 ---------- */

function renderStationLinks() {
  const open = new Map();
  for (const r of overview) open.set(r.dmv_no, (open.get(r.dmv_no) ?? 0) + r.slots);
  $('#stationLinks').replaceChildren(
    ...meta.offices.map((o) => {
      const g = document.createElement('div');
      g.className = 'stgroup';
      const chips = meta.stations
        .filter((s) => s.lv1 === o.lv1)
        .map((s) => {
          const n = open.get(s.no) ?? 0;
          return `<a class="chip${n ? '' : ' zero'}" href="/station/${esc(s.no)}" title="${esc(s.address)}">${esc(s.name)} <span class="n">${n || '滿'}</span></a>`;
        })
        .join('');
      g.innerHTML = `<h3>${esc(o.name)}</h3><div class="chips">${chips}</div>`;
      return g;
    }),
  );
}

/* ---------- 照類 / 日期 ---------- */

function renderTypeControls() {
  const lv1 = form.elements.lv1.value;
  const inScope = (code) =>
    overview
      .filter((r) => r.license_type === code && (!lv1 || stationByNo.get(r.dmv_no)?.lv1 === lv1))
      .reduce((a, r) => a + r.slots, 0);
  const allCodes = meta.licenseTypes.map((t) => t.code);

  $('#typeGroups').replaceChildren(
    ...TYPE_GROUPS.map((g) => {
      const n = (g.codes ?? allCodes).reduce((a, c) => a + inScope(c), 0);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.group = g.key;
      b.className = activeGroup === g.key ? 'on' : '';
      b.setAttribute('aria-pressed', String(activeGroup === g.key));
      b.innerHTML = `${g.name}<span class="n">${fmtNum(n)}</span>`;
      return b;
    }),
  );

  // 只列出這個分組裡「真的有位」的照類，避免十種照類擠滿整行
  const codes = TYPE_GROUPS.find((g) => g.key === activeGroup)?.codes ?? allCodes;
  const cur = form.elements.licenseType.value;
  const shown = codes.filter((c) => inScope(c) > 0 || c === cur);
  $('#typeChips').replaceChildren(
    ...shown.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.type = c;
      b.className = `chip${cur === c ? ' on' : ''}`;
      b.setAttribute('aria-pressed', String(cur === c));
      b.innerHTML = `${esc(shortType(c))} <span class="n">${fmtNum(inScope(c))}</span>`;
      return b;
    }),
  );
}

const iso = (d) => d.toISOString().slice(0, 10);
function datePresets() {
  const today = new Date(meta?.today ?? iso(new Date()));
  const add = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
  const toSunday = 7 - ((today.getDay() + 6) % 7) - 1;
  return [
    { key: 'week', name: '本週', from: iso(today), to: add(toSunday) },
    { key: 'two', name: '兩週內', from: iso(today), to: add(14) },
    { key: 'month', name: '一個月內', from: iso(today), to: add(30) },
  ];
}

function renderDateChips() {
  const from = form.elements.from.value;
  const to = form.elements.to.value;
  $('#dateChips').replaceChildren(
    ...datePresets().map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.from = p.from;
      b.dataset.to = p.to;
      const on = from === p.from && to === p.to;
      b.className = `chip${on ? ' on' : ''}`;
      b.setAttribute('aria-pressed', String(on));
      b.textContent = p.name;
      return b;
    }),
  );
}

/* ---------- 目前套用的條件（手機上顯示在清單上方，可逐一點掉） ---------- */

function activeTags(f) {
  const tags = [];
  if (f.lv1) {
    const o = meta.offices.find((x) => x.lv1 === f.lv1);
    tags.push({ label: (o?.name ?? f.lv1).replace(/（.*）/, ''), clear: ['lv1'], sheet: false });
  }
  if (f.from || f.to) {
    const p = datePresets().find((x) => x.from === f.from && x.to === f.to);
    const md = (s) => (s ? s.slice(5).replace('-', '/').replace(/^0/, '').replace('/0', '/') : '…');
    tags.push({ label: p ? p.name : `${md(f.from)} → ${md(f.to)}`, clear: ['from', 'to'], sheet: true });
  }
  if (f.county) tags.push({ label: f.county, clear: ['county'], sheet: true });
  if (f.dmvNo) tags.push({ label: stationName(f.dmvNo), clear: ['dmvNo'], sheet: true });
  if (f.minQuota && f.minQuota !== '1') tags.push({ label: `餘額 ≥ ${f.minQuota}`, clear: ['minQuota'], sheet: true });
  if (f.weekendOnly) tags.push({ label: '只看假日', clear: ['weekendOnly'], sheet: true });
  if (f.watchedOnly) tags.push({ label: '只看追蹤', clear: ['watchedOnly'], sheet: true });
  return tags;
}

function renderActiveTags(f) {
  const tags = activeTags(f);
  const n = tags.filter((t) => t.sheet).length;
  const badge = $('#filterCount');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  $('#clearFilters').hidden = !(tags.length || f.licenseType || f.group);
  $('#activeTags').replaceChildren(
    ...tags.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.clear = t.clear.join(',');
      b.title = `移除條件：${t.label}`;
      b.innerHTML = `${esc(t.label)}<span class="x" aria-hidden="true">✕</span>`;
      return b;
    }),
  );
}

/* ---------- 表格 / 事件 ---------- */

const fmtDate = (i, w) => { const [, m, d] = i.split('-'); return `${Number(m)}/${Number(d)}${w ? ' ' + String(w).replace('星期', '週') : ''}`; };
const daysAway = (i) => Math.round((new Date(i) - new Date(meta?.today ?? iso(new Date()))) / 86400000);

function dateCell(r) {
  const away = daysAway(r.exam_date);
  const soon = away <= 7 ? `<span class="tag soon">${away <= 0 ? '今天' : away + ' 天後'}</span>` : '';
  const wk = r.is_weekend ? '<span class="tag wk">假日</span>' : '';
  return `<span class="d">${esc(fmtDate(r.exam_date, r.weekday))}</span>${soon}${wk}`;
}

function sessCell(r) {
  const note = sessionNote(r.sec_desc);
  const s = [r.session, r.grp != null && r.grp !== '' ? `組別 ${r.grp}` : ''].filter(Boolean).join('・');
  return `<span class="s">${esc(s)}</span>${note ? `<span class="note" title="${esc(note)}">${esc(note)}</span>` : ''}`;
}

function renderTable(rows, f = {}) {
  const tbody = $('#avail tbody');
  $('#count').textContent = rows.length ? `${fmtNum(rows.length)} 場` : '';
  $('#applyFilters').textContent = rows.length ? `看 ${fmtNum(rows.length)} 場` : '沒有符合的場次';

  if (!rows.length) {
    const why = f.weekendOnly
      ? '目前沒有假日場次'
      : f.watchedOnly
        ? '追蹤的組合目前都額滿'
        : '沒有符合條件的場次';
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${why}</td></tr>`;
    return;
  }

  tbody.replaceChildren(
    ...rows.map((r) => {
      const key = watchKey(r.license_type, r.dmv_no);
      const on = watch.has(key);
      const tr = document.createElement('tr');
      if (on) tr.className = 'watched';
      const label = `${stationName(r.dmv_no)}・${shortType(r.license_type)}`;
      tr.innerHTML = `
        <td class="c-star"><button type="button" class="starbtn${on ? ' on' : ''}" data-key="${esc(key)}" aria-pressed="${on}" aria-label="追蹤 ${esc(label)}" title="${on ? '取消追蹤' : '追蹤'}：${esc(label)}">${STAR_ICON}</button></td>
        <td class="c-date">${dateCell(r)}</td>
        <td class="c-st"><a class="st" href="/station/${esc(r.dmv_no)}?type=${esc(r.license_type)}" title="看這一站的完整場次表與釋位統計">${esc(stationName(r.dmv_no))}</a><span class="ty"><span class="dotsep"> · </span>${esc(typeName(r.license_type))}</span></td>
        <td class="c-qty num"><span class="qty${r.quota <= 3 ? ' low' : ''}">${esc(r.quota)}<span class="u"> 位</span></span></td>
        <td class="c-sess">${sessCell(r)}</td>
        <td class="c-act"><a class="signup" href="${MVDIS_SIGNUP}" target="_blank" rel="noopener" title="前往監理服務網報名">報名${EXTERNAL_ICON}</a></td>`;
      return tr;
    }),
  );
}

const KIND_LABEL = { released: '釋出', increased: '增加', decreased: '減少', filled: '額滿', new: '新場次', gone: '移除' };

function eventDelta(e) {
  if (e.kind === 'filled' || e.kind === 'gone') return '';
  if (e.kind === 'released' || e.kind === 'new' || e.old_quota == null) return ` · <b>${esc(e.new_quota)} 位</b>`;
  return ` · ${esc(e.old_quota)} → <b>${esc(e.new_quota)} 位</b>`;
}

function renderEvents(rows) {
  const ul = $('#events');
  const more = $('#moreEvents');
  if (!rows.length) {
    ul.innerHTML = '<li class="empty">還沒有記錄到變動</li>';
    more.hidden = true;
    return;
  }
  ul.replaceChildren(
    ...rows.map((e) => {
      const kind = KIND_LABEL[e.kind] ? e.kind : 'other';
      const li = document.createElement('li');
      li.className = `ev ev-${kind}`;
      li.innerHTML = `
        <span class="ev-kind">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span>
        <div class="ev-main">
          <a class="st" href="/station/${esc(e.dmv_no)}?type=${esc(e.license_type)}"><strong>${esc(stationName(e.dmv_no))}</strong></a> · ${esc(shortType(e.license_type))}
          <div class="ev-sub" title="考試日期 ${esc(e.exam_date)}"><span class="d">${esc(fmtDate(e.exam_date))}</span>${eventDelta(e)}</div>
        </div>
        <time class="ev-time" datetime="${isoTime(e.at)}" title="${esc(absTime(e.at))}">${ago(e.at)}</time>`;
      return li;
    }),
  );
  const hiddenCount = Math.max(0, rows.length - 8);
  more.hidden = hiddenCount === 0 || ul.classList.contains('expanded');
  more.textContent = `再顯示 ${hiddenCount} 筆`;
}

$('#moreEvents').addEventListener('click', () => {
  $('#events').classList.add('expanded');
  $('#moreEvents').hidden = true;
});

function updateBadge(all) {
  const n = all.filter((r) => watch.has(watchKey(r.license_type, r.dmv_no))).length;
  document.title = n ? `(${n}) 監理站考照餘額監測` : '監理站考照餘額監測';
}

function renderLastScan() {
  const el = $('#lastScan');
  const t = el.querySelector('.t');
  if (!meta?.lastTick) { t.textContent = '尚未掃描'; el.className = 'pill idle'; return; }
  const mins = Math.round((Date.now() - meta.lastTick) / 60000);
  t.textContent = mins <= 1 ? '剛剛更新' : `${mins} 分鐘前更新`;
  el.className = `pill${mins > 10 ? ' stale' : ''}`;
  el.title = `最後一次抓取：${absTime(meta.lastTick)}`;
  replayPulse(el);
}

/** 每次重新讀取資料後讓狀態點再擴散三次（動畫跑完就停，靜置時不耗資源） */
function replayPulse(el) {
  for (const a of el.querySelector('.dot')?.getAnimations?.({ subtree: true }) ?? []) { a.cancel(); a.play(); }
}

function renderHealth() {
  const h = meta?.health ?? {};
  const parts = [
    [`掃描 ${h.combos ?? 0}/360`, '已掃描的 監理站×照類 組合數'],
    [`降頻 ${h.pruned ?? 0}`, '長期沒有場次、改成每 24 小時複查的組合數'],
    [`異常 ${h.failing ?? 0}`, '最近一次抓取失敗的組合數', h.failing ? 'bad' : ''],
  ];
  if (h.oldest) parts.push([`最舊 ${absTime(h.oldest)}`, '最久沒更新的那一筆資料的時間']);
  $('#health').innerHTML = parts
    .map(([p, title, cls]) => `<span${cls ? ` class="${cls}"` : ''} title="${esc(title)}">${esc(p)}</span>`)
    .join('');
}

/* ---------- 手機的篩選抽屜 ---------- */

const mobile = window.matchMedia('(max-width: 720px)');

function setFilterSheet(open) {
  const sheet = $('#moreFilters');
  sheet.classList.toggle('open', open);
  $('#filterBackdrop').hidden = !open;
  $('#openFilters').setAttribute('aria-expanded', String(open));
  const wasOpen = document.documentElement.classList.contains('locked');
  document.documentElement.classList.toggle('locked', open);
  if (open) sheet.querySelector('.sheethead button')?.focus();
  else if (wasOpen && mobile.matches) $('#openFilters').focus();
}

$('#openFilters').addEventListener('click', () => setFilterSheet(true));
form.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-filters]')) setFilterSheet(false);
});
mobile.addEventListener('change', (e) => { if (!e.matches) setFilterSheet(false); });

$('#activeTags').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-clear]');
  if (!b) return;
  for (const name of b.dataset.clear.split(',')) {
    const el = form.elements[name];
    if (el.type === 'checkbox') el.checked = false;
    else el.value = name === 'minQuota' ? '1' : '';
  }
  fillStations();
  refresh();
});

/* ---------- 通知設定 ---------- */

const token = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
const authHeaders = () => ({ 'x-admin-token': token(), 'Content-Type': 'application/json' });

async function loadSubs() {
  const box = $('#subs');
  if (!token()) { box.innerHTML = '<p class="mini">請先輸入管理密碼。</p>'; return; }
  const res = await fetch('/api/subscriptions', { headers: authHeaders() });
  if (res.status === 401) { box.innerHTML = '<p class="mini bad">管理密碼不正確。</p>'; return; }
  if (!res.ok) { box.innerHTML = `<p class="mini bad">讀取訂閱失敗（HTTP ${res.status}）。這個部署可能沒有提供訂閱功能。</p>`; return; }
  const { rows } = await res.json();
  if (!rows.length) { box.innerHTML = '<p class="mini">還沒有訂閱。</p>'; return; }

  box.replaceChildren(
    ...rows.map((s) => {
      const div = document.createElement('div');
      div.className = 'subitem';
      const scope = s.watches.length
        ? s.watches.map((w) => `${stationName(w.dmvNo)}·${shortType(w.licenseType)}`).join('、')
        : '全台所有組合';
      const state = s.last_error
        ? `<span class="bad">最近失敗：${esc(s.last_error)}</span>`
        : s.last_sent_at
          ? `<span class="ok">最近送出：${esc(absTime(s.last_sent_at))}</span>`
          : '尚未送過';
      div.innerHTML = `
        <div class="grow">
          <div><strong>${esc(s.label || 'Discord')}</strong> <span class="mini">#${esc(s.id)}</span></div>
          <div class="tgt">${esc(s.target)}</div>
          <div class="mini">${esc(scope)}</div>
          <div class="mini">${state}</div>
        </div>
        <div class="acts">
          <button type="button" class="ghost" data-test="${esc(s.id)}">測試</button>
          <button type="button" class="ghost" data-del="${esc(s.id)}">刪除</button>
        </div>`;
      return div;
    }),
  );
}

function watchSummary() {
  const n = watch.size;
  $('#watchSummary').textContent = n
    ? `追蹤中 ${n} 組：${[...watch].map((k) => { const [t, d] = k.split('|'); return `${stationName(d)}·${shortType(t)}`; }).join('、')}`
    : '還沒有追蹤任何組合，現在建立會收到全台所有釋位。';
}

function closeNotify() {
  $('#notifyModal').hidden = true;
  document.documentElement.classList.remove('locked');
  $('#openNotify').focus();
}

$('#openNotify').addEventListener('click', () => {
  $('#adminToken').value = token();
  watchSummary();
  $('#notifyModal').hidden = false;
  document.documentElement.classList.add('locked');
  $('#closeNotify').focus();
  loadSubs();
});
$('#closeNotify').addEventListener('click', closeNotify);
$('#notifyModal').addEventListener('click', (e) => { if (e.target.id === 'notifyModal') closeNotify(); });
$('#adminToken').addEventListener('change', (e) => {
  try { localStorage.setItem(TOKEN_KEY, e.target.value.trim()); } catch {}
  loadSubs();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#notifyModal').hidden) closeNotify();
  else if ($('#moreFilters').classList.contains('open')) setFilterSheet(false);
});

$('#addSub').addEventListener('click', async () => {
  const target = $('#webhookUrl').value.trim();
  if (!target) return alert('請先貼上 Discord webhook 網址');
  const watches = [...watch].map((k) => { const [licenseType, dmvNo] = k.split('|'); return { licenseType, dmvNo }; });
  const res = await fetch('/api/subscriptions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ target, label: $('#webhookLabel').value.trim() || null, watches }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return alert(out.error ?? `建立失敗（HTTP ${res.status}）`);
  $('#webhookUrl').value = '';
  $('#webhookLabel').value = '';
  loadSubs();
});

$('#subs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const t = btn.dataset.test;
  const d = btn.dataset.del;
  if (t) {
    const r = await (await fetch(`/api/subscriptions/test?id=${encodeURIComponent(t)}`, { method: 'POST', headers: authHeaders() })).json();
    alert(r.ok ? '已送出測試訊息，去 Discord 看看。' : `失敗（HTTP ${r.status}）`);
    loadSubs();
  }
  if (d && confirm('確定刪除這個訂閱？')) {
    await fetch(`/api/subscriptions?id=${encodeURIComponent(d)}`, { method: 'DELETE', headers: authHeaders() });
    loadSubs();
  }
});

/* ---------- 事件綁定 ---------- */

$('#cards').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !card.dataset.lv1) return;
  const cur = form.elements.lv1.value;
  form.elements.lv1.value = cur === card.dataset.lv1 ? '' : card.dataset.lv1;
  form.elements.county.value = '';
  fillStations();
  refresh();
});

$('#typeGroups').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  activeGroup = b.dataset.group;
  form.elements.licenseType.value = '';
  refresh();
});

$('#typeChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  form.elements.licenseType.value = form.elements.licenseType.value === b.dataset.type ? '' : b.dataset.type;
  refresh();
});

$('#dateChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const same = form.elements.from.value === b.dataset.from && form.elements.to.value === b.dataset.to;
  form.elements.from.value = same ? '' : b.dataset.from;
  form.elements.to.value = same ? '' : b.dataset.to;
  refresh();
});

form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('change', (e) => {
  if (e.target.name === 'county') { form.elements.lv1.value = ''; fillStations(); }
  refresh();
});
form.addEventListener('input', (e) => { if (e.target.type === 'number') refresh(); });

// 逐一清空而不是 form.reset()：後者只還原成 HTML 預設值，語意上比較模糊，
// 而且表單內只要有元素的 id 叫 reset 就會把方法遮蔽掉。
function clearFilters() {
  for (const name of ['county', 'dmvNo', 'from', 'to', 'lv1', 'licenseType']) form.elements[name].value = '';
  for (const name of ['weekendOnly', 'watchedOnly']) form.elements[name].checked = false;
  form.elements.minQuota.value = '1';
  activeGroup = '';
  fillStations();
  refresh();
}
for (const b of $$('#moreFilters [data-clear]')) b.addEventListener('click', clearFilters);

$('#avail').addEventListener('click', (e) => {
  const btn = e.target.closest('.starbtn');
  if (!btn) return;
  const key = btn.dataset.key;
  watch.has(key) ? watch.delete(key) : watch.add(key);
  saveWatch();
  watchSummary();
  refresh();
});

$('#share').addEventListener('click', async () => {
  const btn = $('#share');
  const lbl = btn.querySelector('.lbl');
  try {
    await navigator.clipboard.writeText(location.href);
    lbl.textContent = '已複製';
    btn.classList.add('done');
    btn.setAttribute('aria-label', '已複製連結');
  } catch {
    prompt('複製這個網址：', location.href);
  }
  setTimeout(() => {
    lbl.textContent = '複製連結';
    btn.classList.remove('done');
    btn.setAttribute('aria-label', '複製連結');
  }, 1500);
});

$('#autoRefresh').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(tick, REFRESH_MS);
  $('.status').classList.toggle('paused', !e.target.checked);
});

async function tick() {
  try {
    meta = await (await fetch('/api/meta')).json();
    renderHealth();
    await refresh();
  } catch (err) { console.error(err); }
}

filtersFromUrl();
await loadMeta();
filtersFromUrl();
fillStations();
await refresh();
timer = setInterval(tick, REFRESH_MS);
(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200)))(() => import('/aura.js').then((m) => m.initAura()).catch(() => {}));
