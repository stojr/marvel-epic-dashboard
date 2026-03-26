#!/usr/bin/env node
/**
 * BCE Comics Pod — Wikipedia Data Enrichment Agent
 *
 * Populates missing `isbn`, `years`, and `issues_covered` fields in comic_entries
 * by scraping Wikipedia tables for all Marvel/DC collected-edition pages.
 *
 * PREREQUISITES
 *   Node 18+ (built-in fetch / https)
 *
 * USAGE
 *   # Dry-run for Amazing Spider-Man only (default — no DB writes)
 *   node enrich.mjs
 *
 *   # Dry-run for a specific series
 *   node enrich.mjs --series "Avengers"
 *
 *   # Dry-run for all series across all sources
 *   node enrich.mjs --all
 *
 *   # Apply all updates (requires SB_SERVICE_KEY)
 *   node enrich.mjs --all --apply
 *
 *   # Apply a specific series only
 *   node enrich.mjs --series "Amazing Spider-Man" --apply
 *
 *   # Preview then rollback a previous run
 *   node enrich.mjs --rollback 2026-03-26T14:00:00Z
 *   node enrich.mjs --rollback 2026-03-26T14:00:00Z --apply   # + CONFIRM_ROLLBACK=yes
 *
 *   # Show progress report
 *   node enrich.mjs --progress
 *
 * ENVIRONMENT VARIABLES
 *   SB_ANON_KEY    — publishable/anon key (reads; defaults to the one in index.html)
 *   SB_SERVICE_KEY — service-role key from Supabase Dashboard → Settings → API
 *                    Required for --apply mode (bypasses RLS for UPDATE + INSERT)
 */

import https from 'https';
import { URL } from 'url';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SB_URL     = 'https://quxuidnmewcmovjbnfgy.supabase.co';
const SB_ANON    = process.env.SB_ANON_KEY    || 'sb_publishable_nXvg5ji8j6d_tUxLfp4N0A_KT3-vh-b';
const SB_SERVICE = process.env.SB_SERVICE_KEY || '';
const RUN_ID     = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// Wikipedia sources mapped to (pub, type) combos in the database
const WIKI_SOURCES = [
  { label: 'Marvel Epic',    url: 'https://en.wikipedia.org/wiki/Marvel_Epic_Collection',  pub: 'Marvel', type: 'Epic' },
  { label: 'Marvel Omnibus', url: 'https://en.wikipedia.org/wiki/Marvel_Omnibus',          pub: 'Marvel', type: 'Omnibus' },
  { label: 'DC Finest',      url: 'https://en.wikipedia.org/wiki/DC_Finest',               pub: 'DC',     type: 'DC Finest' },
  { label: 'DC Omnibus',     url: 'https://en.wikipedia.org/wiki/DC_Omnibus',              pub: 'DC',     type: 'Omnibus' },
  // Marvel Modern Era has no single Wikipedia page — skipped
];

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const isDry        = !args.includes('--apply');
const isAll        = args.includes('--all');
const showProgress = args.includes('--progress');
const rollbackId   = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i+1] : null; })();
const targetSeries = (() => { const i = args.indexOf('--series');   return i !== -1 ? args[i+1] : null; })();

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

function httpsGet(rawUrl, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects: ' + rawUrl));
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'BCE-Comics-Enrichment/1.0 (https://github.com/stojr/marvel-epic-dashboard)',
        'Accept':     'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
      },
    };
    const req = https.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        resolve(httpsGet(next, redirectCount + 1));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Timeout fetching ' + rawUrl)); });
    req.end();
  });
}

function sbRequest(method, path, body = null, useService = false) {
  const key = useService ? SB_SERVICE : SB_ANON;
  if (useService && !key) {
    throw new Error(
      'SB_SERVICE_KEY is required for write operations.\n' +
      'Find it at: Supabase Dashboard → Settings → API → service_role (secret)\n' +
      'Then run: export SB_SERVICE_KEY="eyJ..."'
    );
  }
  return new Promise((resolve, reject) => {
    const parsed  = new URL(SB_URL + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
    };
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      headers['Prefer'] = 'return=minimal';
    }
    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method, headers };
    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 204) { resolve([]); return; }
          const json = data ? JSON.parse(data) : [];
          if (res.statusCode >= 400) reject(new Error(`Supabase ${method} ${path} → ${res.statusCode}: ${data}`));
          else resolve(json);
        } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Paginate through all rows (Supabase default limit is 1000)
async function sbSelectAll(path) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const sep   = path.includes('?') ? '&' : '?';
    const chunk = await sbRequest('GET', `${path}${sep}limit=${limit}&offset=${offset}`);
    if (!chunk || chunk.length === 0) break;
    rows.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return rows;
}

// ─── HTML → TEXT HELPERS ──────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')   // remove footnotes
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&ndash;|&#8211;/g, '–').replace(/&mdash;|&#8212;/g, '—')
    .replace(/&#160;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/**
 * Full colspan + rowspan aware table parser.
 * Builds a 2-D grid respecting both span types, which is essential for
 * Wikipedia tables where a series name cell may span 20–30 rows.
 * Returns { headers: string[], rows: string[][] }
 */
function parseTable(tableHtml) {
  // rowspanGrid[colIndex] = { value, remaining }
  const rowspanGrid = {};
  const grid = [];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(tableHtml)) !== null) {
    const rowHtml = rowM[1];
    const outputRow = [];
    let srcCol = 0; // which <td>/<th> we're reading from the HTML
    let dstCol = 0; // which column in the output row we're writing to

    // Inject any carried-over rowspan cells first
    const injectAt = Object.keys(rowspanGrid).map(Number).sort((a, b) => a - b);

    // Parse cells from HTML
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cellM;
    const rawCells = [];
    while ((cellM = cellRe.exec(rowHtml)) !== null) {
      const attrs   = cellM[2];
      const content = stripHtml(cellM[3]);
      const colspanM = attrs.match(/colspan[=\s]*["']?(\d+)/i);
      const rowspanM = attrs.match(/rowspan[=\s]*["']?(\d+)/i);
      const colspan  = colspanM ? parseInt(colspanM[1], 10) : 1;
      const rowspan  = rowspanM ? parseInt(rowspanM[1], 10) : 1;
      rawCells.push({ content, colspan, rowspan });
    }

    // Merge rowspan carry-ins with fresh cells into outputRow
    let freshIdx = 0;
    dstCol = 0;
    // Find the max column we need
    const maxCol = Math.max(
      ...Object.keys(rowspanGrid).map(Number),
      rawCells.reduce((acc, c) => acc + c.colspan, 0) +
        Object.keys(rowspanGrid).length
    ) + 1;

    while (dstCol < maxCol || freshIdx < rawCells.length) {
      if (rowspanGrid[dstCol]) {
        // Insert carried rowspan value
        const rs = rowspanGrid[dstCol];
        outputRow[dstCol] = rs.value;
        rs.remaining--;
        if (rs.remaining <= 0) delete rowspanGrid[dstCol];
        dstCol++;
      } else if (freshIdx < rawCells.length) {
        const cell = rawCells[freshIdx++];
        for (let c = 0; c < cell.colspan; c++) {
          outputRow[dstCol] = cell.content;
          if (cell.rowspan > 1) {
            rowspanGrid[dstCol] = { value: cell.content, remaining: cell.rowspan - 1 };
          }
          dstCol++;
        }
      } else {
        break;
      }
    }

    // Fill any gaps left by rowspan carry-ins beyond fresh cells
    for (const col of Object.keys(rowspanGrid).map(Number)) {
      if (outputRow[col] === undefined) {
        const rs = rowspanGrid[col];
        outputRow[col] = rs.value;
        rs.remaining--;
        if (rs.remaining <= 0) delete rowspanGrid[col];
      }
    }

    if (outputRow.filter(Boolean).length > 0) grid.push(outputRow);
  }

  if (grid.length < 2) return null;
  return { headers: grid[0], rows: grid.slice(1) };
}

// ─── WIKIPEDIA SCRAPER ────────────────────────────────────────────────────────

/**
 * Depth-counting table extractor — correctly handles nested tables.
 * The naive non-greedy regex approach stops at the first </table> encountered
 * inside a cell (e.g. Wikipedia sort-key helper tables), truncating the main
 * data table. This function tracks open/close depth to return the full content
 * of every top-level table.
 */
function extractTopLevelTables(html) {
  const tables = [];
  const tagRe  = /<(\/?table)[\s>]/gi;
  let depth = 0, start = -1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (!m[1].startsWith('/')) {        // opening <table
      if (depth === 0) start = m.index;
      depth++;
    } else {                            // closing </table>
      depth--;
      if (depth === 0 && start !== -1) {
        const openEnd = html.indexOf('>', start) + 1;
        tables.push(html.slice(openEnd, m.index));
        start = -1;
      }
    }
  }
  return tables;
}

/**
 * Scrape a Wikipedia page and return a flat array of:
 *   { series, vol, subtitle, rawIssues, years, isbn, sourceUrl, sourceLabel }
 */
async function scrapeWikiPage(sourceLabel, url) {
  process.stdout.write(`  Fetching ${url} … `);
  const { status, body } = await httpsGet(url);
  process.stdout.write(`HTTP ${status}\n`);
  if (status !== 200) return [];

  const results = [];
  const tableContents = extractTopLevelTables(body);

  for (const tableContent of tableContents) {
    const parsed = parseTable(tableContent);
    if (!parsed) continue;

    const h = parsed.headers.map(s => s.toLowerCase());
    // Only process tables that have an ISBN or Issues column
    const colIsbn   = h.findIndex(c => c.includes('isbn'));
    const colIssues = h.findIndex(c => c.includes('issue') || c.includes('content') || c.includes('collected'));
    if (colIsbn === -1 && colIssues === -1) continue;

    const colSeries  = h.findIndex(c => c.includes('series'));
    const colVol     = h.findIndex(c => c === 'vol' || c === 'vol.' || c === 'volume' || c === '#' || c === 'no.' || c === 'no' || c.match(/^vol/));
    const colTitle   = h.findIndex(c => c.includes('subtitle') || c.includes('collection title') || c.includes('collected title') || (c.includes('title') && !c.includes('series')));
    const colYears   = h.findIndex(c => c.includes('year') || c.includes('published') || c.includes('original') || c.includes('date') || c.includes('era'));

    let currentSeries = '';

    for (const row of parsed.rows) {
      // Single-cell rows are often series section headers
      if (row.every(c => c === row[0]) || row.filter(Boolean).length <= 1) {
        currentSeries = row[0] || currentSeries;
        continue;
      }

      const get = col => (col !== -1 && row[col]) ? row[col] : '';

      const rawSeries  = get(colSeries) || currentSeries;
      const rawVol     = get(colVol);
      const rawTitle   = get(colTitle !== -1 ? colTitle : (colSeries !== -1 ? -1 : 0));
      const rawIssues  = get(colIssues);
      const rawYears   = get(colYears);
      const rawIsbn    = get(colIsbn);

      if (!rawSeries && !rawTitle) continue;
      if (!rawIsbn && !rawIssues && !rawYears) continue;

      results.push({
        series:      normaliseSeries(rawSeries),
        vol:         parseVol(rawVol),
        subtitle:    rawTitle,
        rawIssues,
        years:       normaliseYears(rawYears),
        isbn:        normaliseIsbn(rawIsbn),
        sourceUrl:   url,
        sourceLabel,
      });
    }
  }

  // Debug: print sample headers + first 3 rows of the largest table found
  if (results.length > 0 && process.env.DEBUG_SCRAPE) {
    console.log('  [debug] sample entries:');
    for (const e of results.slice(0, 3)) {
      console.log(`    series="${e.series}" vol=${e.vol} subtitle="${e.subtitle}" issues="${e.rawIssues?.slice(0,40)}" isbn="${e.isbn}"`);
    }
  }

  console.log(`  → ${results.length} entries parsed from ${sourceLabel}`);
  return results;
}

// ─── NORMALISATION HELPERS ────────────────────────────────────────────────────

function normaliseSeries(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/^The\s+/i, '').trim();
}

function parseVol(v) {
  const m = (v || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function normaliseYears(raw) {
  if (!raw) return '';
  const years = [...(raw || '').matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
  if (!years.length) return '';
  const mn = Math.min(...years), mx = Math.max(...years);
  // Format with regular hyphen (DB stores as text)
  return mn === mx ? String(mn) : `${mn}-${mx}`;
}

function normaliseIsbn(raw) {
  if (!raw) return '';
  const s = (raw || '');
  // Last ISBN-13 in string (most recent printing wins)
  const all13 = [...s.matchAll(/978[-\s]?\d[\d\s-]{8,}/g)];
  if (all13.length) {
    const digits = all13[all13.length - 1][0].replace(/[\s-]/g, '');
    if (digits.length >= 13) {
      const d = digits.slice(0, 13);
      return `978-${d.slice(3, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
    }
  }
  // ISBN-10 → ISBN-13
  const all10 = [...s.matchAll(/\b\d{9}[\dXx]\b/g)];
  if (all10.length) {
    const i10  = all10[all10.length - 1][0].toUpperCase();
    const stem = '978' + i10.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(stem[i], 10) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    const full  = stem + check;
    return `978-${full.slice(3, 5)}-${full.slice(5, 10)}-${full.slice(10, 12)}-${full.slice(12)}`;
  }
  return '';
}

function normaliseIssues(raw) {
  if (!raw) return '';
  let s = raw
    .replace(/[–—]/g, '-')    // en/em dash → hyphen
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[;,]+$/, '');
  return s;
}

function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── MATCHING ─────────────────────────────────────────────────────────────────

/**
 * Try to find a unique Wikipedia row for a given DB entry.
 * Priority: series+vol exact → series+subtitle exact → series+vol fuzzy
 */
function findMatch(dbEntry, wikiEntries) {
  const dbS = normText(dbEntry.series);
  const dbT = normText(dbEntry.subtitle || '');
  const dbV = dbEntry.vol;

  const sameS  = e => normText(e.series) === dbS;
  const fuzzyS = e => { const w = normText(e.series); return w.includes(dbS) || dbS.includes(w); };

  // 1. Exact series + vol
  let hits = wikiEntries.filter(e => sameS(e) && e.vol === dbV);
  if (hits.length === 1) return { match: hits[0], confidence: 'series+vol' };

  // 2. Exact series + subtitle
  if (dbT) {
    hits = wikiEntries.filter(e => sameS(e) && normText(e.subtitle) === dbT);
    if (hits.length === 1) return { match: hits[0], confidence: 'series+subtitle' };
  }

  // 3. Fuzzy series + exact vol
  if (dbV) {
    hits = wikiEntries.filter(e => fuzzyS(e) && e.vol === dbV);
    if (hits.length === 1) return { match: hits[0], confidence: 'fuzzy-series+vol' };
  }

  // 4. Fuzzy series + subtitle
  if (dbT) {
    hits = wikiEntries.filter(e => fuzzyS(e) && normText(e.subtitle) === dbT);
    if (hits.length === 1) return { match: hits[0], confidence: 'fuzzy+subtitle' };
  }

  return null;
}

// ─── PROPOSE / APPLY ─────────────────────────────────────────────────────────

function buildUpdates(dbEntry, wiki) {
  const updates = [];
  if (!dbEntry.isbn && wiki.isbn) {
    updates.push({ id: dbEntry.id, field: 'isbn', old: dbEntry.isbn ?? null, val: wiki.isbn, source: wiki.sourceUrl, label: wiki.sourceLabel });
  }
  if (!dbEntry.years && wiki.years) {
    updates.push({ id: dbEntry.id, field: 'years', old: dbEntry.years ?? null, val: wiki.years, source: wiki.sourceUrl, label: wiki.sourceLabel });
  }
  const ni = normaliseIssues(wiki.rawIssues);
  if (!dbEntry.issues_covered && ni) {
    updates.push({ id: dbEntry.id, field: 'issues_covered', old: dbEntry.issues_covered ?? null, val: ni, source: wiki.sourceUrl, label: wiki.sourceLabel });
  }
  return updates;
}

async function applyUpdates(updates) {
  for (const u of updates) {
    await sbRequest('PATCH', `/rest/v1/comic_entries?id=eq.${u.id}`, { [u.field]: u.val }, true);
    await sbRequest('POST', '/rest/v1/enrichment_log', {
      entry_id: u.id, field: u.field, old_value: u.old, new_value: u.val,
      source_url: u.source, source_label: u.label, run_id: RUN_ID, status: 'applied',
    }, true);
  }
}

async function logNoMatch(dbEntry, sourceUrl, sourceLabel) {
  if (!SB_SERVICE) return;
  // Only log once per entry (using isbn field as sentinel)
  await sbRequest('POST', '/rest/v1/enrichment_log', {
    entry_id: dbEntry.id, field: 'isbn', old_value: null, new_value: 'N/A',
    source_url: sourceUrl, source_label: sourceLabel, run_id: RUN_ID,
    status: 'no_match', note: `No match: ${dbEntry.series} vol ${dbEntry.vol ?? '?'} "${dbEntry.subtitle ?? ''}"`,
  }, true);
}

// ─── ROLLBACK ─────────────────────────────────────────────────────────────────

async function rollback(runId) {
  console.log(`\n=== ROLLBACK PREVIEW  run_id: ${runId} ===\n`);
  const rows = await sbSelectAll(
    `/rest/v1/enrichment_log?run_id=eq.${encodeURIComponent(runId)}&status=eq.applied&select=entry_id,field,old_value,new_value`
  );
  if (!rows.length) { console.log('Nothing to rollback for that run_id.'); return; }

  // Join with comic_entries for display
  const ids = [...new Set(rows.map(r => r.entry_id))];
  const entries = await sbSelectAll(
    `/rest/v1/comic_entries?id=in.(${ids.join(',')})&select=id,series,vol`
  );
  const entryMap = Object.fromEntries(entries.map(e => [e.id, e]));

  console.log('entry_id | series                    | vol | field           | was');
  console.log('---------|---------------------------|-----|-----------------|----');
  for (const r of rows) {
    const e = entryMap[r.entry_id] || {};
    console.log(
      `${String(r.entry_id).padEnd(8)} | ${(e.series||'?').padEnd(25)} | ${String(e.vol||'').padEnd(3)} | ${r.field.padEnd(15)} | ${r.old_value ?? 'NULL'}`
    );
  }
  console.log(`\nTotal: ${rows.length} field updates would be reverted.`);

  if (!args.includes('--apply') || process.env.CONFIRM_ROLLBACK !== 'yes') {
    console.log('\nTo execute: set CONFIRM_ROLLBACK=yes and add --apply');
    return;
  }

  console.log('\nExecuting rollback…');
  for (const field of ['isbn', 'years', 'issues_covered']) {
    for (const r of rows.filter(x => x.field === field)) {
      await sbRequest('PATCH', `/rest/v1/comic_entries?id=eq.${r.entry_id}`, { [field]: r.old_value }, true);
    }
  }
  await sbRequest('DELETE', `/rest/v1/enrichment_log?run_id=eq.${encodeURIComponent(runId)}`, null, true);
  console.log('✓ Rollback complete.');
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────

async function printProgress() {
  console.log('\n=== ENRICHMENT PROGRESS ===\n');
  try {
    const summary = await sbSelectAll('/rest/v1/enrichment_run_summary?select=*');
    if (summary.length) {
      console.log('run_id                    | applied | skipped | no_match | conflict | total');
      console.log('--------------------------|---------|---------|----------|----------|------');
      for (const r of summary) {
        console.log(`${(r.run_id||'').padEnd(25)} | ${String(r.applied||0).padEnd(7)} | ${String(r.skipped||0).padEnd(7)} | ${String(r.no_match||0).padEnd(8)} | ${String(r.conflict||0).padEnd(8)} | ${r.total||0}`);
      }
    } else {
      console.log('No enrichment runs yet.');
    }
  } catch { console.log('(enrichment_run_summary view not available)'); }

  const all = await sbSelectAll('/rest/v1/comic_entries?select=pub,type,isbn,years,issues_covered');
  const stats = {};
  for (const r of all) {
    const k = `${r.pub}|${r.type}`;
    if (!stats[k]) stats[k] = { pub: r.pub, type: r.type, mi: 0, mc: 0, my: 0, t: 0 };
    stats[k].t++;
    if (!r.isbn)            stats[k].mi++;
    if (!r.issues_covered)  stats[k].mc++;
    if (!r.years)           stats[k].my++;
  }
  console.log('\npub    | type            | miss.isbn | miss.issues | miss.years | total');
  console.log('-------|-----------------|-----------|-------------|------------|------');
  for (const k of Object.values(stats).sort((a, b) => (a.pub+a.type).localeCompare(b.pub+b.type))) {
    console.log(`${(k.pub||'').padEnd(6)} | ${(k.type||'').padEnd(15)} | ${String(k.mi).padEnd(9)} | ${String(k.mc).padEnd(11)} | ${String(k.my).padEnd(10)} | ${k.t}`);
  }
}

// ─── MAIN ENRICHMENT LOOP ─────────────────────────────────────────────────────

async function run() {
  // Determine which Wikipedia sources to process
  let sources;
  if (targetSeries && !isAll) {
    // Single series: scan all sources that could contain it
    sources = WIKI_SOURCES;
  } else {
    sources = WIKI_SOURCES;
  }

  // Fetch all DB entries needing enrichment
  process.stdout.write('\nQuerying database… ');
  let dbEntries = await sbSelectAll(
    '/rest/v1/comic_entries?select=id,pub,type,series,vol,subtitle,isbn,years,issues_covered'
  );

  // Filter to only those missing at least one field
  dbEntries = dbEntries.filter(e => !e.isbn || !e.years || !e.issues_covered);

  // If targeting a specific series, filter further
  if (targetSeries) {
    dbEntries = dbEntries.filter(e => normText(e.series) === normText(targetSeries));
  }
  console.log(`${dbEntries.length} entries need enrichment.\n`);

  if (!dbEntries.length) {
    console.log('Nothing to do — all entries are fully populated!');
    return;
  }

  const grandTotal = { applied: 0, skipped: 0, noMatch: 0 };

  for (const src of sources) {
    // Only scrape sources relevant to the pub/type if possible
    const relevantDb = dbEntries.filter(e => {
      if (src.pub && e.pub !== src.pub) return false;
      // type matching is loose (Modern entries could be in Epic page, etc.)
      return true;
    });
    if (relevantDb.length === 0) {
      console.log(`\nSkipping ${src.label} — no matching DB entries need enrichment.`);
      continue;
    }

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`Source:  ${src.label}`);
    console.log(`Mode:    ${isDry ? 'DRY RUN (no writes)' : 'APPLY'}`);
    console.log('─'.repeat(64));

    let wikiEntries;
    try {
      wikiEntries = await scrapeWikiPage(src.label, src.url);
    } catch (err) {
      console.error(`  ✗ Failed to scrape ${src.url}: ${err.message}`);
      continue;
    }

    if (!wikiEntries.length) {
      console.warn(`  ⚠ No entries parsed — page structure may have changed.`);
      continue;
    }

    // Group by series for summary
    const seriesSummary = {};
    let srcApplied = 0, srcSkipped = 0, srcNoMatch = 0;

    for (const dbEntry of relevantDb) {
      const sKey = dbEntry.series;
      if (!seriesSummary[sKey]) seriesSummary[sKey] = { applied: 0, skipped: 0, noMatch: 0 };

      const result = findMatch(dbEntry, wikiEntries);

      if (!result) {
        srcNoMatch++;
        seriesSummary[sKey].noMatch++;
        if (!isDry && SB_SERVICE) await logNoMatch(dbEntry, src.url, src.label);
        continue;
      }

      const { match, confidence } = result;
      const proposed = buildUpdates(dbEntry, match);

      if (!proposed.length) {
        srcSkipped++;
        seriesSummary[sKey].skipped++;
        continue;
      }

      if (isDry) {
        console.log(`\n  [${confidence}] ${dbEntry.series} vol ${dbEntry.vol ?? '?'} "${dbEntry.subtitle ?? ''}"`);
        console.log(`    wiki: "${match.subtitle}" | issues: ${match.rawIssues || '—'} | years: ${match.years || '—'} | isbn: ${match.isbn || '—'}`);
        for (const u of proposed) {
          console.log(`    UPDATE id=${u.id}  ${u.field}:  null → "${u.val}"`);
        }
        srcApplied += proposed.length;
        seriesSummary[sKey].applied += proposed.length;
      } else {
        await applyUpdates(proposed);
        srcApplied += proposed.length;
        seriesSummary[sKey].applied += proposed.length;
      }
    }

    // Per-source series summary
    console.log(`\n  ── ${src.label} Summary ──`);
    for (const [s, c] of Object.entries(seriesSummary).sort()) {
      const parts = [];
      if (c.applied)  parts.push(`${c.applied} ${isDry ? 'would update' : 'applied'}`);
      if (c.skipped)  parts.push(`${c.skipped} skipped`);
      if (c.noMatch)  parts.push(`${c.noMatch} no_match`);
      if (parts.length) console.log(`  ${s}: ${parts.join(', ')}`);
    }
    console.log(`  Total field updates: ${srcApplied} ${isDry ? '(dry)' : 'applied'} | no_match: ${srcNoMatch}`);

    grandTotal.applied  += srcApplied;
    grandTotal.skipped  += srcSkipped;
    grandTotal.noMatch  += srcNoMatch;
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  const verb = isDry ? 'would update' : 'applied';
  console.log(`║  GRAND TOTAL: ${String(grandTotal.applied).padEnd(4)} fields ${verb.padEnd(12)} | ${String(grandTotal.noMatch).padEnd(4)} no_match   ║`);
  if (isDry) console.log('║  (No database changes made — re-run with --apply to commit)  ║');
  else       console.log(`║  Run ID: ${RUN_ID.padEnd(51)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (!isDry) {
    console.log(`\nRun ID: ${RUN_ID}`);
    console.log('Save this ID to use --rollback if needed.\n');
  }
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      BCE Comics Pod — Wikipedia Enrichment Agent v2          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Run ID:  ${RUN_ID}`);
  console.log(`Mode:    ${isDry ? 'DRY RUN (no writes)' : 'APPLY'}`);
  if (targetSeries) console.log(`Filter:  series = "${targetSeries}"`);
  console.log('');

  if (!isDry && !SB_SERVICE) {
    console.error('✗ --apply requires SB_SERVICE_KEY env var.');
    console.error('  Supabase Dashboard → Settings → API → service_role (secret)');
    console.error('  export SB_SERVICE_KEY="eyJ..."');
    process.exit(1);
  }

  if (rollbackId)    { await rollback(rollbackId); return; }
  if (showProgress)  { await printProgress();       return; }

  await run();
}

main().catch(err => {
  console.error('\n✗ Fatal:', err.message);
  process.exit(1);
});
