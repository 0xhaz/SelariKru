CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'planned', 'done')),
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_order ON feedback (created_at DESC, id DESC);
