-- theskyisnotreal.com: D1 schema
-- Subscribers captured by the "join the revolution" email signup form.
-- Apply locally:  wrangler d1 execute theskyisnotreal-db --file=schema.sql
-- Apply to prod:  wrangler d1 execute theskyisnotreal-db --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scans recorded by the "scan the sky" detector (POST /api/scan beacon). Geo is
-- Cloudflare's IP-based edge data (request.cf): coarse city/region/country, no
-- IP address and no other PII is stored. Only user-initiated scans are counted;
-- reproducing a shared /s/<id> permalink does not record a new scan.
CREATE TABLE IF NOT EXISTS scans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  country    TEXT,
  region     TEXT,
  city       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans (created_at);
