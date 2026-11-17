/**
 * 頂部氛圍背景（首頁與每站頁面共用）。
 *
 * 預設是 style.css 的靜態漸層。只有在「桌面寬度＋支援 WebGPU＋沒有要求減少動態＋沒有開省流量」時，
 * 才載入同源托管的 shaders（/vendor/shaders-4.0.7.js，MIT，授權見同資料夾的 LICENSE 檔）
 * 在 canvas 上畫流動漸層，淡入蓋過靜態漸層。載入或初始化失敗都安靜退回靜態漸層。
 *
 * 效能：
 * - 繪製解析度壓在「CSS 像素 1:1、最多約 100 萬像素」：canvas 外面包一層 .stage，
 *   用 transform: scale() 放大，套件看到的尺寸就是縮小後的；漸層本來就很柔，放大看不出差別。
 * - 套件在 canvas 捲出畫面時會自己暫停；這裡另外在視窗變窄（≤720px）時整個關掉、變寬時再開。
 */
const SHADERS_URL = '/vendor/shaders-4.0.7.js';
const MAX_PIXELS = 1_000_000;

const desktop = window.matchMedia('(min-width: 721px)');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const dark = window.matchMedia('(prefers-color-scheme: dark)');

let box = null;
let stage = null;
let shader = null;
let run = 0; // 每次啟動或停止都遞增，讓還在等待中的舊呼叫知道自己已經過期

/** 套件內部的像素比：桌面上是 min(devicePixelRatio, 2) */
const libRatio = () => Math.min(window.devicePixelRatio || 1, 2);

function fitStage() {
  if (!box || !stage) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  const ratio = libRatio();
  // 縮放倍數 s：套件畫 (w/s)×(h/s)×ratio² 個像素。s = ratio 時剛好是 CSS 像素 1:1，再視需要壓到 MAX_PIXELS 以內
  const s = ratio * Math.max(1, Math.sqrt((w * h) / MAX_PIXELS));
  box.style.setProperty('--aura-scale', s.toFixed(3));
}

const wanted = () =>
  desktop.matches && !reduced.matches && 'gpu' in navigator && !navigator.connection?.saveData;

function stop() {
  run++;
  shader?.destroy();
  shader = null;
  box?.classList.remove('live');
}

async function start() {
  stop();
  const mine = run;
  if (!box || !wanted()) return;
  const canvas = stage.querySelector('canvas');
  // 先給 canvas 相對尺寸：套件只在 canvas 沒有 inline 寬高時才寫入固定的 px，那樣視窗變寬時 canvas 不會跟著變
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  fitStage();
  try {
    const { createShader } = await import(SHADERS_URL);
    if (mine !== run) return;
    const css = getComputedStyle(document.documentElement);
    const color = (n) => css.getPropertyValue(`--aura-${n}`).trim();
    const s = await createShader(
      canvas,
      {
        components: [
          { type: 'SolidColor', props: { color: color(4) } },
          // 由上往下淡出的遮罩，讓漸層收在標題區，不延伸到資料表格後面
          { type: 'Circle', id: 'fade', props: { visible: false, radius: 2, softness: 1, center: { x: 0.5, y: 0 } } },
          { type: 'FlowingGradient', props: { colorA: color(1), colorB: color(2), colorC: color(3), colorD: color(4), colorSpace: 'oklab', speed: 0.3, distortion: 0.35, maskSource: 'fade' } },
          { type: 'FilmGrain', props: { strength: dark.matches ? 0.02 : 0.1 } },
        ],
      },
      { disableTelemetry: true, onReady: () => { if (mine === run) box.classList.add('live'); } },
    );
    if (mine !== run) { s?.destroy(); return; }
    shader = s;
  } catch (err) {
    if (mine === run) console.warn('氛圍背景沒有啟用，改用靜態漸層：', err);
  }
}

export function initAura() {
  box = document.querySelector('.aura');
  stage = box?.querySelector('.stage');
  if (!box || !stage) return;
  new ResizeObserver(fitStage).observe(box);
  // 視窗跨過手機寬度、切換減少動態、切換深淺色（色票不同）時重新判斷
  for (const mq of [desktop, reduced, dark]) mq.addEventListener('change', () => (wanted() ? start() : stop()));
  start();
}
