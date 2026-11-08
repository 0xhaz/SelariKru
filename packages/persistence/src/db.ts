import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a database handle or an open transaction. */
export type Executor = Db | Tx;

export interface CreateDbOptions {
  max?: number;
  /** Sets the connection search_path. Used by tests to isolate a schema; omit in production. */
  searchPath?: string;
}

/** The caller supplies the connection string. Library code has no default and reads no environment. */
export function createDb(connectionString: string, options: CreateDbOptions = {}): { db: Db; close(): Promise<void> } {
  const client = postgres(connectionString, {
    max: options.max ?? 10,
    onnotice: () => {},
    ...(options.searchPath ? { connection: { search_path: options.searchPath } } : {}),
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

/** Run `fn` in one transaction: commit when it returns, roll back when it throws. */
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx));
}
