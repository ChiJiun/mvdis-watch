/**
 * 產生和官網查詢頁同結構的 HTML（只有 parseSlots 會看的 trnTable 部分），
 * 測試與本機端到端驗證用，不需要打官網。
 */
export type FixtureRow = {
  /** ISO yyyy-mm-dd */
  date: string;
  session: '上午' | '下午';
  group: number;
  /** 'full' = 額滿 */
  quota: number | 'full';
};

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function roc(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y - 1911}年${m}月${d}日`;
}

export function locationsHtml(rows: FixtureRow[]): string {
  const trs = rows
    .map((r, i) => {
      const wd = WEEKDAYS[new Date(`${r.date}T00:00:00Z`).getUTCDay()];
      const quota = r.quota === 'full' ? '額滿' : String(r.quota);
      const action =
        r.quota === 'full'
          ? '<td></td>'
          : `<td><a href="javascript:preAdd('${r.date.replace(/-/g, '')}','S${i}','D${i}')">報名</a></td>`;
      return `<tr><td>${roc(r.date)}<br>(${wd})</td><td>${r.session}場次 組別${r.group}<br>機車筆試＋路考</td><td>${quota}</td>${action}</tr>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><title>fixture</title></head><body>
<table id="trnTable" class="tb_list_std">
<thead><tr><th>日期</th><th>場次</th><th>餘額</th><th></th></tr></thead>
<tbody>
${trs}
</tbody>
</table></body></html>`;
}

/** 從今天（台灣時間）往後 n 天的 ISO 日期 */
export function daysFromNow(n: number, now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000 + n * 86400_000).toISOString().slice(0, 10);
}
