/**
 * 監理服務網的靜態對照表。
 *
 * 站別清單是從官網 `method=dmvOnChange` 逐一撈出來的（2026-08 實測 36 站），
 * 而且實測確認站別清單**不隨照類變動**，所以全組合就是 36 × 10 = 360。
 * 若日後監理所改制，用 scripts/probe.mjs 的 `--stations` 重新產生本檔內容。
 */

export type LicenseType = {
  code: string;
  name: string;
  /** 熱門照類每 10 分鐘輪一次，其餘每 2 小時 —— 見 scan.ts 的分層排程 */
  hot: boolean;
};

export type Station = {
  /** dmvNo，查詢用 */
  no: string;
  /** dmvNoLv1，所屬區監理所，查詢時必須一起送 */
  lv1: string;
  name: string;
  address: string;
  /** 從地址推導，給前端做縣市篩選 */
  county: string;
};

export type Office = { lv1: string; name: string };

export const LICENSE_TYPES: LicenseType[] = [
  { code: '5', name: '普通輕型機車 (50cc以下)', hot: true },
  { code: '3', name: '普通重型機車', hot: true },
  { code: 'A', name: '普通小型車', hot: true },
  { code: 'B', name: '職業小型車', hot: false },
  { code: 'C', name: '普通大貨車', hot: false },
  { code: 'D', name: '職業大貨車', hot: false },
  { code: 'E', name: '普通大客車', hot: false },
  { code: 'F', name: '職業大客車', hot: false },
  { code: 'G', name: '普通聯結車', hot: false },
  { code: 'H', name: '職業聯結車', hot: false },
];

export const OFFICES: Office[] = [
  { lv1: '20', name: '臺北市區監理所（含金門馬祖）' },
  { lv1: '40', name: '臺北區監理所（北宜花）' },
  { lv1: '50', name: '新竹區監理所（桃竹苗）' },
  { lv1: '60', name: '臺中區監理所（中彰投）' },
  { lv1: '70', name: '嘉義區監理所（雲嘉南）' },
  { lv1: '30', name: '高雄市區監理所' },
  { lv1: '80', name: '高雄區監理所（高屏澎東）' },
];

export const STATIONS: Station[] = [
  { no: '21', lv1: '20', name: '士林監理站', address: '臺北市士林區承德路5段80號', county: '臺北市' },
  { no: '25', lv1: '20', name: '基隆監理站', address: '基隆市七堵區實踐路296號', county: '基隆市' },
  { no: '26', lv1: '20', name: '金門監理站', address: '金門縣金湖鎮黃海路六之一號', county: '金門縣' },
  { no: '28', lv1: '20', name: '連江監理站', address: '連江縣南竿鄉津沙村155號', county: '連江縣' },

  { no: '40', lv1: '40', name: '臺北區監理所', address: '新北市樹林區中正路248巷7號', county: '新北市' },
  { no: '41', lv1: '40', name: '板橋監理站', address: '新北市中和區中山路三段116號', county: '新北市' },
  { no: '43', lv1: '40', name: '宜蘭監理站', address: '宜蘭縣五結鄉中正路二段9號', county: '宜蘭縣' },
  { no: '44', lv1: '40', name: '花蓮監理站', address: '花蓮縣吉安鄉中正路二段152號', county: '花蓮縣' },
  { no: '45', lv1: '40', name: '玉里監理分站', address: '花蓮縣玉里鎮中華路427號', county: '花蓮縣' },
  { no: '46', lv1: '40', name: '蘆洲監理站', address: '新北市蘆洲區中山二路163號', county: '新北市' },

  { no: '50', lv1: '50', name: '新竹區監理所', address: '新竹縣新埔鎮文德路三段58號', county: '新竹縣' },
  { no: '51', lv1: '50', name: '新竹市監理站', address: '新竹市自由路10號', county: '新竹市' },
  { no: '52', lv1: '50', name: '桃園監理站', address: '桃園市介壽路416號', county: '桃園市' },
  { no: '53', lv1: '50', name: '中壢監理站', address: '桃園市中壢區延平路394號', county: '桃園市' },
  { no: '54', lv1: '50', name: '苗栗監理站', address: '苗栗市福麗里福麗98號', county: '苗栗縣' },

  { no: '60', lv1: '60', name: '臺中區監理所', address: '臺中市大肚區瑞井里遊園路一段2號', county: '臺中市' },
  { no: '61', lv1: '60', name: '臺中市監理站', address: '臺中市北屯路77號', county: '臺中市' },
  { no: '62', lv1: '60', name: '埔里監理分站', address: '南投縣埔里鎮水頭里水頭路68號', county: '南投縣' },
  { no: '63', lv1: '60', name: '豐原監理站', address: '臺中市豐原區豐東路120號', county: '臺中市' },
  { no: '64', lv1: '60', name: '彰化監理站', address: '彰化縣花壇鄉南口村中山路二段457號', county: '彰化縣' },
  { no: '65', lv1: '60', name: '南投監理站', address: '南投縣南投市光明一路301號', county: '南投縣' },

  { no: '70', lv1: '70', name: '嘉義區監理所', address: '嘉義縣朴子市朴子七路29號', county: '嘉義縣' },
  { no: '71', lv1: '70', name: '東勢監理分站', address: '雲林縣東勢鄉新坤村新坤路333號', county: '雲林縣' },
  { no: '72', lv1: '70', name: '雲林監理站', address: '雲林縣斗六市雲林路二段411號', county: '雲林縣' },
  { no: '73', lv1: '70', name: '新營監理站', address: '臺南市新營區大同路55號', county: '臺南市' },
  { no: '74', lv1: '70', name: '臺南監理站', address: '臺南市崇德路1號', county: '臺南市' },
  { no: '75', lv1: '70', name: '麻豆監理站', address: '臺南市麻豆區北勢里新生北路551號', county: '臺南市' },
  { no: '76', lv1: '70', name: '嘉義市監理站', address: '嘉義市東區保建街89號', county: '嘉義市' },

  { no: '30', lv1: '30', name: '高雄市區監理所', address: '高雄市楠梓區德民路71號', county: '高雄市' },
  { no: '31', lv1: '30', name: '苓雅監理站', address: '高雄市三民區建國一路454號', county: '高雄市' },
  { no: '33', lv1: '30', name: '旗山監理站', address: '高雄市旗山區旗文路123-1號', county: '高雄市' },

  { no: '80', lv1: '80', name: '高雄區監理所', address: '高雄市鳳山區武營路361號', county: '高雄市' },
  { no: '81', lv1: '80', name: '臺東監理站', address: '臺東市正氣北路441號', county: '臺東縣' },
  { no: '82', lv1: '80', name: '屏東監理站', address: '屏東市忠孝路222號', county: '屏東縣' },
  { no: '83', lv1: '80', name: '恆春監理分站', address: '屏東縣恒春鎮草埔路11號', county: '屏東縣' },
  { no: '84', lv1: '80', name: '澎湖監理站', address: '澎湖縣馬公市光華里121號', county: '澎湖縣' },
];

export type Combo = { licenseType: string; lv1: string; dmvNo: string };

/** 全部 360 個「照類 × 監理站」組合，熱門照類排在前面 */
export function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (const t of LICENSE_TYPES) {
    for (const s of STATIONS) {
      out.push({ licenseType: t.code, lv1: s.lv1, dmvNo: s.no });
    }
  }
  return out;
}

export function hotCombos(): Combo[] {
  const hot = new Set(LICENSE_TYPES.filter((t) => t.hot).map((t) => t.code));
  return allCombos().filter((c) => hot.has(c.licenseType));
}

export function coldCombos(): Combo[] {
  const hot = new Set(LICENSE_TYPES.filter((t) => t.hot).map((t) => t.code));
  return allCombos().filter((c) => !hot.has(c.licenseType));
}

export const STATION_BY_NO = new Map(STATIONS.map((s) => [s.no, s]));
export const LICENSE_BY_CODE = new Map(LICENSE_TYPES.map((t) => [t.code, t]));
export const OFFICE_BY_LV1 = new Map(OFFICES.map((o) => [o.lv1, o]));
