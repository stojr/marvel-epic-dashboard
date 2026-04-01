-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v7
--  Ensure RLS is enabled on ALL public tables.
--  Resolves: rls_disabled_in_public (Supabase security advisory)
--
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
--  Safe to re-run — idempotent. Policies use IF NOT EXISTS guards.
--
--  Why v7? v6 used dynamic SQL for user_data which may not have
--  applied cleanly in all environments. This migration explicitly
--  enables RLS on every known public table and adds a catch-all
--  DO block to enable RLS on any unlisted public tables too.
-- ═══════════════════════════════════════════════════════════════

-- ── user_data (legacy stojr/nick table) ──────────────────────
-- Handle directly (not via dynamic EXECUTE) since the table exists.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_data'
  ) THEN
    EXECUTE 'ALTER TABLE user_data ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'user_data' AND policyname = 'user_data_public_all'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY user_data_public_all
          ON user_data FOR ALL USING (true) WITH CHECK (true)
      $pol$;
    END IF;
  END IF;
END $$;

-- ── Re-confirm RLS on all other known tables ──────────────────
-- These are all idempotent; already enabled in v5/v6 but listed
-- here so a fresh database run of v7 alone is also safe.
ALTER TABLE comic_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE series_groups      ENABLE ROW LEVEL SECURITY;
ALTER TABLE isbn_cache         ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_entry_data    ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reading_order_groups') THEN
    EXECUTE 'ALTER TABLE reading_order_groups ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reading_order_entries') THEN
    EXECUTE 'ALTER TABLE reading_order_entries ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='isbn_failures') THEN
    EXECUTE 'ALTER TABLE isbn_failures ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- ── Catch-all: enable RLS on any other public tables ─────────
-- Finds every table in the public schema that still has
-- row_security = false and enables it. Skips Supabase internals.
-- Tables with RLS already on are unaffected.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'           -- ordinary tables only
      AND c.relrowsecurity = false  -- RLS not yet enabled
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    RAISE NOTICE 'Enabled RLS on public.%', tbl;
  END LOOP;
END $$;
