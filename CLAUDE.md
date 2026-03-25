# BCE Comics Pod — EPIC Database

## Overview

Personal comic collection tracker for the **BCE Comics Pod** (hosts: stojr and Nick). Tracks Marvel Epic Collections, DC Finest, and Omnibus releases — what each host owns, has read, or wants.

**Architecture philosophy:** Everything lives in a single `index.html`. No build tools, no frameworks, no bundlers. If it can't be done in vanilla HTML/CSS/JS loaded directly from GitHub Pages, we don't do it. Keep it deployable by dragging a file.

- **Frontend:** `index.html` — GitHub Pages (`stojr.github.io/marvel-epic-dashboard`)
- **Backend:** Supabase (PostgreSQL, accessed via REST API + Auth JS client)
- **Deployment:** Push to `main` → live immediately via GitHub Pages

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Markup/Style/Logic | Vanilla HTML / CSS / JS — single `index.html` |
| Fonts | Google Fonts: Bebas Neue (headings), Barlow Condensed (UI), Barlow (body) |
| Charts | Custom `<canvas>` — no chart library |
| Backend | Supabase REST API (`quxuidnmewcmovjbnfgy.supabase.co`) |
| Auth | Supabase Auth — Google OAuth 2.0 |
| Export | Client-side CSV via `Blob` + `URL.createObjectURL` |

### Supabase access pattern

Auth uses the Supabase JS client (`window.supabase.createClient`) for session management and OAuth. All database reads/writes use raw `fetch()` against the REST API — **not** the Supabase JS data client.

```js
// Auth — JS client
const sbClient = window.supabase.createClient(SB_URL, SB_KEY);

// Data — raw fetch with dynamic JWT
function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + currentAccessToken   // JWT when signed in, anon key otherwise
  };
}
```

`currentAccessToken` is set from `session.access_token` in `onAuthStateChange` and `getSession()`, and reset to the anon key on sign-out. This ensures RLS `auth.uid()` checks pass for all writes.

---

## Database Schema

### `comic_entries` — main catalogue

```sql
id                  SERIAL PRIMARY KEY
pub                 TEXT          -- 'Marvel' | 'DC' | 'Other'
type                TEXT          -- 'Epic' | 'Omnibus' | 'Finest' | etc.
series              TEXT
vol                 INTEGER
subtitle            TEXT
years               TEXT          -- display string e.g. '1963-1965'
year_start          INTEGER       -- parsed from years (indexed)
year_end            INTEGER       -- parsed from years (indexed)
pages               INTEGER
date                TEXT          -- release date
isbn                TEXT
licensed            TEXT          -- 'Yes' | 'No'
reprint             TEXT          -- 'Yes' | 'No'
writers             TEXT
artists             TEXT
description         TEXT
issues_covered      TEXT          -- e.g. '#1-#24, Annual #1'
secondary_issues_covered TEXT
issue_start         INTEGER       -- parsed from issues_covered
issue_end           INTEGER       -- parsed from issues_covered
series_group        TEXT          -- denormalised group name (e.g. 'Spider-Man')
series_group_id     INTEGER REFERENCES series_groups(id)
sort_order          INTEGER
cover_url           TEXT
conf                TEXT          -- confidence / verification notes
```

### `users` — OAuth profile

```sql
id            UUID PRIMARY KEY   -- matches auth.users.id
email         TEXT
display_name  TEXT
color         TEXT               -- hex colour for UI chips e.g. '#c97fff'
avatar_url    TEXT
created_at    TIMESTAMPTZ
```

### `user_entry_data` — per-user collection tracking

```sql
user_id   UUID REFERENCES users(id) ON DELETE CASCADE
entry_id  INTEGER REFERENCES comic_entries(id) ON DELETE CASCADE
owned     BOOLEAN DEFAULT false
wishlist  BOOLEAN DEFAULT false
read      BOOLEAN DEFAULT false
notes     TEXT
PRIMARY KEY (user_id, entry_id)
```

### `user_data` — legacy (stojr/Nick columns, pre-OAuth)

Still present for backward compatibility. New writes go to `user_entry_data`. Legacy rows are migrated to `user_entry_data` when a user claims their legacy profile after first OAuth sign-in.

### Supporting tables

| Table | Purpose |
|-------|---------|
| `series_groups` | Groups series variants under one name (e.g. all Spider-Man titles → "Spider-Man") |
| `isbn_cache` | ISBN → metadata lookup cache (title, authors, pages, cover) |
| `data_quality_flags` | Tracks data issues per entry |
| `reading_order_groups` | Named reading order sequences |
| `reading_order_entries` | Ordered entry list within a reading order group |
| `isbn_failures` | Failed ISBN lookup log for retry logic |

> **Cover images** were previously stored as base64 in `user_data`. New covers use URLs (`cover_url` on `comic_entries`). Base64 legacy covers are loaded into `COVER_OVERRIDES` at startup and displayed where no `cover_url` exists.

---

## Authentication Flow

Google OAuth 2.0 via Supabase Auth.

1. User clicks **Sign in with Google** → `sbClient.auth.signInWithOAuth({ provider: 'google' })`
2. Supabase redirects to Google, then back to `window.location.origin + pathname`
3. `onAuthStateChange` fires with the session → JWT stored in `currentAccessToken`
4. If new user: profile row auto-created in `users` via upsert
5. If legacy data exists (stojr/Nick): claim dialog offered to migrate data to the new user's UUID
6. Dashboard data loads (`loadData()`)

Unauthenticated visitors see a **login wall** — no data loads until a valid session exists. Sign-out clears all local state and returns to the login wall.

```
Google OAuth app:
  Client ID / Secret → configured in Supabase Dashboard → Auth → Providers → Google
  Authorized JS origin:      https://stojr.github.io
  Authorized redirect URI:   https://quxuidnmewcmovjbnfgy.supabase.co/auth/v1/callback

Supabase URL config:
  Site URL:       https://stojr.github.io/marvel-epic-dashboard
  Redirect URLs:  https://stojr.github.io/marvel-epic-dashboard/
                  https://stojr.github.io/marvel-epic-dashboard/index.html
```

---

## Row Level Security

All public-schema tables have RLS enabled (migration v6). Policy summary:

| Table | SELECT | INSERT / UPDATE / DELETE |
|-------|--------|--------------------------|
| `comic_entries` | Public | Authenticated users |
| `series_groups` | Public | Authenticated users |
| `isbn_cache` | Public | Anyone |
| `data_quality_flags` | Public | Authenticated users |
| `users` | Public | Own row only (`auth.uid() = id`) |
| `user_entry_data` | Public | Own row only (`auth.uid() = user_id`) |
| `user_data` (legacy) | Public | Anyone |

Public SELECT on `user_entry_data` is intentional — the UI shows all users' owned/wishlist/read status simultaneously.

---

## Key UI Patterns

- **Login wall** — full-screen overlay; hides on successful auth, returns on sign-out
- **Filter bar** — Publisher, Type, Confidence, search text, ownership toggles per user
- **Table view** — paginated (100/page), click column headers to sort; second sort key is `vol`
- **Card view** — cover art grid, same filters apply
- **Click-to-expand** — row detail panel: cover, full metadata, per-user notes
- **Add/Edit modal** — cover via URL paste or local file upload (stored as base64 in legacy path)
- **Dark/light theme** — toggled via button, persisted to `localStorage`
- **Profile chips** — each user gets a colour-coded chip; owned/wishlist/read shown per user
- **Account Settings** — click avatar or ⚙ to edit display name and profile colour
- **Charts** — bar + donut via custom `<canvas>` (no library)
- **Default sort** — Series A→Z, then Volume

---

## Code Conventions

- All Supabase data calls go through `sbFetch()` → `sbSelect / sbInsert / sbUpdate / sbDelete / sbUpsert`
- Auth token is dynamic — never hardcode the anon key as the `Authorization` value for write paths
- Toast notifications for success/error feedback (`showToast(msg, isError)`)
- Syncing spinner (`setSyncing(true/false)`) during any write operation
- Legacy profile IDs are constants: `LEGACY_STOJR_ID`, `LEGACY_NICK_ID` (placeholder UUIDs)
- Series grouping resolved via `getEffectiveGroup(d)` — prefers `series_group` over `series`

---

## Database Migrations

Migrations are plain SQL files run in order. GitHub Actions (`db-migrate.yml`) runs all three on push to `main` when any migration file changes, or manually via `workflow_dispatch`.

```
supabase-migration.sql      v1–v4  Core schema, users, user_entry_data, series_groups, isbn_cache
supabase-migration-v5.sql   v5     Performance indexes, reading order tables, isbn_failures, initial RLS
supabase-migration-v6.sql   v6     RLS on all remaining public tables
```

To apply manually: paste into [Supabase SQL Editor](https://supabase.com/dashboard/project/quxuidnmewcmovjbnfgy/sql).

---

## Repository

| Item | Value |
|------|-------|
| Repo | `stojr/marvel-epic-dashboard` |
| Live site | `https://stojr.github.io/marvel-epic-dashboard` |
| Main file | `index.html` |
| Supabase project | `quxuidnmewcmovjbnfgy` |
| Deployment | GitHub Pages — auto-deploys from `main` |

---

## Current State

- 600+ entries (Marvel Epic Collections, DC Finest, licensed IP)
- Google OAuth fully enabled with login wall
- RLS enforced on all tables
- Multi-user support: any number of Google accounts, each with own owned/wishlist/read tracking
- Legacy stojr/Nick data migrated to OAuth accounts on first sign-in

---

## Planned Work

### Near-term
- Admin vs user roles (stojr = admin; only admins can add/edit/delete catalogue entries)
- RLS update to enforce admin role at database level (currently any authenticated user can write `comic_entries`)

### Roadmap
- **Run View** — visual timeline of a character's publishing history with gap/overlap detection via `issues_covered` parsing
- Bulk populate `issues_covered` starting with Amazing Spider-Man
- Potential Supabase Storage migration for cover images (currently URL-based or legacy base64)
