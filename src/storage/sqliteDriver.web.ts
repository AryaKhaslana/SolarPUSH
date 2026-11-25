import type { SqliteDbLike } from "./sqliteDriver";

/** Web builds persist to localStorage and skip bundling wa-sqlite.wasm. */
export async function openSqliteDatabase(_name: string): Promise<SqliteDbLike | null> {
  return null;
}
