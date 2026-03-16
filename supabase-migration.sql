-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v2
--  Runs automatically via GitHub Actions (db-migrate workflow)
--  or paste into: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
-- ═══════════════════════════════════════════════════════════════

-- 1. New metadata columns (safe to re-run)
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS isbn                      TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS writers                   TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS artists                   TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS description               TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS issues_covered            TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS secondary_issues_covered  TEXT;

-- 2. 'stojr verified' confidence: no schema change needed (conf is free-form TEXT).

-- ═══════════════════════════════════════════════════════════════
--  Aliens Epic Collection — upsert from screenshot
--  Marvel · Licensed IP · Type: Epic · Reprint: No · stojr verified
--  DO block safely handles both insert (new) and update (existing) cases.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  _id INT;
BEGIN

  -- ── Aliens Vol 1 ──────────────────────────────────────────
  SELECT id INTO _id FROM comic_entries WHERE series='Aliens' AND vol=1;
  IF _id IS NOT NULL THEN
    UPDATE comic_entries SET
      pub='Marvel', type='Epic', subtitle='The Original Years',
      years='1988-1990', writers='Mark Verheiden', artists='Mark Nelson',
      pages=448, date='2023-03-14', licensed='Yes', reprint='No',
      conf='stojr verified', isbn='978-1302950682',
      cover_url='https://images.penguinrandomhouse.com/cover/9781302950682'
    WHERE id=_id;
  ELSE
    INSERT INTO comic_entries
      (pub,type,series,vol,subtitle,years,writers,artists,pages,date,licensed,reprint,conf,isbn,cover_url)
    VALUES
      ('Marvel','Epic','Aliens',1,'The Original Years','1988-1990',
       'Mark Verheiden','Mark Nelson',448,'2023-03-14','Yes','No',
       'stojr verified','978-1302950682',
       'https://images.penguinrandomhouse.com/cover/9781302950682');
  END IF;

  -- ── Aliens Vol 2 ──────────────────────────────────────────
  SELECT id INTO _id FROM comic_entries WHERE series='Aliens' AND vol=2;
  IF _id IS NOT NULL THEN
    UPDATE comic_entries SET
      pub='Marvel', type='Epic', subtitle='The Original Years',
      years='1990-1992', writers='Mike Richardson', artists='Damon Willis',
      pages=456, date='2024-08-20', licensed='Yes', reprint='No',
      conf='stojr verified', isbn='978-1302956318',
      cover_url='https://images.penguinrandomhouse.com/cover/9781302956318'
    WHERE id=_id;
  ELSE
    INSERT INTO comic_entries
      (pub,type,series,vol,subtitle,years,writers,artists,pages,date,licensed,reprint,conf,isbn,cover_url)
    VALUES
      ('Marvel','Epic','Aliens',2,'The Original Years','1990-1992',
       'Mike Richardson','Damon Willis',456,'2024-08-20','Yes','No',
       'stojr verified','978-1302956318',
       'https://images.penguinrandomhouse.com/cover/9781302956318');
  END IF;

  -- ── Aliens Vol 3 ──────────────────────────────────────────
  SELECT id INTO _id FROM comic_entries WHERE series='Aliens' AND vol=3;
  IF _id IS NOT NULL THEN
    UPDATE comic_entries SET
      pub='Marvel', type='Epic', subtitle='The Original Years',
      years='1992-1994',
      writers='Steven Grant, Jim Woodring, Ian Edginton',
      artists='Christopher Taylor, Kilian Plunkett, Will Simpson',
      pages=472, date='2025-11-18', licensed='Yes', reprint='No',
      conf='stojr verified', isbn='978-1302965167',
      cover_url='https://images.penguinrandomhouse.com/cover/9781302965167'
    WHERE id=_id;
  ELSE
    INSERT INTO comic_entries
      (pub,type,series,vol,subtitle,years,writers,artists,pages,date,licensed,reprint,conf,isbn,cover_url)
    VALUES
      ('Marvel','Epic','Aliens',3,'The Original Years','1992-1994',
       'Steven Grant, Jim Woodring, Ian Edginton',
       'Christopher Taylor, Kilian Plunkett, Will Simpson',
       472,'2025-11-18','Yes','No',
       'stojr verified','978-1302965167',
       'https://images.penguinrandomhouse.com/cover/9781302965167');
  END IF;

  -- ── Aliens Vol 4 ──────────────────────────────────────────
  SELECT id INTO _id FROM comic_entries WHERE series='Aliens' AND vol=4;
  IF _id IS NOT NULL THEN
    UPDATE comic_entries SET
      pub='Marvel', type='Epic', subtitle='The Original Years',
      years='1992-1993',
      writers='Chris Warner, Kelley Puckett, Paul Guinan, Dan Jolley',
      artists='Tony Akins, Allen Nunis, John Nadeau',
      pages=472, date='2026-10-27', licensed='Yes', reprint='No',
      conf='stojr verified', isbn='978-1302969448',
      cover_url='https://images.penguinrandomhouse.com/cover/9781302969448'
    WHERE id=_id;
  ELSE
    INSERT INTO comic_entries
      (pub,type,series,vol,subtitle,years,writers,artists,pages,date,licensed,reprint,conf,isbn,cover_url)
    VALUES
      ('Marvel','Epic','Aliens',4,'The Original Years','1992-1993',
       'Chris Warner, Kelley Puckett, Paul Guinan, Dan Jolley',
       'Tony Akins, Allen Nunis, John Nadeau',
       472,'2026-10-27','Yes','No',
       'stojr verified','978-1302969448',
       'https://images.penguinrandomhouse.com/cover/9781302969448');
  END IF;

END $$;

-- Auto-populate cover_url for any entry with an ISBN but no cover set
UPDATE comic_entries
SET cover_url = 'https://images.penguinrandomhouse.com/cover/' || REPLACE(isbn, '-', '')
WHERE isbn IS NOT NULL
  AND (cover_url IS NULL OR cover_url = '');

-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v3
--  Series Groups, structured year/issue fields, ISBN cache,
--  data quality flags, reading order support
-- ═══════════════════════════════════════════════════════════════

-- ── 1. series_groups reference table ──────────────────────────
CREATE TABLE IF NOT EXISTS series_groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  publisher   TEXT,
  character   TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── 2. isbn_cache table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS isbn_cache (
  isbn        TEXT PRIMARY KEY,
  source      TEXT,
  title       TEXT,
  subtitle    TEXT,
  authors     TEXT,
  page_count  INTEGER,
  pub_date    TEXT,
  description TEXT,
  cover_url   TEXT,
  fetched_at  TIMESTAMPTZ DEFAULT now(),
  failed      BOOLEAN DEFAULT false
);

-- ── 3. data_quality_flags table ──────────────────────────────
CREATE TABLE IF NOT EXISTS data_quality_flags (
  id          SERIAL PRIMARY KEY,
  entry_id    INTEGER REFERENCES comic_entries(id) ON DELETE CASCADE,
  flag_type   TEXT NOT NULL,
  detail      TEXT,
  resolved    BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── 4. New columns on comic_entries ──────────────────────────
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS series_group_id  INTEGER REFERENCES series_groups(id);
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS series_group     TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS year_start       INTEGER;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS year_end         INTEGER;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS sort_order       INTEGER;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS issue_start      INTEGER;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS issue_end        INTEGER;

-- ── 5. Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_entries_series_group    ON comic_entries(series_group);
CREATE INDEX IF NOT EXISTS idx_entries_series_group_id ON comic_entries(series_group_id);
CREATE INDEX IF NOT EXISTS idx_entries_series          ON comic_entries(series);
CREATE INDEX IF NOT EXISTS idx_entries_year_start      ON comic_entries(year_start);
CREATE INDEX IF NOT EXISTS idx_entries_year_end        ON comic_entries(year_end);
CREATE INDEX IF NOT EXISTS idx_entries_date            ON comic_entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_type            ON comic_entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_pub             ON comic_entries(pub);
CREATE INDEX IF NOT EXISTS idx_entries_group_year      ON comic_entries(series_group, year_start, year_end);

-- ── 6. Backfill year_start from years text field ─────────────
UPDATE comic_entries
SET year_start = CAST(substring(years FROM '(\d{4})') AS INTEGER)
WHERE years IS NOT NULL AND year_start IS NULL;

-- Backfill year_end (last 4-digit year in the string)
UPDATE comic_entries
SET year_end = sub.last_year
FROM (
  SELECT id, CAST((regexp_matches(years, '(\d{4})', 'g'))[1] AS INTEGER) AS last_year
  FROM comic_entries
  WHERE years IS NOT NULL AND year_end IS NULL
) sub
WHERE comic_entries.id = sub.id;

-- For single-year entries, set year_end = year_start if still null
UPDATE comic_entries
SET year_end = year_start
WHERE year_start IS NOT NULL AND year_end IS NULL;

-- ── 7. Backfill issue_start / issue_end from issues_covered ──
UPDATE comic_entries
SET issue_start = CAST(substring(issues_covered FROM '#?(\d+)') AS INTEGER)
WHERE issues_covered IS NOT NULL AND issue_start IS NULL;

UPDATE comic_entries
SET issue_end = CAST(substring(issues_covered FROM '#?\d+\s*[-–—]\s*(\d+)') AS INTEGER)
WHERE issues_covered IS NOT NULL AND issue_end IS NULL;

-- For single-issue entries, set issue_end = issue_start if still null
UPDATE comic_entries
SET issue_end = issue_start
WHERE issue_start IS NOT NULL AND issue_end IS NULL;
