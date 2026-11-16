/**
 * 原型 src/db.ts 的型別註記用到 Cloudflare D1 的全域型別。
 * AWS 版只 import 其中的純函式（diffCombo），不會碰到 D1，
 * 這裡給一個最小的宣告讓 tsc 能檢查，而不用安裝 @cloudflare/workers-types。
 */
interface D1Result<T> {
  results?: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}
