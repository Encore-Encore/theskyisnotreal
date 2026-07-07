-- theskyisnotreal.com — D1 schema
-- Subscribers captured by the "join the revolution" email signup form.
-- Apply locally:  wrangler d1 execute theskyisnotreal-db --file=schema.sql
-- Apply to prod:  wrangler d1 execute theskyisnotreal-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
