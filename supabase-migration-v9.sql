-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v9
--  Adds paper_quality TEXT to printings table.
--
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
--  Safe to re-run — ADD COLUMN IF NOT EXISTS is idempotent.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE printings ADD COLUMN IF NOT EXISTS paper_quality TEXT;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'printings' AND column_name = 'paper_quality';
