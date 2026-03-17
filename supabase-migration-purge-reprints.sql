-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Reprint Purge Migration
--  Removes all entries marked as reprints (reprint = 'Yes').
--  The "Contains Reprints" field and filter UI remain intact so
--  reprint entries can be re-added in the future if desired.
--
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
--  Safe to re-run (DELETE WHERE is idempotent when no rows match).
-- ═══════════════════════════════════════════════════════════════

-- 1. Preview what will be deleted (run this SELECT first to confirm)
-- SELECT id, pub, type, series, vol, subtitle, reprint
-- FROM comic_entries
-- WHERE reprint = 'Yes'
-- ORDER BY series, vol;

-- 2. Remove user collection data for reprint entries first (FK safety)
DELETE FROM user_entry_data
WHERE entry_id IN (
  SELECT id FROM comic_entries WHERE reprint = 'Yes'
);

DELETE FROM user_data
WHERE entry_id IN (
  SELECT id FROM comic_entries WHERE reprint = 'Yes'
);

-- 3. Remove data quality flags for reprint entries
DELETE FROM data_quality_flags
WHERE entry_id IN (
  SELECT id FROM comic_entries WHERE reprint = 'Yes'
);

-- 4. Remove reading order entries referencing reprints
DELETE FROM reading_order_entries
WHERE entry_id IN (
  SELECT id FROM comic_entries WHERE reprint = 'Yes'
);

-- 5. Delete the reprint entries themselves
DELETE FROM comic_entries
WHERE reprint = 'Yes';

-- 6. Confirm result
SELECT COUNT(*) AS remaining_reprints
FROM comic_entries
WHERE reprint = 'Yes';
