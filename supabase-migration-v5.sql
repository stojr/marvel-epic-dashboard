-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v5
--  Performance indexes + Reading Order tables + ISBN failure log
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
-- ═══════════════════════════════════════════════════════════════

-- 1. Performance indexes
CREATE INDEX IF NOT EXISTS idx_comic_entries_isbn ON comic_entries (isbn) WHERE isbn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comic_entries_series ON comic_entries (series);
CREATE INDEX IF NOT EXISTS idx_comic_entries_series_group ON comic_entries (series_group) WHERE series_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comic_entries_pub ON comic_entries (pub);
CREATE INDEX IF NOT EXISTS idx_comic_entries_type ON comic_entries (type);
CREATE INDEX IF NOT EXISTS idx_comic_entries_date ON comic_entries (date) WHERE date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comic_entries_year_start ON comic_entries (year_start) WHERE year_start IS NOT NULL;

-- 2. Reading order groups
CREATE TABLE IF NOT EXISTS reading_order_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  series_group TEXT,
  description TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Reading order entries (ordered list within a group)
CREATE TABLE IF NOT EXISTS reading_order_entries (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES reading_order_groups(id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES comic_entries(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ro_entries_group ON reading_order_entries (group_id, position);

-- 4. ISBN lookup failure log (for retry logic)
CREATE TABLE IF NOT EXISTS isbn_failures (
  isbn TEXT PRIMARY KEY,
  attempts INTEGER DEFAULT 1,
  last_attempt TIMESTAMPTZ DEFAULT now(),
  error TEXT,
  retry_after TIMESTAMPTZ
);

-- 5. RLS policies
ALTER TABLE reading_order_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_order_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE isbn_failures ENABLE ROW LEVEL SECURITY;

-- Public read, authenticated write
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reading_order_groups_public_read') THEN
    CREATE POLICY reading_order_groups_public_read ON reading_order_groups FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reading_order_groups_auth_write') THEN
    CREATE POLICY reading_order_groups_auth_write ON reading_order_groups FOR ALL USING (auth.uid() = created_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reading_order_entries_public_read') THEN
    CREATE POLICY reading_order_entries_public_read ON reading_order_entries FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reading_order_entries_auth_write') THEN
    CREATE POLICY reading_order_entries_auth_write ON reading_order_entries FOR ALL USING (
      EXISTS (SELECT 1 FROM reading_order_groups WHERE id = reading_order_entries.group_id AND created_by = auth.uid())
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'isbn_failures_public') THEN
    CREATE POLICY isbn_failures_public ON isbn_failures FOR ALL USING (true);
  END IF;
END $$;
