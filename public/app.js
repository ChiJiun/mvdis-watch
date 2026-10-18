const MVDIS_SIGNUP = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';
const REFRESH_MS = 30_000;
const WATCH_KEY = 'mvdis-watch:watchlist';
const TOKEN_KEY = 'mvdis-watch:admin-token';

const $ = (s) => document.querySelector(s);
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

/* ---------- 追蹤清單 ---------- */

function loadWatch() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]')); }
  catch { return new Set(); }
}
const saveWatch = () => localStorage.setItem(WATCH_KEY, JSON.stringify([...watch]));
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
  renderTable(rows, f);
  renderEvents(events.rows ?? []);
  updateBadge(avail.rows ?? []);
  renderLastScan();
}

/* ---------- 分區總覽 ---------- */

function renderCards() {
  const byLv1 = new Map(meta.offices.map((o) => [o.lv1, { slots: 0, seats: 0, stations: new Set() }]));
  for (const s of meta.stations) byLv1.get(s.lv1)?.stations.add(s.no);

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
  $('#ovSummary').textContent = total
    ? `全台 ${total} 個場次還有位，合計 ${seats} 個名額`
    : '全台目前完全沒有餘額';

  const active = form.elements.lv1.value;
  const sorted = meta.offices
    .map((o) => ({ ...o, ...agg.get(o.lv1), total: byLv1.get(o.lv1)?.stations.size ?? 0 }))
    .sort((a, b) => b.slots - a.slots);

  $('#cards').replaceChildren(
    ...sorted.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `card${o.slots === 0 ? ' zero' : ''}${active === o.lv1 ? ' on' : ''}`;
      b.dataset.lv1 = o.lv1;
      const short = o.name.replace(/（.*）/, '');
      const area = (o.name.match(/（(.*)）/) || [, ''])[1];
      b.innerHTML = `
        <span class="nm">${short}</span>
        <span class="big${o.slots === 0 ? ' none' : ''}">${o.slots === 0 ? '全額滿' : o.slots}</span>
        <span class="sub">${area ? area + ' · ' : ''}${o.total} 站${o.slots ? ` · ${o.seats} 個名額` : ''}</span>
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
          return `<a class="chip${n ? '' : ' zero'}" href="/station/${s.no}" title="${s.address}">${s.name} <span class="n">${n || '滿'}</span></a>`;
        })
        .join('');
      g.innerHTML = `<h3>${o.name}</h3><div class="chips">${chips}</div>`;
      return g;
    }),
  );
}

/* ---------- 照類 / 日期 ---------- */

function typeCounts() {
  const n = new Map();
  for (const r of overview) n.set(r.license_type, (n.get(r.license_type) ?? 0) + r.slots);
  return n;
}

function renderTypeControls() {
  const counts = typeCounts();
  const lv1 = form.elements.lv1.value;
  const inScope = (code) =>
    overview
      .filter((r) => r.license_type === code && (!lv1 || stationByNo.get(r.dmv_no)?.lv1 === lv1))
      .reduce((a, r) => a + r.slots, 0);

  $('#typeGroups').replaceChildren(
    ...TYPE_GROUPS.map((g) => {
      const n = g.codes ? g.codes.reduce((a, c) => a + inScope(c), 0) : [...counts.values()].reduce((a, b) => a + b, 0);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.group = g.key;
      b.className = activeGroup === g.key ? 'on' : '';
      b.textContent = `${g.name} ${n}`;
      return b;
    }),
  );

  // 只列出這個分組裡「真的有位」的照類，避免十種照類擠滿整行
  const codes = TYPE_GROUPS.find((g) => g.key === activeGroup)?.codes ?? meta.licenseTypes.map((t) => t.code);
  const cur = form.elements.licenseType.value;
  const shown = codes.filter((c) => inScope(c) > 0 || c === cur);
  $('#typeChips').replaceChildren(
    ...shown.map((c) => {
      const t = licenseByCode.get(c);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.type = c;
      b.className = `chip${cur === c ? ' on' : ''}`;
      b.innerHTML = `${(t?.name ?? c).replace(' (50cc以下)', '')} <span class="n">${inScope(c)}</span>`;
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
      b.className = `chip${from === p.from && to === p.to ? ' on' : ''}`;
      b.textContent = p.name;
      return b;
    }),
  );
}

/* ---------- 表格 / 事件 ---------- */

const fmtDate = (i, w) => { const [, m, d] = i.split('-'); return `${Number(m)}/${Number(d)} ${w ?? ''}`.trim(); };
const daysAway = (i) => Math.round((new Date(i) - new Date(meta?.today ?? iso(new Date()))) / 86400000);

function renderTable(rows, f = {}) {
  const tbody = $('#avail tbody');
  $('#count').textContent = rows.length ? `${rows.length} 個場次` : '';

  if (!rows.length) {
    const why = f.weekendOnly
      ? '目前全台都沒有開放週末假日場次。<br>監理站的假日場次是不定期加開的，取消勾選可看平日場次。'
      : f.watchedOnly
        ? '你追蹤的組合目前都額滿。<br>綁定通知後，一有人退考就會推播給你。'
        : '目前沒有符合條件的餘額。<br>上方卡片可以看哪個區還有位。';
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${why}</td></tr>`;
    return;
  }

  tbody.replaceChildren(
    ...rows.map((r) => {
      const st = stationByNo.get(r.dmv_no);
      const lt = licenseByCode.get(r.license_type);
      const key = watchKey(r.license_type, r.dmv_no);
      const on = watch.has(key);
      const away = daysAway(r.exam_date);
      const tr = document.createElement('tr');
      if (on) tr.className = 'watched';
      tr.innerHTML = `
        <td class="star"><button type="button" class="starbtn ${on ? 'on' : ''}" data-key="${key}" title="追蹤">${on ? '★' : '☆'}</button></td>
        <td class="${away <= 7 ? 'soon' : ''}">${fmtDate(r.exam_date, r.weekday)}${away <= 7 ? ` <small>${away <= 0 ? '今天' : away + '天後'}</small>` : ''}</td>
        <td><a class="st" href="/station/${r.dmv_no}?type=${r.license_type}" title="看這一站的完整場次表與釋位統計">${st ? st.name : r.dmv_no}</a></td>
        <td>${lt ? lt.name : r.license_type}</td>
        <td class="num"><span class="qty ${r.quota <= 3 ? 'low' : ''}">${r.quota}</span></td>
        <td class="desc">${r.session ?? ''}場次 組別${r.grp ?? '-'}</td>
        <td><a class="signup" href="${MVDIS_SIGNUP}" target="_blank" rel="noopener">前往報名</a></td>`;
      return tr;
    }),
  );
}

const KIND_LABEL = { released: '釋出', increased: '增加', decreased: '減少', filled: '額滿', new: '新場次', gone: '移除' };

function renderEvents(rows) {
  const ul = $('#events');
  if (!rows.length) {
    ul.innerHTML = '<li class="empty">還沒有記錄到變化。<br>掃描累積一段時間後才會有資料。</li>';
    return;
  }
  ul.replaceChildren(
    ...rows.map((e) => {
      const st = stationByNo.get(e.dmv_no);
      const lt = licenseByCode.get(e.license_type);
      const li = document.createElement('li');
      const delta =
        e.kind === 'released' || e.kind === 'increased' || e.kind === 'new' ? `→ ${e.new_quota} 位`
        : e.kind === 'filled' ? '→ 額滿'
        : e.kind === 'gone' ? '→ 已移除'
        : `${e.old_quota} → ${e.new_quota} 位`;
      li.innerHTML = `
        <div><span class="ev-kind ev-${e.kind}">${KIND_LABEL[e.kind] ?? e.kind}</span>
          <a class="st" href="/station/${e.dmv_no}?type=${e.license_type}"><strong>${st ? st.name : e.dmv_no}</strong></a> · ${lt ? lt.name : e.license_type}</div>
        <div>${fmtDate(e.exam_date)} ${delta}</div>
        <div class="ev-time">${new Date(e.at).toLocaleString('zh-TW', { hour12: false })}</div>`;
      return li;
    }),
  );
}

function updateBadge(all) {
  const n = all.filter((r) => watch.has(watchKey(r.license_type, r.dmv_no))).length;
  document.title = n ? `(${n}) 監理站考照餘額監測` : '監理站考照餘額監測';
}

function renderLastScan() {
  const el = $('#lastScan');
  if (!meta?.lastTick) { el.textContent = '尚未掃描'; return; }
  const mins = Math.round((Date.now() - meta.lastTick) / 60000);
  el.textContent = mins <= 1 ? '剛剛更新' : `${mins} 分鐘前更新`;
  el.classList.toggle('stale', mins > 10);
}

function renderHealth() {
  const h = meta?.health ?? {};
  const parts = [`已掃描組合 ${h.combos ?? 0} / 360`, `降頻（長期無場次） ${h.pruned ?? 0}`, `抓取異常 ${h.failing ?? 0}`];
  if (h.oldest) parts.push(`最舊一筆 ${new Date(h.oldest).toLocaleString('zh-TW', { hour12: false })}`);
  $('#health').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}

/* ---------- 通知設定 ---------- */

const token = () => localStorage.getItem(TOKEN_KEY) ?? '';
const authHeaders = () => ({ 'x-admin-token': token(), 'Content-Type': 'application/json' });

async function loadSubs() {
  const box = $('#subs');
  if (!token()) { box.innerHTML = '<p class="mini">請先輸入管理密碼。</p>'; return; }
  const res = await fetch('/api/subscriptions', { headers: authHeaders() });
  if (res.status === 401) { box.innerHTML = '<p class="mini bad">管理密碼不正確。</p>'; return; }
  const { rows } = await res.json();
  if (!rows.length) { box.innerHTML = '<p class="mini">還沒有訂閱。</p>'; return; }

  box.replaceChildren(
    ...rows.map((s) => {
      const div = document.createElement('div');
      div.className = 'sub';
      const scope = s.watches.length
        ? s.watches.map((w) => `${stationByNo.get(w.dmvNo)?.name ?? w.dmvNo}·${(licenseByCode.get(w.licenseType)?.name ?? w.licenseType).replace(' (50cc以下)', '')}`).join('、')
        : '全台所有組合（很吵）';
      const state = s.last_error
        ? `<span class="bad">最近失敗：${s.last_error}</span>`
        : s.last_sent_at
          ? `<span class="ok">最近送出：${new Date(s.last_sent_at).toLocaleString('zh-TW', { hour12: false })}</span>`
          : '尚未送過';
      div.innerHTML = `
        <div class="grow">
          <div><strong>${s.label || 'Discord'}</strong> <span class="mini">#${s.id}</span></div>
          <div class="tgt">${s.target}</div>
          <div class="mini">盯著：${scope}</div>
          <div class="mini">${state}</div>
        </div>
        <div class="acts">
          <button type="button" class="ghost" data-test="${s.id}">測試</button>
          <button type="button" class="ghost" data-del="${s.id}">刪除</button>
        </div>`;
      return div;
    }),
  );
}

function watchSummary() {
  const n = watch.size;
  $('#watchSummary').textContent = n
    ? `目前追蹤 ${n} 個組合：${[...watch].map((k) => { const [t, d] = k.split('|'); return `${stationByNo.get(d)?.name ?? d}·${(licenseByCode.get(t)?.name ?? t).replace(' (50cc以下)', '')}`; }).join('、')}`
    : '你還沒有 ★ 追蹤任何組合。現在建立訂閱會變成全台通吃，建議先回表格點幾個 ★。';
}

$('#openNotify').addEventListener('click', () => {
  $('#adminToken').value = token();
  watchSummary();
  $('#notifyModal').hidden = false;
  loadSubs();
});
$('#closeNotify').addEventListener('click', () => { $('#notifyModal').hidden = true; });
$('#notifyModal').addEventListener('click', (e) => { if (e.target.id === 'notifyModal') $('#notifyModal').hidden = true; });
$('#adminToken').addEventListener('change', (e) => { localStorage.setItem(TOKEN_KEY, e.target.value.trim()); loadSubs(); });

$('#addSub').addEventListener('click', async () => {
  const target = $('#webhookUrl').value.trim();
  if (!target) return alert('請先貼上 Discord webhook 網址');
  const watches = [...watch].map((k) => { const [licenseType, dmvNo] = k.split('|'); return { licenseType, dmvNo }; });
  const res = await fetch('/api/subscriptions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ target, label: $('#webhookLabel').value.trim() || null, watches }),
  });
  const out = await res.json();
  if (!res.ok) return alert(out.error ?? '建立失敗');
  $('#webhookUrl').value = '';
  $('#webhookLabel').value = '';
  loadSubs();
});

$('#subs').addEventListener('click', async (e) => {
  const t = e.target.dataset.test;
  const d = e.target.dataset.del;
  if (t) {
    const r = await (await fetch(`/api/subscriptions/test?id=${t}`, { method: 'POST', headers: authHeaders() })).json();
    alert(r.ok ? '已送出測試訊息，去 Discord 看看。' : `失敗（HTTP ${r.status}）`);
    loadSubs();
  }
  if (d && confirm('確定刪除這個訂閱？')) {
    await fetch(`/api/subscriptions?id=${d}`, { method: 'DELETE', headers: authHeaders() });
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

form.addEventListener('change', (e) => {
  if (e.target.name === 'county') { form.elements.lv1.value = ''; fillStations(); }
  refresh();
});
form.addEventListener('input', (e) => { if (e.target.type === 'number') refresh(); });

// 逐一清空而不是 form.reset()：後者只還原成 HTML 預設值，語意上比較模糊，
// 而且表單內只要有元素的 id 叫 reset 就會把方法遮蔽掉。
$('#clearFilters').addEventListener('click', () => {
  for (const name of ['county', 'dmvNo', 'from', 'to', 'lv1', 'licenseType']) form.elements[name].value = '';
  for (const name of ['weekendOnly', 'watchedOnly']) form.elements[name].checked = false;
  form.elements.minQuota.value = '1';
  activeGroup = '';
  fillStations();
  refresh();
});

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
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = '✅ 已複製';
  } catch {
    prompt('複製這個網址：', location.href);
  }
  setTimeout(() => (btn.textContent = '🔗 複製連結'), 1500);
});

$('#autoRefresh').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(tick, REFRESH_MS);
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
