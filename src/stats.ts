/**
 * 釋位歷史統計。純計算，不碰 IO。
 *
 * 輸入是某一站最近 30 天的事件流（事件只保留 30 天，見 scan.ts），輸出每個照類的：
 *   - 釋位次數、最近一次釋位時間
 *   - 釋位發生的時段分布（台灣時間 0–23 時），回答「通常幾點會有人退考」
 *   - 每日釋位次數（最近 30 天），給前端畫趨勢
 *   - 釋位後再被搶光的中位時間，回答「要多快去搶」
 *
 * 時間解析度受掃描頻率限制：熱門照類約 10 分鐘掃一次，所以「被搶光時間」
 * 的最小單位就是 10 分鐘，低於那個數字的都該讀成「幾乎立刻」。
 */
import type { EventRow } from './db.ts';

const DAY_MS = 24 * 3600 * 1000;
const TW_OFFSET_MS = 8 * 3600 * 1000;

export type TypeStats = {
  licenseType: string;
  released: number;
  filled: number;
  newSlots: number;
  lastReleasedAt: number | null;
  /** 24 格，台灣時間每小時的釋位次數 */
  byHour: number[];
  /** 最近 30 天每日釋位次數，索引 0 = 最早那天，最後一格 = 今天 */
  byDay: number[];
  /** 釋位後被搶光的中位分鐘數；樣本不足時 null */
  medianFillMinutes: number | null;
  /** 參與中位數計算的樣本數 */
  fillSamples: number;
  /** 釋位時刻仍有位（到現在還沒額滿）的次數 */
  stillOpen: number;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const twHour = (t: number) => new Date(t + TW_OFFSET_MS).getUTCHours();
const twDayIndex = (t: number) => Math.floor((t + TW_OFFSET_MS) / DAY_MS);

export function releaseStats(events: EventRow[], now: number, days = 30): Map<string, TypeStats> {
  const out = new Map<string, TypeStats>();
  const today = twDayIndex(now);
  const get = (lt: string) => {
    let s = out.get(lt);
    if (!s) {
      s = {
        licenseType: lt,
        released: 0,
        filled: 0,
        newSlots: 0,
        lastReleasedAt: null,
        byHour: new Array(24).fill(0),
        byDay: new Array(days).fill(0),
        medianFillMinutes: null,
        fillSamples: 0,
        stillOpen: 0,
      };
      out.set(lt, s);
    }
    return s;
  };

  // 事件是 at DESC，先翻成時間順序才能配對「釋出 → 額滿」
  const asc = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const open = new Map<string, number>(); // 場次鍵 → 釋位時間
  const fillGaps = new Map<string, number[]>();

  for (const e of asc) {
    const s = get(e.license_type);
    const key = `${e.license_type}|${e.exam_date}|${e.sec_key}`;

    if (e.kind === 'released') {
      s.released++;
      s.lastReleasedAt = e.at;
      s.byHour[twHour(e.at)]++;
      const d = days - 1 - (today - twDayIndex(e.at));
      if (d >= 0 && d < days) s.byDay[d]++;
      open.set(key, e.at);
    } else if (e.kind === 'filled') {
      s.filled++;
      const t0 = open.get(key);
      if (t0 !== undefined) {
        if (!fillGaps.has(e.license_type)) fillGaps.set(e.license_type, []);
        fillGaps.get(e.license_type)!.push((e.at - t0) / 60000);
        open.delete(key);
      }
    } else if (e.kind === 'new') {
      s.newSlots++;
    } else if (e.kind === 'gone' || e.kind === 'decreased') {
      // decreased 代表還有位只是變少，不算被搶光；gone 是場次整個消失，配對作廢
      if (e.kind === 'gone') open.delete(key);
    }
  }

  for (const [lt, gaps] of fillGaps) {
    const s = get(lt);
    s.medianFillMinutes = median(gaps);
    s.fillSamples = gaps.length;
  }
  for (const key of open.keys()) get(key.split('|')[0]).stillOpen++;

  return out;
}
