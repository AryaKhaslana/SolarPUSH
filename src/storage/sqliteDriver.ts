import { openDatabaseAsync } from "expo-sqlite";

export interface SqliteDbLike {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

/** Opens the native offline SQLite database cleanly without Metro async chunking. */
export async function openSqliteDatabase(name: string): Promise<SqliteDbLike | null> {
  return (await openDatabaseAsync(name)) as unknown as SqliteDbLike;
}
