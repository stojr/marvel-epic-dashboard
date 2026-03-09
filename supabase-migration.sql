-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v2
--  Run this in the Supabase SQL Editor:
--    https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
-- ═══════════════════════════════════════════════════════════════

-- 1. Add new metadata columns to comic_entries
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS isbn        TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS writers     TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS artists     TEXT;
ALTER TABLE comic_entries ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. 'stojr verified' confidence value: no schema change needed.
--    The conf column is already TEXT with no check constraint,
--    so the new dropdown option works immediately after the HTML deploy.

-- ═══════════════════════════════════════════════════════════════
--  Aliens Epic Collection data — upsert from screenshot
--  (stojr verified, Marvel, Licensed IP, Type: Epic, Reprint: No)
-- ═══════════════════════════════════════════════════════════════

-- Helper: upsert Aliens Vol 1
INSERT INTO comic_entries
  (pub, type, series, vol, subtitle, years, writers, artists, pages, date, licensed, reprint, conf, isbn)
VALUES
  ('Marvel','Epic','Aliens',1,'The Original Years','1988-1990',
   'Mark Verheiden','Mark Nelson',448,'2023-03-14','Yes','No','stojr verified','978-1302950682')
ON CONFLICT (series, vol)
DO UPDATE SET
  subtitle   = EXCLUDED.subtitle,
  years      = EXCLUDED.years,
  writers    = EXCLUDED.writers,
  artists    = EXCLUDED.artists,
  pages      = EXCLUDED.pages,
  date       = EXCLUDED.date,
  licensed   = EXCLUDED.licensed,
  reprint    = EXCLUDED.reprint,
  conf       = EXCLUDED.conf,
  isbn       = EXCLUDED.isbn;

-- Aliens Vol 2
INSERT INTO comic_entries
  (pub, type, series, vol, subtitle, years, writers, artists, pages, date, licensed, reprint, conf, isbn)
VALUES
  ('Marvel','Epic','Aliens',2,'The Original Years','1990-1992',
   'Mike Richardson','Damon Willis',456,'2024-08-20','Yes','No','stojr verified','978-1302956318')
ON CONFLICT (series, vol)
DO UPDATE SET
  subtitle   = EXCLUDED.subtitle,
  years      = EXCLUDED.years,
  writers    = EXCLUDED.writers,
  artists    = EXCLUDED.artists,
  pages      = EXCLUDED.pages,
  date       = EXCLUDED.date,
  licensed   = EXCLUDED.licensed,
  reprint    = EXCLUDED.reprint,
  conf       = EXCLUDED.conf,
  isbn       = EXCLUDED.isbn;

-- Aliens Vol 3
INSERT INTO comic_entries
  (pub, type, series, vol, subtitle, years, writers, artists, pages, date, licensed, reprint, conf, isbn)
VALUES
  ('Marvel','Epic','Aliens',3,'The Original Years','1992-1994',
   'Steven Grant, Jim Woodring, Ian Edginton',
   'Christopher Taylor, Kilian Plunkett, Will Simpson',
   472,'2025-11-18','Yes','No','stojr verified','978-1302965167')
ON CONFLICT (series, vol)
DO UPDATE SET
  subtitle   = EXCLUDED.subtitle,
  years      = EXCLUDED.years,
  writers    = EXCLUDED.writers,
  artists    = EXCLUDED.artists,
  pages      = EXCLUDED.pages,
  date       = EXCLUDED.date,
  licensed   = EXCLUDED.licensed,
  reprint    = EXCLUDED.reprint,
  conf       = EXCLUDED.conf,
  isbn       = EXCLUDED.isbn;

-- Aliens Vol 4
INSERT INTO comic_entries
  (pub, type, series, vol, subtitle, years, writers, artists, pages, date, licensed, reprint, conf, isbn)
VALUES
  ('Marvel','Epic','Aliens',4,'The Original Years','1992-1993',
   'Chris Warner, Kelley Puckett, Paul Guinan, Dan Jolley',
   'Tony Akins, Allen Nunis, John Nadeau',
   472,'2026-10-27','Yes','No','stojr verified','978-1302969448')
ON CONFLICT (series, vol)
DO UPDATE SET
  subtitle   = EXCLUDED.subtitle,
  years      = EXCLUDED.years,
  writers    = EXCLUDED.writers,
  artists    = EXCLUDED.artists,
  pages      = EXCLUDED.pages,
  date       = EXCLUDED.date,
  licensed   = EXCLUDED.licensed,
  reprint    = EXCLUDED.reprint,
  conf       = EXCLUDED.conf,
  isbn       = EXCLUDED.isbn;

-- ═══════════════════════════════════════════════════════════════
--  Auto-populate cover_url for entries that have an ISBN but
--  no cover_url set yet.
-- ═══════════════════════════════════════════════════════════════
UPDATE comic_entries
SET cover_url = 'https://images.penguinrandomhouse.com/cover/' || REPLACE(isbn, '-', '')
WHERE isbn IS NOT NULL
  AND (cover_url IS NULL OR cover_url = '');
