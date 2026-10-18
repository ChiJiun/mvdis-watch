/**
 * 每站公開頁面。
 *
 * 網址形式：/station/41（由 Worker 注入標題與 OG 標籤後回傳 station.html），
 * 本機直接開 /station.html?no=41 也可以。選擇的照類放在 ?type=，可直接分享。
 */
const MVDIS_SIGNUP = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';
const REFRESH_MS = 30_000;
const $ = (s) => document.querySelector(s);

const dmvNo =
  (location.pathname.match(/\/station\/(\d{2})/) || [])[1] ||
  new URLSearchParams(location.search).get('no') ||
  '';

let data = null;
let meta = null;
let activeType = new URLSearchParams(location.search).get('type') ?? '';

/* ---------- 小工具 ---------- */

const fmtDate = (i, w) => { const [, m, d] = i.split('-'); return `${Number(m)}/${Number(d)}${w ? ' ' + w : ''}`; };
const daysAway = (i) => Math.round((new Date(i) - new Date(data?.today ?? new Date().toISOString().slice(0, 10))) / 86400000);
const shortType = (t) => (t?.name ?? '').replace(' (50cc以下)', '');

function ago(t) {
  if (!t) return '—';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

function minutes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 15) return '約 10 分鐘內';
  if (n < 60) return `約 ${Math.round(n)} 分鐘`;
  if (n < 48 * 60) return `約 ${(n / 60).toFixed(1)} 小時`;
  return `約 ${Math.round(n / 1440)} 天`;
}

function syncUrl() {
  const q = new URLSearchParams(location.search);
  if (activeType) q.set('type', activeType); else q.delete('type');
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

/* ---------- 載入 ---------- */

async function load() {
  const [st, mt] = await Promise.all([
    fetch(`/api/station?dmvNo=${encodeURIComponent(dmvNo)}`).then((r) => r.json()),
    meta ? Promise.resolve(meta) : fetch('/api/meta').then((r) => r.json()),
  ]);
  meta = mt;
  if (st.error) {
    $('#stTitle').textContent = st.error;
    $('#crumb').textContent = '找不到';
    $('#slots tbody').innerHTML = '<tr><td colspan="6" class="empty">請從首頁選一個監理站。</td></tr>';
    fillSwitch();
    return;
  }
  data = st;
  render();
}

function fillSwitch() {
  const sel = $('#switch');
  if (sel.options.length > 1) return;
  for (const o of meta.offices) {
    const g = document.createElement('optgroup');
    g.label = o.name;
    for (const s of meta.stations.filter((x) => x.lv1 === o.lv1)) g.append(new Option(`${s.name}（${s.county}）`, s.no));
    sel.append(g);
  }
  sel.value = dmvNo;
}

/* ---------- 渲染 ---------- */

function render() {
  const { station, office } = data;
  document.title = `${station.name} 考照場次餘額`;
  $('#crumb').textContent = station.name;
  $('#stTitle').textContent = station.name;
  $('#stMeta').innerHTML =
    `${station.address} · ${office?.name ?? ''} · <a href="${MVDIS_SIGNUP}" target="_blank" rel="noopener">官網報名頁</a>`;
  $('#apiLink').href = `/api/station?dmvNo=${dmvNo}`;
  fillSwitch();
  renderLastScan();
  renderTypeChips();
  renderTiles();
  renderScanState();
  renderTable();
  renderCharts();
  renderEvents();
}

function renderLastScan() {
  const el = $('#lastScan');
  if (!data.lastTick) { el.textContent = '尚未掃描'; return; }
  const mins = Math.round((Date.now() - data.lastTick) / 60000);
  el.textContent = mins <= 1 ? '剛剛更新' : `${mins} 分鐘前更新`;
  el.classList.toggle('stale', mins > 10);
}

const typesInScope = () => (activeType ? [activeType] : data.licenseTypes.map((t) => t.code));
const slotsInScope = () => data.slots.filter((s) => !activeType || s.license_type === activeType);
const statsInScope = () => data.stats.filter((s) => typesInScope().includes(s.licenseType));

function renderTypeChips() {
  const open = new Map();
  const total = new Map();
  for (const s of data.slots) {
    total.set(s.license_type, (total.get(s.license_type) ?? 0) + 1);
    if (s.quota > 0) open.set(s.license_type, (open.get(s.license_type) ?? 0) + 1);
  }
  const all = { code: '', name: '全部' };
  const openAll = [...open.values()].reduce((a, b) => a + b, 0);
  $('#typeChips').replaceChildren(
    ...[all, ...data.licenseTypes].map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.type = t.code;
      const n = t.code ? open.get(t.code) ?? 0 : openAll;
      const has = t.code ? total.has(t.code) : data.slots.length > 0;
      b.className = `chip${activeType === t.code ? ' on' : ''}${!has ? ' zero' : ''}`;
      b.title = has ? `${n} 個場次有位` : '目前沒有開放場次';
      b.innerHTML = `${t.code ? shortType(t) : t.name} <span class="n">${has ? n : '無'}</span>`;
      return b;
    }),
  );
}

function renderTiles() {
  const slots = slotsInScope();
  const stats = statsInScope();
  const open = slots.filter((s) => s.quota > 0);
  const seats = open.reduce((a, s) => a + s.quota, 0);
  const released = stats.reduce((a, s) => a + s.released, 0);
  const last = stats.reduce((a, s) => Math.max(a, s.lastReleasedAt ?? 0), 0) || null;

  // 多個照類時中位數不能直接平均，改用樣本數加權的近似；單一照類就是原值
  const samples = stats.reduce((a, s) => a + s.fillSamples, 0);
  const fill = samples
    ? stats.reduce((a, s) => a + (s.medianFillMinutes ?? 0) * s.fillSamples, 0) / samples
    : null;

  const byHour = new Array(24).fill(0);
  for (const s of stats) s.byHour.forEach((n, h) => (byHour[h] += n));
  const peak = Math.max(...byHour);
  const peakHours = peak ? byHour.map((n, h) => (n === peak ? h : -1)).filter((h) => h >= 0).slice(0, 2) : [];

  const tiles = [
    { k: '現在有位', v: open.length ? `${open.length} 場` : '全額滿', sub: slots.length ? `共 ${slots.length} 個場次` : '沒有開放場次', good: open.length > 0 },
    { k: '名額合計', v: seats, sub: '目前可報名的人數' },
    { k: '最近一次釋位', v: last ? ago(last) : '—', sub: last ? new Date(last).toLocaleString('zh-TW', { hour12: false }) : `${data.statsDays} 天內沒有釋位` },
    { k: `${data.statsDays} 天釋位次數`, v: released, sub: released ? `平均每週 ${(released / (data.statsDays / 7)).toFixed(1)} 次` : '額滿後就沒再開過' },
    { k: '釋位後多久被搶光', v: minutes(fill), sub: samples ? `${samples} 個樣本的中位數` : '樣本不足' },
    { k: '最常釋位的時段', v: peakHours.length ? peakHours.map((h) => `${h}–${h + 1} 時`).join('、') : '—', sub: peak ? `各 ${peak} 次` : '—' },
  ];
  $('#tiles').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = `tile${t.good ? ' good' : ''}`;
      d.innerHTML = `<span class="k">${t.k}</span><span class="v">${t.v}</span><span class="s">${t.sub}</span>`;
      return d;
    }),
  );
}

function renderScanState() {
  const types = typesInScope();
  const logs = data.scanLog.filter((l) => types.includes(l.license_type));
  if (!logs.length) { $('#scanState').textContent = '這個組合還沒有被掃描過。'; return; }
  const byCode = new Map(data.licenseTypes.map((t) => [t.code, t]));
  const name = (l) => shortType(byCode.get(l.license_type)) || l.license_type;
  const bad = logs.filter((l) => l.last_error_at && l.last_error_at > (l.last_ok ?? 0));
  const pruned = logs.filter((l) => !bad.includes(l) && l.empty_streak >= 5);
  const live = logs.filter((l) => !bad.includes(l) && !pruned.includes(l));
  const parts = [
    ...live.map((l) => `<span>${name(l)}：上次抓取 ${ago(l.last_ok)}</span>`),
    ...bad.map((l) => `<span class="bad">${name(l)}：抓取失敗（${l.last_error}）</span>`),
  ];
  // 十種照類裡通常有一大半長期沒開場次，合併成一句就好，不要洗版
  if (pruned.length) parts.push(`<span>${pruned.map(name).join('、')}：長期無場次，每 24 小時複查</span>`);
  $('#scanState').innerHTML = parts.join('');
}

function renderTable() {
  const byCode = new Map(data.licenseTypes.map((t) => [t.code, t]));
  let rows = slotsInScope();
  if ($('#onlyOpen').checked) rows = rows.filter((s) => s.quota > 0);
  if ($('#onlyWeekend').checked) rows = rows.filter((s) => s.is_weekend);
  rows = [...rows].sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.license_type.localeCompare(b.license_type) || a.sec_key.localeCompare(b.sec_key));

  const tbody = $('#slots tbody');
  $('#count').textContent = rows.length ? `${rows.length} 個場次` : '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">沒有符合條件的場次。</td></tr>';
    return;
  }
  tbody.replaceChildren(
    ...rows.map((r) => {
      const away = daysAway(r.exam_date);
      const tr = document.createElement('tr');
      if (r.quota <= 0) tr.className = 'full';
      const quota =
        r.quota < 0 ? '<span class="fullbadge">額滿</span>'
        : `<span class="qty ${r.quota <= 3 ? 'low' : ''}">${r.quota}</span>`;
      tr.innerHTML = `
        <td class="${away <= 7 ? 'soon' : ''}">${fmtDate(r.exam_date, r.weekday)}${away <= 7 ? ` <small>${away <= 0 ? '今天' : away + '天後'}</small>` : ''}</td>
        <td>${shortType(byCode.get(r.license_type)) || r.license_type}</td>
        <td class="desc">${r.session ?? ''}場次 組別${r.grp ?? '-'}</td>
        <td class="num">${quota}</td>
        <td class="mini" title="${new Date(r.updated_at).toLocaleString('zh-TW', { hour12: false })}">${ago(r.updated_at)}</td>
        <td>${r.quota > 0 ? `<a class="signup" href="${MVDIS_SIGNUP}" target="_blank" rel="noopener">前往報名</a>` : ''}</td>`;
      return tr;
    }),
  );
}

/* ---------- 圖表：單一序列的長條，用站方的強調色 ---------- */

function bars(el, values, label) {
  const max = Math.max(1, ...values);
  el.replaceChildren(
    ...values.map((v, i) => {
      const b = document.createElement('div');
      b.className = `bar${v === max && v > 0 ? ' peak' : ''}`;
      b.title = `${label(i)}：${v} 次`;
      b.innerHTML = `<i style="height:${(v / max) * 100}%"></i>`;
      return b;
    }),
  );
  el.classList.toggle('empty', max <= 1 && values.every((v) => v === 0));
}

function renderCharts() {
  const stats = statsInScope();
  const byHour = new Array(24).fill(0);
  const byDay = new Array(data.statsDays).fill(0);
  for (const s of stats) {
    s.byHour.forEach((n, h) => (byHour[h] += n));
    s.byDay.forEach((n, d) => (byDay[d] += n));
  }
  const total = byHour.reduce((a, b) => a + b, 0);
  $('#hourHint').textContent = total
    ? `最近 ${data.statsDays} 天共 ${total} 次釋位（額滿 → 有位），依台灣時間的小時分布。`
    : `最近 ${data.statsDays} 天沒有記錄到釋位。`;
  bars($('#hourChart'), byHour, (h) => `${h}–${h + 1} 時`);
  const today = new Date(data.today);
  bars($('#dayChart'), byDay, (d) => {
    const x = new Date(today); x.setDate(x.getDate() - (data.statsDays - 1 - d));
    return `${x.getMonth() + 1}/${x.getDate()}`;
  });
}

const KIND_LABEL = { released: '釋出', increased: '增加', decreased: '減少', filled: '額滿', new: '新場次', gone: '移除' };

function renderEvents() {
  const byCode = new Map(data.licenseTypes.map((t) => [t.code, t]));
  const rows = data.events.filter((e) => !activeType || e.license_type === activeType).slice(0, 80);
  const ul = $('#events');
  $('#evCount').textContent = rows.length ? `最近 ${rows.length} 筆` : '';
  if (!rows.length) {
    ul.innerHTML = '<li class="empty">還沒有記錄到變化。</li>';
    return;
  }
  ul.replaceChildren(
    ...rows.map((e) => {
      const li = document.createElement('li');
      const delta =
        e.kind === 'released' || e.kind === 'increased' || e.kind === 'new' ? `→ ${e.new_quota} 位`
        : e.kind === 'filled' ? '→ 額滿'
        : e.kind === 'gone' ? '→ 已移除'
        : `${e.old_quota} → ${e.new_quota} 位`;
      li.innerHTML = `
        <div><span class="ev-kind ev-${e.kind}">${KIND_LABEL[e.kind] ?? e.kind}</span>
          <strong>${shortType(byCode.get(e.license_type)) || e.license_type}</strong> · 考試日 ${fmtDate(e.exam_date)}</div>
        <div>${delta}</div>
        <div class="ev-time">${new Date(e.at).toLocaleString('zh-TW', { hour12: false })}</div>`;
      return li;
    }),
  );
}

/* ---------- 事件 ---------- */

$('#typeChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  activeType = b.dataset.type;
  syncUrl();
  render();
});
$('#onlyOpen').addEventListener('change', renderTable);
$('#onlyWeekend').addEventListener('change', renderTable);
$('#switch').addEventListener('change', (e) => {
  if (e.target.value) location.href = `/station/${e.target.value}${activeType ? `?type=${activeType}` : ''}`;
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

await load();
setInterval(() => load().catch(console.error), REFRESH_MS);
