-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v8
--  Adds per-printing metadata support:
--    • printers   — reference table of known print shops
--    • printings  — child table, one row per printing edition
--                   of a comic_entries book
--
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
--  Safe to re-run — all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
--
--  Backward compatibility:
--    • comic_entries.reprint ('Yes'/'No') and comic_entries.isbn remain
--      unchanged so existing code continues to work.
--    • The migration seeds a "First Printing" row in printings for every
--      comic_entries row that already has an ISBN, preserving that data.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. printers — known print shops ───────────────────────────
CREATE TABLE IF NOT EXISTS printers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT printers_name_unique UNIQUE (name)
);

-- Seed common comic-book printers
INSERT INTO printers (name) VALUES
  ('Quad/Graphics'),
  ('RR Donnelley'),
  ('World Color Press'),
  ('LSC Communications'),
  ('Courier Corporation'),
  ('Transcontinental'),
  ('Cenveo')
ON CONFLICT (name) DO NOTHING;

-- ── 2. printings — per-edition metadata ───────────────────────
CREATE TABLE IF NOT EXISTS printings (
  id                   SERIAL PRIMARY KEY,
  entry_id             INTEGER NOT NULL REFERENCES comic_entries(id) ON DELETE CASCADE,
  edition_label        TEXT NOT NULL DEFAULT 'First Printing',
  printer              TEXT,
  printing_date_start  DATE,
  printing_date_end    DATE,
  errors_corrections   TEXT,
  cover_price          NUMERIC(8,2),
  isbn                 TEXT,
  sort_order           INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_printings_entry_id ON printings (entry_id);
CREATE INDEX IF NOT EXISTS idx_printings_printer  ON printings (printer) WHERE printer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_printings_isbn     ON printings (isbn)    WHERE isbn    IS NOT NULL;

-- ── 3. RLS on both new tables ──────────────────────────────────
ALTER TABLE printers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE printings ENABLE ROW LEVEL SECURITY;

-- printers: anyone can read; only authenticated users can write
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'printers' AND policyname = 'printers_select_public'
  ) THEN
    CREATE POLICY printers_select_public ON printers FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'printers' AND policyname = 'printers_write_authenticated'
  ) THEN
    CREATE POLICY printers_write_authenticated ON printers FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- printings: anyone can read; only authenticated users can write
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'printings' AND policyname = 'printings_select_public'
  ) THEN
    CREATE POLICY printings_select_public ON printings FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'printings' AND policyname = 'printings_write_authenticated'
  ) THEN
    CREATE POLICY printings_write_authenticated ON printings FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 4. Seed First Printing from existing ISBN data ─────────────
-- For every non-reprint entry that already has an ISBN, create a
-- "First Printing" row so existing data is preserved.
-- Uses a temp function to avoid duplicates on re-run.
DO $$
BEGIN
  INSERT INTO printings (entry_id, edition_label, isbn, sort_order)
  SELECT id, 'First Printing', isbn, 0
  FROM   comic_entries
  WHERE  isbn    IS NOT NULL
    AND  isbn    != ''
    AND  reprint  = 'No'
    AND  id NOT IN (SELECT entry_id FROM printings);
END $$;

-- ── 5. Verify ─────────────────────────────────────────────────
SELECT
  'printers'  AS tbl, COUNT(*) AS rows FROM printers
UNION ALL
SELECT
  'printings', COUNT(*) FROM printings;
