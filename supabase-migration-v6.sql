-- ═══════════════════════════════════════════════════════════════
--  BCE EPIC Database — Schema Migration v6
--  Row Level Security for all public tables
--  Resolves: rls_disabled_in_public (Supabase security advisory)
--
--  Run in: https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql
--  Safe to re-run — all policy creation is idempotent via DO blocks.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. comic_entries ─────────────────────────────────────────
-- Public catalogue: anyone can read, authenticated users can write.
ALTER TABLE comic_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='comic_entries' AND policyname='comic_entries_public_read'
  ) THEN
    CREATE POLICY comic_entries_public_read
      ON comic_entries FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='comic_entries' AND policyname='comic_entries_auth_insert'
  ) THEN
    CREATE POLICY comic_entries_auth_insert
      ON comic_entries FOR INSERT WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='comic_entries' AND policyname='comic_entries_auth_update'
  ) THEN
    CREATE POLICY comic_entries_auth_update
      ON comic_entries FOR UPDATE USING (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='comic_entries' AND policyname='comic_entries_auth_delete'
  ) THEN
    CREATE POLICY comic_entries_auth_delete
      ON comic_entries FOR DELETE USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- ── 2. series_groups ─────────────────────────────────────────
ALTER TABLE series_groups ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='series_groups' AND policyname='series_groups_public_read'
  ) THEN
    CREATE POLICY series_groups_public_read
      ON series_groups FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='series_groups' AND policyname='series_groups_auth_insert'
  ) THEN
    CREATE POLICY series_groups_auth_insert
      ON series_groups FOR INSERT WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='series_groups' AND policyname='series_groups_auth_update'
  ) THEN
    CREATE POLICY series_groups_auth_update
      ON series_groups FOR UPDATE USING (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='series_groups' AND policyname='series_groups_auth_delete'
  ) THEN
    CREATE POLICY series_groups_auth_delete
      ON series_groups FOR DELETE USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- ── 3. isbn_cache ─────────────────────────────────────────────
-- Cache table: open read/write so any client can populate it.
ALTER TABLE isbn_cache ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='isbn_cache' AND policyname='isbn_cache_public_all'
  ) THEN
    CREATE POLICY isbn_cache_public_all
      ON isbn_cache FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 4. data_quality_flags ────────────────────────────────────
ALTER TABLE data_quality_flags ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='data_quality_flags' AND policyname='dqf_public_read'
  ) THEN
    CREATE POLICY dqf_public_read
      ON data_quality_flags FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='data_quality_flags' AND policyname='dqf_auth_write'
  ) THEN
    CREATE POLICY dqf_auth_write
      ON data_quality_flags FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;

-- ── 5. users ─────────────────────────────────────────────────
-- Public read (all users visible for display), self-write only.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='users' AND policyname='users_public_read'
  ) THEN
    CREATE POLICY users_public_read
      ON users FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='users' AND policyname='users_self_insert'
  ) THEN
    CREATE POLICY users_self_insert
      ON users FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='users' AND policyname='users_self_update'
  ) THEN
    CREATE POLICY users_self_update
      ON users FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='users' AND policyname='users_self_delete'
  ) THEN
    CREATE POLICY users_self_delete
      ON users FOR DELETE USING (auth.uid() = id);
  END IF;
END $$;

-- ── 6. user_entry_data ───────────────────────────────────────
-- Public read so all users can see each other's collections.
-- Write restricted to own rows only.
ALTER TABLE user_entry_data ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='user_entry_data' AND policyname='ued_public_read'
  ) THEN
    CREATE POLICY ued_public_read
      ON user_entry_data FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='user_entry_data' AND policyname='ued_self_insert'
  ) THEN
    CREATE POLICY ued_self_insert
      ON user_entry_data FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='user_entry_data' AND policyname='ued_self_update'
  ) THEN
    CREATE POLICY ued_self_update
      ON user_entry_data FOR UPDATE
      USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='user_entry_data' AND policyname='ued_self_delete'
  ) THEN
    CREATE POLICY ued_self_delete
      ON user_entry_data FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── 7. user_data (legacy stojr/nick table) ───────────────────
-- Legacy table used before OAuth. Keep fully open for backward
-- compatibility; new writes go to user_entry_data instead.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_data'
  ) THEN
    EXECUTE 'ALTER TABLE user_data ENABLE ROW LEVEL SECURITY';

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename='user_data' AND policyname='user_data_public_all'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY user_data_public_all
          ON user_data FOR ALL USING (true) WITH CHECK (true)
      $pol$;
    END IF;
  END IF;
END $$;
