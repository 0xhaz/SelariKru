import { createApp } from './app';
import { openDatabase } from './db';
import { seedIfEmpty } from './store';

const db = openDatabase();
seedIfEmpty(db, process.env.FEEDBACK_SEED_FILE);

const port = Number(process.env.PORT ?? 3001);
createApp(db).listen(port, () => {
  console.log(`feedback-board API and frontend listening on :${port}`);
});
