import { createDb, migrate } from '@selarikru/persistence';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('ConfigError: missing required configuration: DATABASE_URL');
  process.exit(1);
}
const { db, close } = createDb(url, { max: 1 });
const applied = await migrate(db);
console.log(applied.length > 0 ? `applied migrations: ${applied.join(', ')}` : 'migrations up to date');
await close();
