// 只給型別檢查用：app.ts import 的 src/stats.ts 會沿著 `import type` 拉到原型的 src/db.ts，
// 而那支檔案引用 Cloudflare 的全域型別。api 不依賴 @cloudflare/workers-types，這裡補上它用到的最小子集。
interface D1Result<T = unknown> {
  results?: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
