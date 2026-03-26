#!/usr/bin/env node
/**
 * BCE Comics Pod — Wikipedia Data Enrichment Agent
 *
 * Populates missing `isbn`, `years`, and `issues_covered` fields in comic_entries
 * by scraping Wikipedia tables.
 *
 * PREREQUISITES
 *   Node 18+ (built-in fetch)
 *
 * USAGE
 *   # Dry-run for Amazing Spider-Man only (default — no DB writes)
 *   node enrich.mjs
 *
 *   # Apply updates for a specific series
 *   node enrich.mjs --series "Amazing Spider-Man" --apply
 *
 *   # Apply updates for all series in order
 *   node enrich.mjs --all --apply
 *
 *   # Rollback a previous run
 *   node enrich.mjs --rollback 2026-03-26T14:00:00
 *
 * ENVIRONMENT VARIABLES
 *   SB_ANON_KEY    — publishable/anon key (for reads, set to index.html's SB_KEY)
 *   SB_SERVICE_KEY — service-role key (required for writes; find in Supabase dashboard)
 *
 * The anon key supports public SELECTs per RLS.
 * The service-role key bypasses RLS and is needed for DDL and UPDATE operations.
 */

import https from 'https';
import { URL } from 'url';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SB_URL     = 'https://quxuidnmewcmovjbnfgy.supabase.co';
const SB_ANON    = process.env.SB_ANON_KEY    || 'sb_publishable_nXvg5ji8j6d_tUxLfp4N0A_KT3-vh-b';
const SB_SERVICE = process.env.SB_SERVICE_KEY || '';

const RUN_ID = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// Wikipedia sources in priority order
const WIKI_SOURCES = {
  'Marvel Epic':    'https://en.wikipedia.org/wiki/Marvel_Epic_Collection',
  'Marvel Modern':  'https://en.wikipedia.org/wiki/List_of_Marvel_collected_editions',
  'Marvel Omnibus': 'https://en.wikipedia.org/wiki/Marvel_Omnibus',
  'DC Finest':      'https://en.wikipedia.org/wiki/DC_Finest',
  'DC Omnibus':     'https://en.wikipedia.org/wiki/DC_Omnibus',
};

// Execution order from the prompt
const SERIES_ORDER = [
  'Amazing Spider-Man',
  'Avengers',
  'X-Men',
  // remaining Marvel Epic series handled alphabetically after the above
];

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const isDry  = !args.includes('--apply');
const isAll  = args.includes('--all');
const rollbackId = (() => {
  const i = args.indexOf('--rollback');
  return i !== -1 ? args[i + 1] : null;
})();
const targetSeries = (() => {
  const i = args.indexOf('--series');
  return i !== -1 ? args[i + 1] : null;
})();

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'BCE-Comics-Enrichment/1.0 (https://github.com/stojr/marvel-epic-dashboard)',
        'Accept':     'text/html,application/xhtml+xml',
      },
    };
    const req = https.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sbRequest(method, path, body, useServiceKey = false) {
  const key = useServiceKey ? SB_SERVICE : SB_ANON;
  if (useServiceKey && !SB_SERVICE) {
    throw new Error('SB_SERVICE_KEY environment variable is required for write operations. ' +
      'Find it in Supabase Dashboard → Settings → API → service_role key.');
  }
  return new Promise((resolve, reject) => {
    const parsed  = new URL(SB_URL + path);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        key,
        'Authorization': 'Bearer ' + key,
        'Prefer':        'return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          if (res.statusCode >= 400) {
            reject(new Error(`Supabase ${method} ${path} → ${res.statusCode}: ${data}`));
          } else {
            resolve(json);
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── PHASE 0: SETUP ──────────────────────────────────────────────────────────

async function setupEnrichmentLog() {
  console.log('\n=== PHASE 0: Setting up enrichment_log table ===\n');

  const sql = `
CREATE TABLE IF NOT EXISTS enrichment_log (
  id            bigserial PRIMARY KEY,
  entry_id      bigint NOT NULL REFERENCES comic_entries(id) ON DELETE CASCADE,
  field         text NOT NULL CHECK (field IN ('isbn', 'years', 'issues_covered')),
  old_value     text,
  new_value     text NOT NULL,
  source_url    text,
  source_label  text,
  run_id        text,
  status        text NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'skipped', 'no_match', 'conflict')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrichment_log_entry_id_idx ON enrichment_log(entry_id);
CREATE INDEX IF NOT EXISTS enrichment_log_run_id_idx   ON enrichment_log(run_id);
CREATE INDEX IF NOT EXISTS enrichment_log_status_idx   ON enrichment_log(status);

CREATE OR REPLACE VIEW enrichment_run_summary AS
SELECT
  run_id,
  MIN(created_at)                                      AS started_at,
  MAX(created_at)                                      AS finished_at,
  COUNT(*) FILTER (WHERE status = 'applied')           AS applied,
  COUNT(*) FILTER (WHERE status = 'skipped')           AS skipped,
  COUNT(*) FILTER (WHERE status = 'no_match')          AS no_match,
  COUNT(*) FILTER (WHERE status = 'conflict')          AS conflict,
  COUNT(*)                                             AS total
FROM enrichment_log
GROUP BY run_id
ORDER BY started_at DESC;
  `.trim();

  await sbRequest('POST', '/rest/v1/rpc/exec_sql', { query: sql }, true);
  console.log('✓ enrichment_log table and enrichment_run_summary view ready.');
  console.log(`✓ Run ID for this session: ${RUN_ID}\n`);
}

// ─── PHASE 1: QUERY DB ────────────────────────────────────────────────────────

async function queryMissingEntries(seriesFilter) {
  let url = '/rest/v1/comic_entries?select=id,pub,type,series,vol,subtitle,isbn,years,issues_covered' +
    '&or=(isbn.is.null,isbn.eq.,issues_covered.is.null,issues_covered.eq.,years.is.null,years.eq.)' +
    '&order=pub.asc,series.asc,vol.asc';
  if (seriesFilter) {
    url += `&series=eq.${encodeURIComponent(seriesFilter)}`;
  }
  const rows = await sbRequest('GET', url);
  return rows || [];
}

async function queryAllEntries(seriesFilter) {
  let url = '/rest/v1/comic_entries?select=id,pub,type,series,vol,subtitle,isbn,years,issues_covered' +
    '&order=series.asc,vol.asc';
  if (seriesFilter) {
    url += `&series=eq.${encodeURIComponent(seriesFilter)}`;
  }
  const rows = await sbRequest('GET', url);
  return rows || [];
}

// ─── PHASE 2: WIKIPEDIA SCRAPING ──────────────────────────────────────────────

/**
 * Minimal HTML table parser — extracts rows from <table> elements.
 * Returns: Array of objects { headers: string[], rows: string[][] }
 */
function parseTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        cells.push(stripHtml(cellMatch[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length > 1) {
      tables.push({ headers: rows[0], rows: rows.slice(1) });
    }
  }
  return tables;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scrapes and returns structured entries from a Wikipedia comics collection page.
 * Returns array of: { series, vol, subtitle, issues, years, isbn }
 */
async function scrapeWikiPage(url) {
  console.log(`  Fetching: ${url}`);
  const { status, body } = await httpsGet(url);
  if (status !== 200) {
    console.warn(`  ⚠ HTTP ${status} for ${url}`);
    return [];
  }

  const tables = parseTables(body);
  const entries = [];

  for (const table of tables) {
    const headers = table.headers.map(h => h.toLowerCase());

    // Detect columns
    const colSeries   = headers.findIndex(h => h.includes('series'));
    const colVol      = headers.findIndex(h => h.includes('vol') || h === '#' || h === 'volume');
    const colTitle    = headers.findIndex(h => h.includes('title') || h.includes('subtitle') || h.includes('collection'));
    const colIssues   = headers.findIndex(h => h.includes('issue') || h.includes('content'));
    const colYears    = headers.findIndex(h => h.includes('year') || h.includes('publish') || h.includes('date'));
    const colIsbn     = headers.findIndex(h => h.includes('isbn'));

    if (colIsbn === -1 && colIssues === -1) continue; // skip non-comics tables

    let currentSeries = '';

    for (const row of table.rows) {
      // Detect series header rows (single cell spanning full width)
      if (row.length === 1 || (row.length < 3 && colSeries === -1)) {
        currentSeries = row[0].trim();
        continue;
      }

      const get = (col) => (col !== -1 && row[col]) ? row[col].trim() : '';

      const rawSeries  = get(colSeries) || currentSeries;
      const rawVol     = get(colVol);
      const rawTitle   = get(colTitle);
      const rawIssues  = get(colIssues);
      const rawYears   = get(colYears);
      const rawIsbn    = get(colIsbn);

      if (!rawSeries && !rawTitle) continue;

      entries.push({
        series:   normaliseSeries(rawSeries),
        vol:      parseVol(rawVol),
        subtitle: rawTitle,
        issues:   rawIssues,
        years:    normaliseYears(rawYears),
        isbn:     normaliseIsbn(rawIsbn),
      });
    }
  }

  return entries;
}

// ─── NORMALISATION HELPERS ────────────────────────────────────────────────────

function normaliseSeries(s) {
  return s.replace(/\s+/g, ' ').replace(/^The\s+/i, '').trim();
}

function parseVol(v) {
  const m = v.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function normaliseYears(raw) {
  if (!raw) return '';
  // Extract 4-digit years
  const years = [...raw.matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
  if (years.length === 0) return '';
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? String(min) : `${min}–${max}`;
}

function normaliseIsbn(raw) {
  if (!raw) return '';
  // Find last ISBN-13 (978-xxxxxxxxxx)
  const isbn13s = [...raw.matchAll(/978[-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?\d/g)];
  if (isbn13s.length > 0) {
    // Use the last one (most recent printing)
    const last = isbn13s[isbn13s.length - 1][0].replace(/[\s-]/g, '');
    return `978-${last.slice(3)}`;
  }
  // Try ISBN-10 → ISBN-13 conversion
  const isbn10s = [...raw.matchAll(/\b\d{9}[\dXx]\b/g)];
  if (isbn10s.length > 0) {
    const last = isbn10s[isbn10s.length - 1][0];
    return isbn10ToIsbn13(last);
  }
  return '';
}

function isbn10ToIsbn13(isbn10) {
  const digits = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  const full   = digits + check;
  return `978-${full.slice(3)}`;
}

function normaliseIssues(raw) {
  if (!raw) return '';
  // Strip series name prefixes like "Amazing Spider-Man #"
  let s = raw.replace(/[A-Za-z\s]+#/g, '');
  // Normalise en-dashes to hyphens
  s = s.replace(/[–—]/g, '-');
  // Remove leading #
  s = s.replace(/#/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Remove trailing punctuation
  s = s.replace(/[;,]+$/, '').trim();
  return s;
}

function normaliseText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── PHASE 3: MATCHING ────────────────────────────────────────────────────────

/**
 * Matches a db entry to Wikipedia entries.
 * Returns the best match or null.
 */
function findMatch(dbEntry, wikiEntries) {
  const dbSeriesNorm   = normaliseText(dbEntry.series);
  const dbSubtitleNorm = normaliseText(dbEntry.subtitle || '');
  const dbVol          = dbEntry.vol;

  // Try exact: series + vol
  const bySeriesVol = wikiEntries.filter(w => {
    return normaliseText(w.series) === dbSeriesNorm && w.vol === dbVol;
  });
  if (bySeriesVol.length === 1) return { match: bySeriesVol[0], confidence: 'series+vol' };

  // Try: series + subtitle
  if (dbSubtitleNorm) {
    const bySubtitle = wikiEntries.filter(w => {
      return normaliseText(w.series) === dbSeriesNorm &&
             normaliseText(w.subtitle) === dbSubtitleNorm;
    });
    if (bySubtitle.length === 1) return { match: bySubtitle[0], confidence: 'series+subtitle' };
  }

  // Try: series + vol (fuzzy — series contains dbSeries or vice versa)
  if (bySeriesVol.length === 0 && dbVol) {
    const fuzzy = wikiEntries.filter(w => {
      const wNorm = normaliseText(w.series);
      return (wNorm.includes(dbSeriesNorm) || dbSeriesNorm.includes(wNorm)) && w.vol === dbVol;
    });
    if (fuzzy.length === 1) return { match: fuzzy[0], confidence: 'fuzzy-series+vol' };
  }

  return null;
}

// ─── PHASE 4: PROPOSE / APPLY UPDATES ────────────────────────────────────────

function buildProposedUpdates(dbEntry, wikiEntry) {
  const updates = [];
  const sourceUrl = WIKI_SOURCES['Marvel Epic']; // TODO: pass actual URL

  if ((!dbEntry.isbn) && wikiEntry.isbn) {
    updates.push({
      id:         dbEntry.id,
      field:      'isbn',
      old_value:  dbEntry.isbn || null,
      new_value:  wikiEntry.isbn,
      source_url: sourceUrl,
    });
  }
  if ((!dbEntry.years) && wikiEntry.years) {
    updates.push({
      id:         dbEntry.id,
      field:      'years',
      old_value:  dbEntry.years || null,
      new_value:  wikiEntry.years,
      source_url: sourceUrl,
    });
  }
  const normIssues = normaliseIssues(wikiEntry.issues);
  if ((!dbEntry.issues_covered) && normIssues) {
    updates.push({
      id:         dbEntry.id,
      field:      'issues_covered',
      old_value:  dbEntry.issues_covered || null,
      new_value:  normIssues,
      source_url: sourceUrl,
    });
  }
  return updates;
}

async function applyUpdate(update) {
  const patch = { [update.field]: update.new_value };
  await sbRequest(
    'PATCH',
    `/rest/v1/comic_entries?id=eq.${update.id}`,
    patch,
    true
  );

  await sbRequest('POST', '/rest/v1/enrichment_log', {
    entry_id:     update.id,
    field:        update.field,
    old_value:    update.old_value,
    new_value:    update.new_value,
    source_url:   update.source_url,
    source_label: 'Wikipedia',
    run_id:       RUN_ID,
    status:       'applied',
  }, true);
}

async function logNoMatch(dbEntry, sourceUrl) {
  if (!SB_SERVICE) return;
  await sbRequest('POST', '/rest/v1/enrichment_log', {
    entry_id:     dbEntry.id,
    field:        'isbn',
    old_value:    null,
    new_value:    'N/A',
    source_url:   sourceUrl,
    source_label: 'Wikipedia',
    run_id:       RUN_ID,
    status:       'no_match',
    note:         `No Wikipedia match for ${dbEntry.series} vol ${dbEntry.vol}`,
  }, true);
}

// ─── ROLLBACK ─────────────────────────────────────────────────────────────────

async function rollback(runId) {
  console.log(`\n=== ROLLBACK PREVIEW for run_id: ${runId} ===\n`);

  const preview = await sbRequest(
    'GET',
    `/rest/v1/enrichment_log?run_id=eq.${encodeURIComponent(runId)}&status=eq.applied&select=entry_id,field,old_value,new_value`,
  );

  if (!preview || preview.length === 0) {
    console.log('No applied entries found for this run_id.');
    return;
  }

  console.log('The following changes would be REVERTED:\n');
  console.log('entry_id | field           | old_value → new_value');
  console.log('---------|-----------------|----------------------------------------');
  for (const row of preview) {
    const old = row.old_value ?? 'NULL';
    console.log(`${String(row.entry_id).padEnd(8)} | ${row.field.padEnd(15)} | ${old} → ${row.new_value}`);
  }

  console.log(`\nTotal: ${preview.length} rows would be reverted.`);
  console.log('\nTo execute rollback, set --apply flag AND confirm by setting env var CONFIRM_ROLLBACK=yes');

  if (args.includes('--apply') && process.env.CONFIRM_ROLLBACK === 'yes') {
    console.log('\nExecuting rollback...');
    for (const field of ['isbn', 'years', 'issues_covered']) {
      const rows = preview.filter(r => r.field === field);
      for (const row of rows) {
        await sbRequest(
          'PATCH',
          `/rest/v1/comic_entries?id=eq.${row.entry_id}`,
          { [field]: row.old_value },
          true
        );
      }
    }
    // Delete log entries
    await sbRequest(
      'DELETE',
      `/rest/v1/enrichment_log?run_id=eq.${encodeURIComponent(runId)}`,
      null,
      true
    );
    console.log('✓ Rollback complete.');
  }
}

// ─── MONITOR PROGRESS ─────────────────────────────────────────────────────────

async function showProgress() {
  console.log('\n=== ENRICHMENT PROGRESS ===\n');

  const summary = await sbRequest('GET', '/rest/v1/enrichment_run_summary');
  if (summary && summary.length > 0) {
    console.log('Run summaries:');
    console.log('run_id                   | applied | skipped | no_match | conflict | total');
    console.log('-------------------------|---------|---------|----------|----------|------');
    for (const r of summary) {
      console.log(
        `${r.run_id.padEnd(24)} | ${String(r.applied).padEnd(7)} | ${String(r.skipped).padEnd(7)} | ` +
        `${String(r.no_match).padEnd(8)} | ${String(r.conflict).padEnd(8)} | ${r.total}`
      );
    }
  } else {
    console.log('No enrichment runs found yet.');
  }

  const gaps = await sbRequest(
    'GET',
    '/rest/v1/comic_entries?select=pub,type,isbn,years,issues_covered'
  );
  if (gaps) {
    const stats = {};
    for (const row of gaps) {
      const key = `${row.pub}|${row.type}`;
      if (!stats[key]) stats[key] = { pub: row.pub, type: row.type, missingIsbn: 0, missingIssues: 0, missingYears: 0, total: 0 };
      stats[key].total++;
      if (!row.isbn)            stats[key].missingIsbn++;
      if (!row.issues_covered)  stats[key].missingIssues++;
      if (!row.years)           stats[key].missingYears++;
    }
    console.log('\nGap report:');
    console.log('pub    | type            | miss.isbn | miss.issues | miss.years | total');
    console.log('-------|-----------------|-----------|-------------|------------|------');
    for (const k of Object.values(stats).sort((a, b) => a.pub.localeCompare(b.pub) || a.type.localeCompare(b.type))) {
      console.log(
        `${k.pub.padEnd(6)} | ${k.type.padEnd(15)} | ${String(k.missingIsbn).padEnd(9)} | ` +
        `${String(k.missingIssues).padEnd(11)} | ${String(k.missingYears).padEnd(10)} | ${k.total}`
      );
    }
  }
}

// ─── MAIN ENRICHMENT LOOP ─────────────────────────────────────────────────────

async function enrichSeries(seriesName, wikiUrl, dryRun) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Series: ${seriesName}`);
  console.log(`Source: ${wikiUrl}`);
  console.log(`Mode:   ${dryRun ? 'DRY RUN (no DB writes)' : 'APPLY'}`);
  console.log('─'.repeat(60));

  // Fetch Wikipedia data
  const wikiEntries = await scrapeWikiPage(wikiUrl);
  const seriesWiki  = wikiEntries.filter(w =>
    normaliseText(w.series).includes(normaliseText(seriesName)) ||
    normaliseText(seriesName).includes(normaliseText(w.series))
  );

  console.log(`  Wikipedia entries found for "${seriesName}": ${seriesWiki.length}`);

  if (seriesWiki.length === 0) {
    console.log('  ⚠ No Wikipedia entries found. Check page structure or series name spelling.');
    return { applied: 0, skipped: 0, noMatch: 0 };
  }

  // Fetch DB entries needing enrichment
  const dbEntries = await queryAllEntries(seriesName);
  const needing   = dbEntries.filter(e =>
    !e.isbn || !e.years || !e.issues_covered
  );
  console.log(`  DB entries needing enrichment: ${needing.length}`);

  let applied = 0, skipped = 0, noMatch = 0;
  const allProposed = [];

  for (const dbEntry of needing) {
    const result = findMatch(dbEntry, seriesWiki);

    if (!result) {
      noMatch++;
      if (!dryRun && SB_SERVICE) {
        await logNoMatch(dbEntry, wikiUrl);
      }
      if (dryRun) {
        console.log(`  NO MATCH: ${dbEntry.series} vol ${dbEntry.vol} "${dbEntry.subtitle || ''}"`);
      }
      continue;
    }

    const { match, confidence } = result;
    const proposed = buildProposedUpdates(dbEntry, match);

    if (proposed.length === 0) {
      skipped++;
      continue;
    }

    // Attach actual source URL
    for (const u of proposed) u.source_url = wikiUrl;

    allProposed.push(...proposed);

    if (dryRun) {
      console.log(`\n  MATCH [${confidence}]: ${dbEntry.series} vol ${dbEntry.vol} "${dbEntry.subtitle || ''}"`);
      console.log(`    Wikipedia: "${match.subtitle}" | issues: ${match.issues} | years: ${match.years} | isbn: ${match.isbn}`);
      for (const u of proposed) {
        console.log(`    UPDATE id=${u.id}: ${u.field}  NULL → "${u.new_value}"`);
      }
    } else {
      for (const u of proposed) {
        await applyUpdate(u);
        applied++;
      }
    }
  }

  if (dryRun) {
    console.log(`\n  ── DRY RUN SUMMARY ──`);
    console.log(`  Would apply ${allProposed.length} field update(s) across ${needing.length} entries.`);
    console.log(`  no_match: ${noMatch} | skipped (already filled): ${skipped}`);
    console.log(`\n  (No database changes were made. Re-run with --apply to commit.)`);
  } else {
    console.log(`\n  ${seriesName}: ${applied} applied, ${skipped} skipped, ${noMatch} no_match`);
  }

  return { applied, skipped, noMatch };
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       BCE Comics Pod — Wikipedia Enrichment Agent        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Run ID:  ${RUN_ID}`);
  console.log(`Mode:    ${isDry ? 'DRY RUN' : 'APPLY'}`);
  if (targetSeries) console.log(`Series:  ${targetSeries}`);
  if (!isDry && !SB_SERVICE) {
    console.error('\n✗ SB_SERVICE_KEY is required for --apply mode.');
    console.error('  Find it in: Supabase Dashboard → Settings → API → service_role key');
    console.error('  Then set: export SB_SERVICE_KEY="your-key-here"');
    process.exit(1);
  }

  // Rollback mode
  if (rollbackId) {
    await rollback(rollbackId);
    return;
  }

  // Setup (only needed once, skipped in dry-run)
  if (!isDry) {
    await setupEnrichmentLog();
  } else {
    console.log('\n(Skipping enrichment_log setup in dry-run mode)\n');
  }

  // Determine which series to process
  let seriesToProcess;
  if (targetSeries) {
    seriesToProcess = [{ name: targetSeries, url: WIKI_SOURCES['Marvel Epic'] }];
  } else if (isAll) {
    seriesToProcess = [
      { name: 'Amazing Spider-Man', url: WIKI_SOURCES['Marvel Epic'] },
      { name: 'Avengers',           url: WIKI_SOURCES['Marvel Epic'] },
      { name: 'X-Men',              url: WIKI_SOURCES['Marvel Epic'] },
      // TODO: expand with remaining Marvel Epic series alphabetically
      // Then Marvel Modern, Omnibus, DC Finest, DC Omnibus
    ];
  } else {
    // Default: Amazing Spider-Man dry run
    seriesToProcess = [{ name: 'Amazing Spider-Man', url: WIKI_SOURCES['Marvel Epic'] }];
  }

  let totalApplied = 0, totalSkipped = 0, totalNoMatch = 0;

  for (const { name, url } of seriesToProcess) {
    const { applied, skipped, noMatch } = await enrichSeries(name, url, isDry);
    totalApplied  += applied;
    totalSkipped  += skipped;
    totalNoMatch  += noMatch;
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  TOTAL: ${String(totalApplied).padEnd(4)} applied | ${String(totalSkipped).padEnd(4)} skipped | ${String(totalNoMatch).padEnd(4)} no_match        ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (!isDry) {
    await showProgress();
  }
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
