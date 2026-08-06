const MVDIS_SIGNUP = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';
const REFRESH_MS = 30_000;
const WATCH_KEY = 'mvdis-watch:watchlist';

const $ = (sel) => document.querySelector(sel);
const form = $('#filters');

let meta = null;
let stationByNo = new Map();
let licenseByCode = new Map();
let watch = loadWatch();
let timer = null;

function loadWatch() {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveWatch() {
  localStorage.setItem(WATCH_KEY, JSON.stringify([...watch]));
}
const watchKey = (licenseType, dmvNo) => `${licenseType}|${dmvNo}`;

/* ---------- 篩選條件 <-> 網址 ---------- */

function filtersFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = q.get(el.name);
    if (el.type === 'checkbox') el.checked = v === '1';
    else if (v !== null) el.value = v;
  }
}

function currentFilters() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.checked) out[el.name] = '1';
    } else if (el.value) {
      out[el.name] = el.value;
    }
  }
  return out;
}

function syncUrl(f) {
  const q = new URLSearchParams(f).toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

/* ---------- 資料載入 ---------- */

async function loadMeta() {
  meta = await (await fetch('/api/meta')).json();
  stationByNo = new Map(meta.stations.map((s) => [s.no, s]));
  licenseByCode = new Map(meta.licenseTypes.map((t) => [t.code, t]));

  const lt = form.elements.licenseType;
  for (const t of meta.licenseTypes) lt.add(new Option(t.name, t.code));

  const counties = [...new Set(meta.stations.map((s) => s.county))];
  const cty = form.elements.county;
  for (const c of counties) cty.add(new Option(c, c));

  fillStations();
  renderHealth();
}

function fillStations() {
  const sel = form.elements.dmvNo;
  const keep = sel.value;
  const county = form.elements.county.value;
  sel.length = 1;
  for (const s of meta.stations) {
    if (county && s.county !== county) continue;
    sel.add(new Option(`${s.name}（${s.county}）`, s.no));
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
}

async function refresh() {
  const f = currentFilters();
  syncUrl(f);

  const q = new URLSearchParams(f);
  q.delete('watchedOnly'); // 追蹤是本機概念，伺服器不認得
  const [avail, events] = await Promise.all([
    fetch(`/api/available?${q}`).then((r) => r.json()),
    fetch('/api/events?limit=60').then((r) => r.json()),
  ]);

  let rows = avail.rows ?? [];
  if (f.watchedOnly) rows = rows.filter((r) => watch.has(watchKey(r.license_type, r.dmv_no)));

  renderTable(rows, f);
  renderEvents(events.rows ?? []);
  updateBadge(avail.rows ?? []);
  renderLastScan();
}

/* ---------- 畫面 ---------- */

const fmtDate = (iso, weekday) => {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)} ${weekday ?? ''}`.trim();
};

function daysAway(iso) {
  const today = new Date(meta?.today ?? new Date().toISOString().slice(0, 10));
  return Math.round((new Date(iso) - today) / 86400000);
}

function renderTable(rows, f = {}) {
  const tbody = $('#avail tbody');
  $('#count').textContent = rows.length ? `${rows.length} 個場次` : '';

  if (!rows.length) {
    // 週末假日場次要另外開放，多數期間監理站根本沒排，空白是正常的而不是壞掉
    const why = f.weekendOnly
      ? '目前全台都沒有開放週末假日場次。<br>監理站的假日場次是不定期加開的，取消勾選可看平日場次。'
      : f.watchedOnly
        ? '你追蹤的組合目前都額滿。<br>右側「剛剛釋出」會在有人退考時跳出來。'
        : '目前沒有符合條件的餘額。<br>熱門站點通常整批額滿，等「剛剛釋出」跳出退考釋位。';
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
        <td class="star"><button class="starbtn ${on ? 'on' : ''}" data-key="${key}" title="追蹤">${on ? '★' : '☆'}</button></td>
        <td class="${away <= 7 ? 'soon' : ''}">${fmtDate(r.exam_date, r.weekday)}${away <= 7 ? ` <small>${away <= 0 ? '今天' : away + '天後'}</small>` : ''}</td>
        <td>${st ? st.name : r.dmv_no}</td>
        <td>${lt ? lt.name : r.license_type}</td>
        <td class="num"><span class="qty ${r.quota <= 3 ? 'low' : ''}">${r.quota}</span></td>
        <td class="desc">${r.session ?? ''}場次 組別${r.grp ?? '-'}</td>
        <td><a class="signup" href="${MVDIS_SIGNUP}" target="_blank" rel="noopener">前往報名</a></td>`;
      return tr;
    }),
  );
}

const KIND_LABEL = {
  released: '釋出',
  increased: '增加',
  decreased: '減少',
  filled: '額滿',
  new: '新場次',
  gone: '移除',
};

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
        e.kind === 'released' || e.kind === 'increased' || e.kind === 'new'
          ? `→ ${e.new_quota} 位`
          : e.kind === 'filled'
            ? '→ 額滿'
            : e.kind === 'gone'
              ? '→ 已移除'
              : `${e.old_quota} → ${e.new_quota} 位`;
      li.innerHTML = `
        <div><span class="ev-kind ev-${e.kind}">${KIND_LABEL[e.kind] ?? e.kind}</span>
          <strong>${st ? st.name : e.dmv_no}</strong> · ${lt ? lt.name : e.license_type}</div>
        <div>${fmtDate(e.exam_date)} ${delta}</div>
        <div class="ev-time">${new Date(e.at).toLocaleString('zh-TW', { hour12: false })}</div>`;
      return li;
    }),
  );
}

/**
 * 分頁標題掛上追蹤命中數。
 * 沒有接外部推播的情況下，這是唯一能在切到別的分頁時仍然看得到的提示。
 */
function updateBadge(allRows) {
  const n = allRows.filter((r) => watch.has(watchKey(r.license_type, r.dmv_no))).length;
  document.title = n ? `(${n}) 監理站考照餘額監測` : '監理站考照餘額監測';
}

function renderLastScan() {
  const el = $('#lastScan');
  if (!meta?.lastTick) {
    el.textContent = '尚未掃描';
    return;
  }
  const mins = Math.round((Date.now() - meta.lastTick) / 60000);
  el.textContent = mins <= 1 ? '剛剛更新' : `${mins} 分鐘前更新`;
  el.classList.toggle('stale', mins > 10);
}

function renderHealth() {
  const h = meta?.health ?? {};
  const parts = [
    `已掃描組合 ${h.combos ?? 0} / 360`,
    `降頻（長期無場次） ${h.pruned ?? 0}`,
    `抓取異常 ${h.failing ?? 0}`,
  ];
  if (h.oldest) parts.push(`最舊一筆 ${new Date(h.oldest).toLocaleString('zh-TW', { hour12: false })}`);
  $('#health').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}

/* ---------- 事件 ---------- */

form.addEventListener('change', (e) => {
  if (e.target.name === 'county') fillStations();
  refresh();
});
form.addEventListener('input', (e) => {
  if (e.target.type === 'number') refresh();
});

$('#reset').addEventListener('click', () => {
  form.reset();
  form.elements.minQuota.value = '1';
  fillStations();
  refresh();
});

$('#avail').addEventListener('click', (e) => {
  const btn = e.target.closest('.starbtn');
  if (!btn) return;
  const key = btn.dataset.key;
  if (watch.has(key)) watch.delete(key);
  else watch.add(key);
  saveWatch();
  refresh();
});

$('#autoRefresh').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(tick, REFRESH_MS);
});

async function tick() {
  try {
    meta = await (await fetch('/api/meta')).json();
    await refresh();
  } catch (err) {
    console.error(err);
  }
}

filtersFromUrl();
await loadMeta();
filtersFromUrl(); // meta 填完選項後才能還原下拉選單的值
fillStations();
filtersFromUrl();
await refresh();
timer = setInterval(tick, REFRESH_MS);
