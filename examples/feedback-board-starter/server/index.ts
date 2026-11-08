import { createApp } from './app';
import { openDatabase } from './db';

// Opens the (empty) database so the migration mechanism runs; no feedback tables exist in the baseline.
openDatabase().close();

const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => {
  console.log(`feedback-board-starter API listening on :${port}`);
});
