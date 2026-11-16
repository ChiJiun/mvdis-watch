/**
 * 每站公開頁面。
 *
 * 網址形式：/station/41（由 Worker 注入標題與 OG 標籤後回傳 station.html），
 * 本機直接開 /station.html?no=41 也可以。選擇的照類放在 ?type=，可直接分享。
 */
const MVDIS_SIGNUP = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';
const REFRESH_MS = 30_000;
const EXTERNAL_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const $ = (s) => document.querySelector(s);

const dmvNo =
  (location.pathname.match(/\/station\/(\d{2})/) || [])[1] ||
  new URLSearchParams(location.search).get('no') ||
  '';

let data = null;
let meta = null;
let activeType = new URLSearchParams(location.search).get('type') ?? '';

/* ---------- 小工具 ---------- */

/** API 與官網來的字串（場次附註、站名、錯誤訊息）一律跳脫後才放進 innerHTML */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (i, w) => { const [, m, d] = i.split('-'); return `${Number(m)}/${Number(d)}${w ? ' ' + String(w).replace('星期', '週') : ''}`; };
const daysAway = (i) => Math.round((new Date(i) - new Date(data?.today ?? new Date().toISOString().slice(0, 10))) / 86400000);
const shortType = (t) => (t?.name ?? '').replace(' (50cc以下)', '');
const absTime = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false });

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

/** 場次附註：官網的 sec_desc 第一行是「上午場次, 組別 3」，跟 session/grp 重複，只取後面的說明 */
function sessionNote(desc) {
  const lines = String(desc ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(1).join(' ');
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
  $('#stTitle').textContent = station.name;
  $('#stMeta').innerHTML =
    `${esc(station.address)} · ${esc(office?.name ?? '')} · <a href="${MVDIS_SIGNUP}" target="_blank" rel="noopener">官網報名</a>`;
  $('#apiLink').href = `/api/station?dmvNo=${encodeURIComponent(dmvNo)}`;
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
  const t = el.querySelector('.t');
  if (!data.lastTick) { t.textContent = '尚未掃描'; el.className = 'pill idle'; return; }
  const mins = Math.round((Date.now() - data.lastTick) / 60000);
  t.textContent = mins <= 1 ? '剛剛更新' : `${mins} 分鐘前更新`;
  el.className = `pill${mins > 10 ? ' stale' : ''}`;
  el.title = `最後一次抓取：${absTime(data.lastTick)}`;
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
      b.setAttribute('aria-pressed', String(activeType === t.code));
      b.title = has ? `${n} 個場次有位` : '目前沒有開放場次';
      b.innerHTML = `${esc(t.code ? shortType(t) : t.name)} <span class="n">${has ? n : '無'}</span>`;
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
    { k: '現在有位', v: open.length || (slots.length ? '額滿' : '—'), u: slots.length ? ` / ${slots.length} 場` : '', tip: slots.length ? `${slots.length} 個場次裡有 ${open.length} 個還有位` : '沒有開放場次', good: open.length > 0 },
    { k: '名額', v: seats, u: ' 位', tip: '目前可報名的人數' },
    { k: '最近釋位', v: last ? ago(last) : '—', tip: last ? absTime(last) : `${data.statsDays} 天內沒有釋位` },
    { k: `${data.statsDays} 天釋位`, v: released, u: ' 次', tip: released ? `平均每週 ${(released / (data.statsDays / 7)).toFixed(1)} 次` : '額滿後就沒再開過' },
    { k: '釋位後搶光', v: minutes(fill), tip: samples ? `${samples} 個樣本的中位數` : '樣本不足' },
    { k: '最常釋位', v: peakHours.length ? peakHours.map((h) => `${h}–${h + 1} 時`).join('、\n') : '—', tip: peak ? `各 ${peak} 次` : '還沒有釋位紀錄' },
  ];
  $('#tiles').replaceChildren(
    ...tiles.map((t) => {
      const d = document.createElement('div');
      d.className = `tile${t.good ? ' good' : ''}`;
      d.title = t.tip;
      d.innerHTML = `<span class="k">${esc(t.k)}</span><span class="v">${esc(t.v)}${t.u ? `<small>${esc(t.u)}</small>` : ''}</span>`;
      return d;
    }),
  );
}

function renderScanState() {
  const types = typesInScope();
  const logs = data.scanLog.filter((l) => types.includes(l.license_type));
  if (!logs.length) { $('#scanState').innerHTML = '<span>還沒有掃描過</span>'; return; }
  const byCode = new Map(data.licenseTypes.map((t) => [t.code, t]));
  const name = (l) => shortType(byCode.get(l.license_type)) || l.license_type;
  const bad = logs.filter((l) => l.last_error_at && l.last_error_at > (l.last_ok ?? 0));
  const pruned = logs.filter((l) => !bad.includes(l) && l.empty_streak >= 5);
  const live = logs.filter((l) => !bad.includes(l) && !pruned.includes(l));
  const parts = [
    ...live.map((l) => `<span title="上次抓取：${esc(l.last_ok ? absTime(l.last_ok) : '—')}">${esc(name(l))} ${ago(l.last_ok)}</span>`),
    ...bad.map((l) => `<span class="bad" title="${esc(l.last_error)}">${esc(name(l))} 抓取失敗</span>`),
  ];
  // 十種照類裡通常有一大半長期沒開場次，合併成一句就好，不要洗版
  if (pruned.length) parts.push(`<span title="${esc(pruned.map(name).join('、'))}：長期沒有場次，改成每 24 小時複查">${pruned.length} 種照類長期無場次</span>`);
  $('#scanState').innerHTML = parts.join('');
}

function renderTable() {
  const byCode = new Map(data.licenseTypes.map((t) => [t.code, t]));
  let rows = slotsInScope();
  if ($('#onlyOpen').checked) rows = rows.filter((s) => s.quota > 0);
  if ($('#onlyWeekend').checked) rows = rows.filter((s) => s.is_weekend);
  rows = [...rows].sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.license_type.localeCompare(b.license_type) || a.sec_key.localeCompare(b.sec_key));

  const tbody = $('#slots tbody');
  $('#count').textContent = rows.length ? `${rows.length} 場` : '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">沒有符合條件的場次</td></tr>';
    return;
  }
  tbody.replaceChildren(
    ...rows.map((r) => {
      const away = daysAway(r.exam_date);
      const tr = document.createElement('tr');
      if (r.quota <= 0) tr.className = 'full';
      const quota =
        r.quota < 0 ? '<span class="fullbadge">額滿</span>'
        : `<span class="qty${r.quota <= 3 ? ' low' : ''}">${esc(r.quota)}<span class="u"> 位</span></span>`;
      const soon = away <= 7 ? `<span class="tag soon">${away <= 0 ? '今天' : away + ' 天後'}</span>` : '';
      const wk = r.is_weekend ? '<span class="tag wk">假日</span>' : '';
      const note = sessionNote(r.sec_desc);
      const sess = [r.session, r.grp != null && r.grp !== '' ? `組別 ${r.grp}` : ''].filter(Boolean).join('・');
      tr.innerHTML = `
        <td class="c-date"><span class="d">${esc(fmtDate(r.exam_date, r.weekday))}</span>${soon}${wk}</td>
        <td class="c-ty">${esc(shortType(byCode.get(r.license_type)) || r.license_type)}</td>
        <td class="c-sess"><span class="s">${esc(sess)}</span>${note ? `<span class="note" title="${esc(note)}">${esc(note)}</span>` : ''}</td>
        <td class="c-qty num">${quota}</td>
        <td class="c-upd" title="${esc(absTime(r.updated_at))}">${ago(r.updated_at)}</td>
        <td class="c-act">${r.quota > 0 ? `<a class="signup" href="${MVDIS_SIGNUP}" target="_blank" rel="noopener" title="前往監理服務網報名">報名${EXTERNAL_ICON}</a>` : ''}</td>`;
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
  $('#hourHint').textContent = `${data.statsDays} 天 ${total} 次`;
  $('#hourHint').title = '釋位（額滿 → 有位）發生在台灣時間的哪個小時';
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
  const more = $('#moreEvents');
  $('#evCount').textContent = rows.length ? `${rows.length} 筆` : '';
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
      const delta =
        e.kind === 'filled' || e.kind === 'gone' ? ''
        : e.kind === 'released' || e.kind === 'new' || e.old_quota == null ? ` · <b>${esc(e.new_quota)} 位</b>`
        : ` · ${esc(e.old_quota)} → <b>${esc(e.new_quota)} 位</b>`;
      li.innerHTML = `
        <span class="ev-kind">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span>
        <div class="ev-main">
          <strong>${esc(shortType(byCode.get(e.license_type)) || e.license_type)}</strong>
          <div class="ev-sub" title="考試日期 ${esc(e.exam_date)}"><span class="d">${esc(fmtDate(e.exam_date))}</span>${delta}</div>
        </div>
        <time class="ev-time" datetime="${new Date(e.at).toISOString()}" title="${esc(absTime(e.at))}">${ago(e.at)}</time>`;
      return li;
    }),
  );
  const hiddenCount = Math.max(0, rows.length - 8);
  more.hidden = hiddenCount === 0 || ul.classList.contains('expanded');
  more.textContent = `再顯示 ${hiddenCount} 筆`;
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
  if (e.target.value) location.href = `/station/${e.target.value}${activeType ? `?type=${encodeURIComponent(activeType)}` : ''}`;
});
$('#moreEvents').addEventListener('click', () => {
  $('#events').classList.add('expanded');
  $('#moreEvents').hidden = true;
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

/* ---------- 頂部氛圍背景 ----------
   桌面寬度、支援 WebGPU、沒有要求減少動態或省流量時，才從 CDN 延遲載入 shaders（MIT，鎖定版本，壓縮後約 700KB）；
   其他情況留著 style.css 的靜態漸層。載入或初始化失敗都不影響頁面。 */
const SHADERS_URL = 'https://cdn.jsdelivr.net/npm/shaders@4.0.7/js/+esm';
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
let aura = null;

async function startAura() {
  const box = $('.aura');
  const canvas = box?.querySelector('canvas');
  const wanted =
    canvas && 'gpu' in navigator && window.matchMedia('(min-width: 721px)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !navigator.connection?.saveData;
  if (!wanted) return;
  try {
    const { createShader } = await import(SHADERS_URL);
    const css = getComputedStyle(document.documentElement);
    const color = (n) => css.getPropertyValue(`--aura-${n}`).trim();
    aura?.destroy();
    aura = await createShader(
      canvas,
      {
        components: [
          { type: 'SolidColor', props: { color: color(4) } },
          // 由上往下淡出的遮罩，讓漸層收在標題區，不延伸到資料表格後面
          { type: 'Circle', id: 'fade', props: { visible: false, radius: 2, softness: 1, center: { x: 0.5, y: 0 } } },
          { type: 'FlowingGradient', props: { colorA: color(1), colorB: color(2), colorC: color(3), colorD: color(4), colorSpace: 'oklab', speed: 0.3, distortion: 0.35, maskSource: 'fade' } },
          { type: 'FilmGrain', props: { strength: darkScheme.matches ? 0.02 : 0.1 } },
        ],
      },
      { disableTelemetry: true, onReady: () => box.classList.add('live') },
    );
  } catch (err) {
    console.warn('氛圍背景沒有啟用，改用靜態漸層：', err);
  }
}
darkScheme.addEventListener('change', () => {
  if (!aura) return;
  $('.aura').classList.remove('live');
  startAura();
});

await load();
(window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200)))(() => startAura());
setInterval(() => load().catch(console.error), REFRESH_MS);
