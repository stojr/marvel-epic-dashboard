-- BCE Comics Pod — Enrichment Log Migration
-- Run this once in the Supabase SQL Editor before using enrich.mjs
-- Dashboard → SQL Editor → Paste this → Run
--
-- Creates: enrichment_log table, indexes, enrichment_run_summary view, RLS policy

-- ─── TABLE ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrichment_log (
  id            bigserial PRIMARY KEY,
  entry_id      bigint NOT NULL REFERENCES comic_entries(id) ON DELETE CASCADE,
  field         text NOT NULL CHECK (field IN ('isbn', 'years', 'issues_covered')),
  old_value     text,
  new_value     text NOT NULL,
  source_url    text,
  source_label  text,
  run_id        text,
  status        text NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'skipped', 'no_match', 'conflict')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS enrichment_log_entry_id_idx ON enrichment_log(entry_id);
CREATE INDEX IF NOT EXISTS enrichment_log_run_id_idx   ON enrichment_log(run_id);
CREATE INDEX IF NOT EXISTS enrichment_log_status_idx   ON enrichment_log(status);

-- ─── VIEW ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW enrichment_run_summary AS
SELECT
  run_id,
  MIN(created_at)                                      AS started_at,
  MAX(created_at)                                      AS finished_at,
  COUNT(*) FILTER (WHERE status = 'applied')           AS applied,
  COUNT(*) FILTER (WHERE status = 'skipped')           AS skipped,
  COUNT(*) FILTER (WHERE status = 'no_match')          AS no_match,
  COUNT(*) FILTER (WHERE status = 'conflict')          AS conflict,
  COUNT(*)                                             AS total
FROM enrichment_log
GROUP BY run_id
ORDER BY started_at DESC;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE enrichment_log ENABLE ROW LEVEL SECURITY;

-- Public read (consistent with other tables)
CREATE POLICY "enrichment_log_select_public"
  ON enrichment_log FOR SELECT
  USING (true);

-- Only authenticated users can insert (the script uses the service role key, which bypasses RLS)
CREATE POLICY "enrichment_log_insert_authed"
  ON enrichment_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ─── MONITOR QUERIES (for reference) ─────────────────────────────────────────

-- Check run summaries:
-- SELECT * FROM enrichment_run_summary;

-- Check remaining gaps:
-- SELECT pub, type,
--   COUNT(*) FILTER (WHERE isbn IS NULL OR isbn = '')           AS still_missing_isbn,
--   COUNT(*) FILTER (WHERE issues_covered IS NULL OR issues_covered = '') AS still_missing_issues,
--   COUNT(*) FILTER (WHERE years IS NULL OR years = '')         AS still_missing_years
-- FROM comic_entries
-- GROUP BY pub, type ORDER BY pub, type;

-- ─── ROLLBACK TEMPLATE ───────────────────────────────────────────────────────
-- Replace <RUN_ID> with the actual run_id string before executing.

-- Preview:
-- SELECT e.id, e.series, e.vol, l.field, l.old_value, l.new_value
-- FROM enrichment_log l
-- JOIN comic_entries e ON e.id = l.entry_id
-- WHERE l.run_id = '<RUN_ID>' AND l.status = 'applied'
-- ORDER BY e.series, e.vol, l.field;

-- Execute rollback (review preview first!):
-- BEGIN;
-- UPDATE comic_entries c SET isbn = l.old_value
--   FROM enrichment_log l WHERE l.entry_id = c.id AND l.run_id = '<RUN_ID>' AND l.status = 'applied' AND l.field = 'isbn';
-- UPDATE comic_entries c SET years = l.old_value
--   FROM enrichment_log l WHERE l.entry_id = c.id AND l.run_id = '<RUN_ID>' AND l.status = 'applied' AND l.field = 'years';
-- UPDATE comic_entries c SET issues_covered = l.old_value
--   FROM enrichment_log l WHERE l.entry_id = c.id AND l.run_id = '<RUN_ID>' AND l.status = 'applied' AND l.field = 'issues_covered';
-- DELETE FROM enrichment_log WHERE run_id = '<RUN_ID>';
-- COMMIT;
