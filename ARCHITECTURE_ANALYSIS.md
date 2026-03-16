# BCE Comics — Architecture Analysis & Improvement Plan

## Part 1: Critical Evaluation of the Current System

### Architecture Overview

BCE Comics is a **single-file web application** (`index.html`, ~4,163 lines) with a **Supabase PostgreSQL** backend. It uses vanilla JavaScript with no build system, no framework, and no module system. All HTML, CSS, and JS live in one file.

**Stack:**
- Frontend: Vanilla HTML/CSS/JS (single file)
- Backend: Supabase (PostgreSQL + REST API + Auth)
- Auth: Google OAuth via Supabase
- Hosting: Static file deployment
- CI/CD: GitHub Actions for DB migrations

---

### 1.1 Database Structure

**Strengths:**
- Clean relational design with 7 tables covering core needs
- `series_groups` reference table exists and is properly linked via FK
- `isbn_cache` prevents redundant API calls
- `data_quality_flags` provides structured data validation
- `user_entry_data` uses a clean composite PK (user_id, entry_id)
- Good index coverage on frequently queried columns
- Compound index `idx_entries_group_year` on (series_group, year_start, year_end) is well-designed
- Idempotent migrations with `IF NOT EXISTS`

**Weaknesses:**
- **Denormalized `series_group` text field** alongside `series_group_id` FK — dual representation creates sync risk
- **No `num` column documentation** — unclear how `num` differs from `vol`
- **`years` stored as TEXT** with computed `year_start`/`year_end` — fragile parsing, backfill can drift
- **`date` stored as TEXT** instead of DATE type — prevents native date operations
- **No reading order tables** — reading order is calculated entirely at render time from sort_order/year_start
- **No `era` or `decade` column** — era exploration requires runtime computation
- **`reprint` stored as TEXT** ('Yes'/'No') instead of BOOLEAN
- **`licensed` stored as TEXT** ('Yes'/'No') instead of BOOLEAN
- **`conf` is freeform TEXT** — no enum constraint, data quality depends on UI
- **`cover_url` for base64** stored in legacy `user_data` table — split storage pattern
- **No `created_at` or `updated_at`** on `comic_entries` — no audit trail
- **`prh_link` is entry-level** — no normalized publisher/retailer link table

**Assessment:** The schema is solid for its current scope but lacks the relational depth needed for reading order, era exploration, and cross-series discovery. The TEXT-as-boolean pattern should be cleaned up.

---

### 1.2 Application Logic

**Strengths:**
- Supabase helper functions (`sbFetch`, `sbSelect`, `sbInsert`, `sbUpdate`, `sbUpsert`) provide clean API abstraction
- ISBN lookup pipeline with fallback chain (Google Books → OpenLibrary → PRH) is well-designed
- Data quality checks run automatically and surface issues via badge
- `getEffectiveGroup()` provides clean series group resolution
- `suggestSeriesGroup()` offers smart auto-suggestions
- Missing volume detection in Run View via gap analysis
- Parallel data loading on startup

**Weaknesses:**
- **4,163 lines in one file** — no separation of concerns, extremely difficult to navigate and maintain
- **All state is global** — `ALL_DATA`, `USER_DATA`, `COVER_OVERRIDES`, `ISBN_CACHE` etc. are window-level variables
- **No error boundaries** — a single JS error can break the entire application
- **DOM manipulation via innerHTML** — XSS risk in several places (e.g., `rvEsc` is used inconsistently)
- **No offline capability** — requires network for every operation
- **Filtering recalculates everything** — `applyFilters()` iterates all data on every filter change
- **ISBN lookup uses `allorigins.win` CORS proxy** — third-party dependency, unreliable, potential security risk
- **No debouncing on search input** (only on ISBN input)
- **Run View sort logic is complex** — manual sort_order + year_start + issue_start + date creates unpredictable ordering when data is incomplete
- **Chart rendering is manual** — canvas-based bar/donut charts without a library, making them fragile

**Assessment:** The application logic is functional but the single-file architecture is the biggest technical debt. The codebase has outgrown its structure.

---

### 1.3 User Interface Design

**Strengths:**
- Strong visual identity — dark theme with comic book aesthetic
- Trading card UI in Run View is distinctive and memorable
- Publisher tab navigation is intuitive (All / Marvel / DC / Omnibus)
- Filter bar is comprehensive with owner pills, type filters, year, search
- Cover image integration with lightbox zoom
- "Around the Same Time" discovery feature in row expand
- Responsive mobile support with FAB and stacked layouts
- Light/dark theme toggle

**Weaknesses:**
- **Information overload on main dashboard** — stats cards, charts, filters, and table all compete for attention
- **No dedicated navigation** — switching between Dashboard, Run View, Bulk Edit requires knowing the buttons exist
- **Run View is a full-screen overlay** — feels disconnected from the main app
- **No breadcrumbs or back navigation** — users can get lost
- **Series Group filtering exists but is buried** — not prominent enough for a key feature
- **No collection completeness indicator** — users can't quickly see "you have 7 of 12 Spider-Man Epics"
- **Table is the primary view** — no card/grid layout option for visual browsing
- **Bulk Edit is a spreadsheet** — functional but intimidating for casual data entry
- **No visual distinction between owned/unowned** in the main table beyond checkbox state
- **Run View requires `issues_covered` data** — many entries lack this, making the feature appear broken
- **Multi-series View is a separate mode toggle** — should be more discoverable

**Assessment:** The UI is visually polished but suffers from discoverability problems. Key features are hidden behind buttons or mode toggles. The dashboard tries to show everything at once rather than guiding users through a workflow.

---

### 1.4 Key Questions Answered

**Does the current data model support long comic runs spanning multiple titles?**

Partially. The `series_group` field and `series_groups` table exist and allow grouping (e.g., all Spider-Man titles under "Spider-Man"). The Run View supports a "By Group" toggle. However:
- Reading order across titles relies on `sort_order` (manual) or `year_start` (automatic) — no dedicated reading order engine
- There's no way to define order relationships between specific entries
- Overlapping year ranges between series create ambiguous ordering
- The system works for simple cases but breaks down for complex crossover events

**Does the UI make it easy to explore runs for characters like Spider-Man, X-Men, or Avengers?**

Not well enough. Users must:
1. Know to click "Run View" button
2. Toggle "By: Group" mode
3. Select the group from a dropdown
4. Hope that `issues_covered` data exists

There's no character-centric landing page, no visual overview of available runs, and no way to see all Spider-Man content from the main dashboard without using the Series Group filter.

**Does the dashboard help users quickly understand what they own and what they are missing?**

Partially. The owner filter pills show per-user ownership counts, and the Run View detects missing volumes in a sequential run. However:
- There's no percentage-complete indicator for any run
- Missing volumes are only visible in Run View, not on the dashboard
- No "what should I buy next" recommendation
- No visual distinction between owned and unowned in the main table beyond checkbox state

---

## Part 2: Series Group — Design

### Current State

The `series_groups` table already exists:

```
series_groups
├── id (SERIAL PK)
├── name (TEXT UNIQUE) — e.g., "Spider-Man"
├── publisher (TEXT)
├── character (TEXT)
├── notes (TEXT)
└── created_at (TIMESTAMPTZ)
```

And `comic_entries` has both `series_group` (TEXT) and `series_group_id` (INTEGER FK).

### Recommended Improvements

**Problem:** The dual `series_group`/`series_group_id` pattern creates sync risk. The text field can diverge from the FK reference.

**Solution:** Keep both but enforce consistency:

1. **Make `series_group_id` the source of truth** — always resolve group name from the FK
2. **Keep `series_group` as a denormalized cache** for query performance but update it via trigger
3. **Add a database trigger** to auto-sync `series_group` text when `series_group_id` changes

**Additional columns for `series_groups`:**

```sql
ALTER TABLE series_groups ADD COLUMN IF NOT EXISTS display_order INTEGER;
ALTER TABLE series_groups ADD COLUMN IF NOT EXISTS icon_url TEXT;
ALTER TABLE series_groups ADD COLUMN IF NOT EXISTS description TEXT;
```

- `display_order` — controls how groups appear in filters/lists
- `icon_url` — optional character/logo image for visual navigation
- `description` — brief description for the group landing page

**UI Changes:**

1. **Series Group selector** should appear prominently at the top of every screen, not buried in the filter bar
2. **Series Group badges** should appear on table rows and cards
3. **Add/Edit modal** should auto-suggest group based on series name (already exists but could be more aggressive)
4. **All screens** should support filtering by Series Group — dashboard, run view, bulk edit

### Approach: Reference Table (Already Correct)

A reference table is superior to a plain text field because:
- Prevents typos and inconsistency ("Spiderman" vs "Spider-Man" vs "Spider-man")
- Enables metadata on groups (publisher, character, display order)
- Allows future features like group-level statistics and completeness tracking
- Supports relational queries (JOIN) for efficient filtering

The current design is already correct. The improvement is in enforcement and UI prominence.

---

## Part 3: Reading Order Engine — Design

### Database Schema

```sql
-- Reading order groups (e.g., "Spider-Man Complete Reading Order")
CREATE TABLE IF NOT EXISTS reading_order_groups (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  series_group_id INTEGER REFERENCES series_groups(id),
  description   TEXT,
  created_by    UUID REFERENCES users(id),
  is_default    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Individual entries in a reading order
CREATE TABLE IF NOT EXISTS reading_order_entries (
  id                SERIAL PRIMARY KEY,
  reading_order_id  INTEGER REFERENCES reading_order_groups(id) ON DELETE CASCADE,
  entry_id          INTEGER REFERENCES comic_entries(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  notes             TEXT,
  is_optional       BOOLEAN DEFAULT false,
  UNIQUE(reading_order_id, entry_id),
  UNIQUE(reading_order_id, position)
);

CREATE INDEX IF NOT EXISTS idx_ro_entries_order ON reading_order_entries(reading_order_id, position);
CREATE INDEX IF NOT EXISTS idx_ro_entries_entry ON reading_order_entries(entry_id);
CREATE INDEX IF NOT EXISTS idx_ro_groups_sg     ON reading_order_groups(series_group_id);
```

### Position Calculation Algorithm

When auto-generating a reading order for a Series Group:

```
1. Collect all entries in the group
2. Filter out reprints (unless toggled on)
3. Sort by:
   a. sort_order (if manually set) — highest priority
   b. year_start ASC
   c. year_end ASC (earlier-ending books first within same start year)
   d. issue_start ASC (lower issue numbers first within same year range)
   e. date ASC (publication date as final tiebreaker)
4. Assign positions: 100, 200, 300... (gaps allow manual insertion)
```

### Handling Overlapping Time Periods

Comic series frequently overlap in time (e.g., Amazing Spider-Man and Spectacular Spider-Man both run 1976-1998). The algorithm handles this:

1. **Same year_start, same series** → sort by issue_start
2. **Same year_start, different series** → interleave by alternating series or use publication date
3. **Overlapping ranges** → treat each entry as a discrete unit; sort by the midpoint of its year range as a secondary signal
4. **Crossover events** → use `notes` field on `reading_order_entries` to explain reading order context

### Manual Override with Drag-and-Drop

**Design:**
- Each reading order entry has an integer `position` column
- Auto-generated positions use gaps (100, 200, 300...) to allow insertion
- Drag-and-drop reorders by recalculating positions
- On drop: renumber affected entries with new positions
- Renumbering uses the midpoint strategy: if dropping between position 200 and 300, assign position 250
- If no gap exists (e.g., 200 and 201), renumber the entire sequence with fresh gaps

**UI for Reading Order Editor:**

```
+----------------------------------------------------------+
| Reading Order: Spider-Man                         [Auto-Generate] |
+----------------------------------------------------------+
| ☰  1. Amazing Spider-Man Epic Vol 1  (1962-1964)    [✕]  |
| ☰  2. Amazing Spider-Man Epic Vol 2  (1964-1966)    [✕]  |
| ☰  3. Amazing Spider-Man Epic Vol 3  (1966-1968)    [✕]  |
|    — drag handle (☰) to reorder —                         |
| ☰  4. Spectacular Spider-Man Epic 1  (1976-1978)    [✕]  |
| ☰  5. Amazing Spider-Man Epic Vol 9  (1976-1978)    [✕]  |
+----------------------------------------------------------+
| [+ Add Entry]                                             |
+----------------------------------------------------------+
```

- `☰` = drag handle
- `[✕]` = remove from reading order
- `[Auto-Generate]` = regenerate positions from algorithm
- `[+ Add Entry]` = search and add entries from the database

---

## Part 4: Reprint Filtering — Design

### Current State

- `comic_entries.reprint` is TEXT ('Yes'/'No')
- Run View already has a "Hide Reprints" toggle (`RV.hideReprints`)
- The main dashboard filter bar has a reprint filter option

### Recommended Implementation

1. **Default behavior:** All list views exclude entries where `reprint = 'Yes'`
2. **Toggle:** Add a persistent "Show Reprints" toggle to the filter bar (visible on all screens)
3. **Visual indicator:** When reprints are hidden, show a small badge: "Reprints hidden (N)"
4. **localStorage persistence:** Remember the user's preference

**Implementation approach:**

```javascript
// Add to applyFilters()
if (!showReprints) {
  filtered = filtered.filter(d => d.reprint !== 'Yes');
}
```

**Affected views:**
- Main dashboard table
- Search results
- Run View (already implemented)
- Multi-Series View (already implemented)
- Era Explorer (new)
- Charts and statistics

**Edge case:** When a user explicitly filters to `reprint = Yes`, the global toggle should be overridden (they explicitly want reprints).

---

## Part 5: Era Explorer — Design

### Recommended Design: Decade Clusters with Sliding Window

After evaluating the options:

| Design | Pros | Cons |
|--------|------|------|
| Timeline view | Visual, intuitive | Complex to build, hard on mobile |
| Year clusters | Precise | Too granular, many empty years |
| **Decade clusters** | **Clean grouping, manageable** | **Some decades too broad** |
| Sliding year window | Flexible | UI complexity, unclear mental model |

**Recommendation: Hybrid — Decade clusters as primary navigation, with a year-range refinement slider.**

### UI Design

```
+----------------------------------------------------------+
| Era Explorer                                              |
+----------------------------------------------------------+
| Decades                                                   |
| [1960s] [1970s] [1980s] [1990s] [2000s] [2010s] [2020s]  |
+----------------------------------------------------------+
| 1980s  (47 books)                    [1980 ●━━━━━● 1989]  |
+----------------------------------------------------------+
| Series Groups in this era:                                |
| Spider-Man (8) | X-Men (12) | Avengers (6) | ...         |
+----------------------------------------------------------+
| Books                                                     |
| ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          |
| │ [cover]     │ │ [cover]     │ │ [cover]     │          |
| │ ASM Epic 5  │ │ UXM Epic 3  │ │ Avengers E4 │          |
| │ 1982-1984   │ │ 1983-1985   │ │ 1984-1986   │          |
| │ ■ owned     │ │ □ unowned   │ │ ■ owned     │          |
| └─────────────┘ └─────────────┘ └─────────────┘          |
+----------------------------------------------------------+
```

### How It Works

1. **Decade tabs** filter `comic_entries` by `year_start` and `year_end` overlapping the decade
2. **Year-range slider** refines within the decade (e.g., 1983-1986)
3. **Books are grouped by Series Group** within each era
4. **Cards show cover, title, years, and ownership status**
5. **"Around the Same Time" link** on each card expands to show contemporaneous books

### Query Logic

```sql
-- Books that overlap with the selected era (1983-1986)
SELECT * FROM comic_entries
WHERE year_start <= 1986 AND year_end >= 1983
ORDER BY year_start, series_group, series, vol;
```

This catches books that start before and end during the era, span the entire era, or start during the era.

---

## Part 6: ISBN Lookup System — Audit

### Current Lookup Chain

1. **Local memory cache** (`ISBN_CACHE` object) — instant
2. **Supabase DB cache** (`isbn_cache` table) — fast
3. **Google Books API** — `googleapis.com/books/v1/volumes?q=isbn:{isbn}` — reliable for major publishers
4. **OpenLibrary API** — `openlibrary.org/api/books` + search fallback — good for backlist
5. **PRH (Penguin Random House)** — via `allorigins.win` CORS proxy — scrapes OG meta tags

### Identified Issues

1. **CORS proxy dependency** (`allorigins.win`) — unreliable third-party service, frequently down, potential security risk (MITM)
2. **Google Books API has no API key** — subject to aggressive rate limiting
3. **PRH lookup scrapes HTML** — fragile, breaks when PRH changes their markup
4. **No ISBNdb integration** — missing a major ISBN database
5. **No retry logic** — a single network timeout fails permanently
6. **No logging of failures** — `_cacheIsbnFailure` caches but doesn't log details (which source failed, why)
7. **OpenLibrary search endpoint** is a fallback within the same function — unclear failure modes
8. **Cover URL defaults to PRH** even when PRH doesn't have the book — results in broken images
9. **DC Finest ISBNs are hardcoded** in JavaScript — not maintainable

### Recommended Improvements

**1. Eliminate CORS proxy dependency:**
- Use a lightweight Supabase Edge Function as your own proxy
- Or use OpenLibrary (no CORS issues) and Google Books (CORS-friendly) as primary sources

**2. Add ISBNdb as a source:**
- ISBNdb has excellent comic book coverage
- Requires an API key ($10/month for 1000 lookups)
- Add as source #3 in the chain

**3. Enhanced fallback chain:**
```
1. Local memory cache
2. Supabase DB cache
3. Google Books API (with API key)
4. Open Library (books API + search API)
5. ISBNdb (if configured)
6. Supabase Edge Function proxy for PRH (replace allorigins)
```

**4. Failure logging:**

```sql
ALTER TABLE isbn_cache ADD COLUMN IF NOT EXISTS
  failure_sources TEXT;  -- JSON array: ["google_books", "open_library"]
ALTER TABLE isbn_cache ADD COLUMN IF NOT EXISTS
  last_retry_at TIMESTAMPTZ;
```

**5. Retry stale failures:**
- If a cached failure is older than 30 days, retry the lookup
- Track `last_retry_at` to prevent retry storms

**6. Cover URL validation:**
- After setting cover URL, verify the image loads (already partially done in `fetchIsbnFields`)
- If PRH cover fails, fall back to OpenLibrary or Google Books cover

---

## Part 7: Authentication System — Options

### Current State

The app uses Google OAuth via Supabase Auth. Legacy "stojr" and "Nick" profiles are hardcoded with placeholder UUIDs and can be claimed by authenticated users.

### Option Analysis

| Feature | Google Sign-In (Current) | Email + Password | Magic Link |
|---------|------------------------|-----------------|------------|
| **Setup complexity** | Already done | Low (Supabase built-in) | Low (Supabase built-in) |
| **Security level** | High (OAuth 2.0) | Medium (password management) | High (no passwords) |
| **Maintenance effort** | None (Supabase manages) | Low (reset flow needed) | None (Supabase manages) |
| **UX friction** | Low (one-click) | Medium (registration form) | Low (check email) |
| **Dependency** | Google account required | None | Email delivery service |
| **Offline capability** | Session persists | Session persists | Session persists |

### Recommendation: Keep Google Sign-In (Current)

For a small private application with 2-3 known users:

1. **Google Sign-In is already implemented** — zero additional work
2. **All users likely have Google accounts** — no friction
3. **Supabase handles token refresh, session management** — no maintenance
4. **No password reset flow needed** — reduces code surface

**Only change needed:** Remove the legacy stojr/Nick hardcoded profile buttons once both users have claimed their profiles via Google OAuth. This eliminates the confusing dual-auth UI.

If you want to support users without Google accounts in the future, add **Magic Link** as a secondary option — Supabase supports it with minimal configuration.

---

## Part 8: Run Discovery & Collection Insights

### 8.1 Run Completeness Indicators

**Design:** For each Series Group, calculate and display completion percentage.

```
Spider-Man Epics: ████████░░ 8/10 (80%)
X-Men Epics:     ██████░░░░ 6/10 (60%)
Avengers Epics:  ████░░░░░░ 4/10 (40%)
```

**Implementation:**
- Count total entries per series/group/type
- Count owned entries per user
- Display as progress bars on a "My Collection" dashboard panel

### 8.2 Missing Volume Detection

**Current:** Run View already detects gaps in volume numbers (e.g., Vol 1, Vol 2, Vol 4 → Vol 3 missing).

**Improvement:**
- Surface missing volumes on the dashboard as actionable cards
- "You're missing Spider-Man Epic Vol 7" with a link to add it or mark as wishlist
- Sort missing volumes by release date (upcoming vs. available)

### 8.3 Duplicate ISBN Detection

**Current:** `data_quality_flags` already tracks `duplicate_isbn`.

**Improvement:**
- Show duplicate ISBNs as a warning badge in the filter bar
- Click to see all duplicates
- Offer one-click resolution (merge entries, mark one as reprint)

### 8.4 Publisher Filtering

**Current:** Publisher tabs (All / Marvel / DC / Omnibus) exist.

**Improvement:**
- Make publisher a proper filter that combines with other filters (currently it resets them)
- Add publisher counts to the tab labels
- Support multi-select (e.g., Marvel + DC but not Omnibus)

### 8.5 Format Filtering

**Current:** Type filter exists in dropdown (Epic / Modern / Ultimate / DC Finest / Omnibus).

**Improvement:**
- Replace dropdown with toggle pills (like owner filter pills)
- Allow multi-select
- Show counts per format
- Format-specific colors and icons

### UI Placement

```
+----------------------------------------------------------+
| My Collection Dashboard                                   |
+----------------------------------------------------------+
| Quick Stats                                               |
| Total: 847 | Owned: 234 | Wishlist: 56 | Read: 189      |
+----------------------------------------------------------+
| Run Completeness                          [View All Runs] |
| Spider-Man    ████████░░ 80% (8/10)  [2 missing]         |
| X-Men         ██████░░░░ 60% (6/10)  [4 missing]         |
| Avengers      ████░░░░░░ 40% (4/10)  [6 missing]         |
+----------------------------------------------------------+
| Missing Volumes (Available Now)           [View All]      |
| • Spider-Man Epic Vol 7 — Released 2024-03-12             |
| • X-Men Epic Vol 11 — Released 2023-11-14                 |
+----------------------------------------------------------+
| Data Quality                                              |
| ⚠ 3 duplicate ISBNs | ⚠ 12 missing year data            |
+----------------------------------------------------------+
```

---

## Part 9: UI/UX Review & Wireframes

### 9.1 Critical Issues

1. **No persistent navigation** — users rely on buttons that look like filters
2. **Run View is disconnected** — full-screen overlay loses context
3. **Too much on one screen** — dashboard tries to be everything
4. **No visual browsing** — table-only view misses the visual nature of comics
5. **Filter state is confusing** — active filters banner helps but isn't always visible

### 9.2 Proposed Navigation Structure

```
+----------------------------------------------------------+
| BCE Comics                                                |
| [Dashboard] [Browse] [Runs] [Era Explorer] [Bulk Edit]    |
+----------------------------------------------------------+
```

Replace the current single-page-with-overlays approach with a **tab-based navigation** that keeps all views within the same page but with clear mode switching.

### 9.3 Wireframes

#### A. Collection Dashboard (Home)

```
+----------------------------------------------------------+
| BCE COMICS POD — EPIC Database                   [User ▾] |
+----------------------------------------------------------+
| [Dashboard] [Browse] [Runs] [Era Explorer] [Bulk Edit]    |
+----------------------------------------------------------+
| ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      |
| │  Total   │ │  Owned   │ │ Wishlist │ │   Read   │      |
| │   847    │ │   234    │ │    56    │ │   189    │      |
| └──────────┘ └──────────┘ └──────────┘ └──────────┘      |
+----------------------------------------------------------+
| Run Completeness                                          |
| Spider-Man    ████████░░ 80%     X-Men ██████░░░░ 60%     |
| Avengers      ████░░░░░░ 40%     Hulk  █████░░░░░ 50%    |
+----------------------------------------------------------+
| Recent Releases              | Coming Soon                |
| ┌───┐ ASM Epic 12  Mar 2026  | ┌───┐ UXM Epic 15 Jun 26 |
| │ C │ Years: 1990-1992       | │ C │ Years: 1995-1997    |
| └───┘ ■ Owned                | └───┘ □ Pre-order          |
+----------------------------------------------------------+
| Chart: Releases by Year                    [Bar|Line|Pie] |
| ▐▐▐▐ ▐▐▐▐▐▐ ▐▐▐▐▐▐▐▐▐ ▐▐▐▐▐▐▐            (existing)    |
+----------------------------------------------------------+
```

#### B. Browse View (Replaces Main Table)

```
+----------------------------------------------------------+
| [Dashboard] [Browse] [Runs] [Era Explorer] [Bulk Edit]    |
+----------------------------------------------------------+
| Filters                                                   |
| Publisher: [All|Marvel|DC|Omni]  Format: [Epic][Modern]...|
| Group: [All Groups ▾]  Search: [____________]  [Grid|Table]|
| Owner: (stojr)(Nick)  [Hide Reprints ✓]                  |
+----------------------------------------------------------+
| Grid View:                                                |
| ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         |
| │ [cover] │ │ [cover] │ │ [cover] │ │ [cover] │         |
| │ ASM     │ │ ASM     │ │ UXM     │ │ UXM     │         |
| │ Epic 1  │ │ Epic 2  │ │ Epic 1  │ │ Epic 2  │         |
| │ 62-64   │ │ 64-66   │ │ 63-66   │ │ 66-69   │         |
| │ ■ owned │ │ ■ owned │ │ □       │ │ □       │         |
| └─────────┘ └─────────┘ └─────────┘ └─────────┘         |
|                                                           |
| Table View: (same as current but with owned/unowned       |
|              row highlighting)                            |
+----------------------------------------------------------+
```

#### C. Run Explorer

```
+----------------------------------------------------------+
| [Dashboard] [Browse] [Runs] [Era Explorer] [Bulk Edit]    |
+----------------------------------------------------------+
| Run Explorer                                              |
| Group: [Spider-Man ▾]     Mode: [Single|Multi|Reading Order]|
| Format: [Epic ✓][Modern ✓][Omnibus][DC Finest]            |
| [Hide Reprints ✓]                                         |
+----------------------------------------------------------+
| Spider-Man  —  Complete Run                               |
|                                                           |
| Timeline                                                  |
| |1962  |1970  |1980  |1990  |2000  |2010  |2020|          |
| |▓▓▓▓▓▓|▓▓▓▓▓▓|▓▓▓▓▓▓|▓▓▓░░░|░░░░░░|░░░░░░|░░░|          |
|  ▓=covered  ░=missing                     12/18 = 67%     |
+----------------------------------------------------------+
| Cards (existing trading card aesthetic)                   |
| ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌ ─ ─ ─ ┐           |
| │ ASM     │ │ ASM     │ │ ASM     │ │ VOL 4 │           |
| │ Epic 1  │ │ Epic 2  │ │ Epic 3  │ │MISSING│           |
| │ ■ own   │ │ ■ own   │ │ □       │ │  ???  │           |
| └─────────┘ └─────────┘ └─────────┘ └ ─ ─ ─ ┘           |
+----------------------------------------------------------+
| Issue Coverage                                            |
| #1━━━━━#24  #25━━━━━#50  #51━━━━━#75  [GAP]  #101━━#125  |
+----------------------------------------------------------+
```

#### D. Era Explorer

```
+----------------------------------------------------------+
| [Dashboard] [Browse] [Runs] [Era Explorer] [Bulk Edit]    |
+----------------------------------------------------------+
| Era Explorer                                              |
| [1960s] [1970s] [1980s●] [1990s] [2000s] [2010s] [2020s] |
|                                                           |
| Year Range: [1983 ●━━━━━━━━━● 1986]      47 books        |
+----------------------------------------------------------+
| Series Groups Active in 1983-1986:                        |
| [Spider-Man 8] [X-Men 12] [Avengers 6] [Daredevil 4]    |
+----------------------------------------------------------+
| ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         |
| │ [cover] │ │ [cover] │ │ [cover] │ │ [cover] │         |
| │ ASM E5  │ │ UXM E3  │ │ AVG E4  │ │ DD E2   │         |
| │ 82-84   │ │ 83-85   │ │ 84-86   │ │ 83-85   │         |
| │ ■ owned │ │ □       │ │ ■ owned │ │ □       │         |
| └─────────┘ └─────────┘ └─────────┘ └─────────┘         |
+----------------------------------------------------------+
```

#### E. Book Detail Page (Expanded Row)

```
+----------------------------------------------------------+
| ← Back to Browse                                         |
+----------------------------------------------------------+
| ┌──────────┐  Amazing Spider-Man Epic Collection Vol 5   |
| │          │  Subtitle: The Big Wheel                     |
| │ [cover]  │  Years: 1982-1984  |  Issues: #224-252      |
| │          │  Publisher: Marvel  |  Type: Epic             |
| │          │  Pages: 504  |  ISBN: 978-1302950682         |
| │          │  Released: 2024-03-12                         |
| │          │  Writers: Roger Stern, Bill Mantlo            |
| └──────────┘  Artists: John Romita Jr.                    |
|                                                           |
| Ownership:                                                |
| stojr: ■ Owned  ■ Read  |  Nick: □ Unowned               |
| [Add to Wishlist]  [Mark as Read]                         |
+----------------------------------------------------------+
| Description                                               |
| Spider-Man faces the Hobgoblin for the first time...      |
+----------------------------------------------------------+
| In the Same Run:                                          |
| ← ASM Epic 4 (1980-82)  |  ASM Epic 6 (1984-86) →       |
+----------------------------------------------------------+
| Around the Same Time (1982-1984):                         |
| [UXM Epic 3] [Avengers Epic 4] [FF Epic 6]               |
+----------------------------------------------------------+
```

---

## Part 10: Performance & Scalability

### Current Performance Profile

The app loads **all data at startup** (`ALL_DATA` with limit 5000, `USER_DATA` with limit 50000). This is fine for hundreds of entries but will degrade with thousands.

### Indexing (Current vs. Recommended)

**Already indexed (good):**
- `series`, `series_group`, `year_start`, `year_end`, `date`, `type`, `pub`
- Compound: `(series_group, year_start, year_end)`
- User data: `user_id`, `entry_id`, partial index on `owned=true`

**Recommended additions:**
```sql
CREATE INDEX IF NOT EXISTS idx_entries_isbn ON comic_entries(isbn);
CREATE INDEX IF NOT EXISTS idx_entries_reprint ON comic_entries(reprint);
CREATE INDEX IF NOT EXISTS idx_entries_vol ON comic_entries(series, vol);
CREATE INDEX IF NOT EXISTS idx_entries_sort ON comic_entries(series_group, sort_order, year_start);
```

### Caching Strategy

1. **ISBN cache** — already implemented in DB, good
2. **Reading order cache** — store computed reading orders in `reading_order_entries` rather than recalculating
3. **Run completeness cache** — compute on data load, invalidate on ownership change
4. **Era data** — precompute decade counts on data load

### Scaling Recommendations

1. **Paginate API queries** — don't load all 5000+ entries at once; load by active filters
2. **Virtual scrolling** for large tables — render only visible rows
3. **Debounce all filter inputs** — currently only ISBN input is debounced
4. **Move chart computation to Web Worker** — prevent UI blocking on large datasets
5. **Lazy-load covers** — use `loading="lazy"` on all `<img>` tags (or Intersection Observer)
6. **Consider splitting the monolithic file** — even without a build system, you can use ES modules (`<script type="module">`) to split into logical files

---

## Part 11: Implementation Roadmap

### Phase 1: Foundation (Low Risk, High Impact)
1. **Add persistent navigation bar** — tab-based mode switching
2. **Default reprint filtering** — hide reprints by default with toggle
3. **Grid/card view** — alternative to table for visual browsing
4. **Run completeness indicators** — progress bars on dashboard
5. **Add ISBN index** to database

### Phase 2: Series Group Enhancement
6. **Elevate Series Group in UI** — prominent filter position on all screens
7. **Series Group landing cards** — visual navigation by character
8. **Auto-sync series_group text from series_group_id** via trigger
9. **Series Group management screen** — CRUD for groups

### Phase 3: Era Explorer
10. **Build Era Explorer view** — decade tabs + year slider + card grid
11. **Add era-related queries** — overlap-based year filtering
12. **Link from book details** to era context

### Phase 4: Reading Order Engine
13. **Create reading_order_groups and reading_order_entries tables**
14. **Auto-generate reading orders** from sort algorithm
15. **Reading order UI** with drag-and-drop reordering
16. **Reading order mode in Run View**

### Phase 5: ISBN & Data Quality
17. **Replace CORS proxy** with Supabase Edge Function
18. **Add Google Books API key**
19. **Add ISBNdb integration** (optional, requires subscription)
20. **Enhanced failure logging** in isbn_cache
21. **Retry stale failures** (>30 days old)

### Phase 6: Code Architecture
22. **Split into ES modules** — separate CSS, components, data layer
23. **Add error boundaries** — prevent single errors from crashing the app
24. **Sanitize all innerHTML usage** — prevent XSS
25. **Add debouncing** to search and filter inputs

### Phase 7: Polish
26. **Clean up legacy stojr/Nick code** once profiles are claimed
27. **Add missing volume cards** to Run View
28. **Collection insights dashboard panel**
29. **Mobile navigation improvements**

---

## Summary

The BCE Comics application is a well-crafted personal tool that has grown organically into a feature-rich system. Its biggest strengths are the visual design, the comprehensive data model, and the thoughtful features like ISBN auto-populate and data quality checks.

The main areas for improvement are:

1. **Navigation and discoverability** — users need clearer paths to features
2. **Series Group prominence** — the key concept for character runs needs to be front-and-center
3. **Reading order engine** — the missing piece for cross-series exploration
4. **Code architecture** — the single-file approach has reached its limit
5. **Reprint filtering** — simple change with high impact on usability

The recommended approach is to implement changes in phases, starting with low-risk UI improvements (navigation, reprint filtering, grid view) before moving to structural additions (reading order tables, era explorer).
