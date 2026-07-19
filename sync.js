// Pulls fresh trade rows from the Notion DASHBOARD data source and rewrites the
// TRADES snapshot embedded in index.html. Run by .github/workflows/sync.yml on a schedule.
const fs = require("fs");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN env var (set it as a repo secret).");
  process.exit(1);
}

// This is the data source (collection) ID for the DASHBOARD database — not a secret, just an identifier.
const DATA_SOURCE_ID = "2c1f7bb7-7d6d-81e3-b25f-000b608c1561";
// The PHASE 1 JOURNAL database has per-trade entry/exit timestamps (the DASHBOARD
// database only has a plain Date, no time). We join the two via its "FP 10K
// DASHBOARD" relation to get { durationMin, pnl } pairs for the duration scatter chart.
const JOURNAL_DATA_SOURCE_ID = "2c1f7bb7-7d6d-812c-b034-000bef8295e6";
const HTML_PATH = "index.html";

const HEADERS_BASE = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Content-Type": "application/json",
};

// Notion rolled out a "data sources" API in 2025 for multi-source databases. We try the modern
// data-source query endpoint first, and fall back to the classic database-query endpoint (which
// still works for single-source databases) if that 404s.
async function queryAllPages() {
  const attempts = [
    {
      url: `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,
      notionVersion: "2025-09-03",
    },
    {
      url: `https://api.notion.com/v1/databases/${DATA_SOURCE_ID}/query`,
      notionVersion: "2022-06-28",
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const rows = await paginateQuery(attempt.url, attempt.notionVersion);
      console.log(`Fetched ${rows.length} rows via ${attempt.url}`);
      return rows;
    } catch (err) {
      console.warn(`Attempt against ${attempt.url} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error("All Notion query attempts failed");
}

async function paginateQuery(url, notionVersion) {
  const headers = { ...HEADERS_BASE, "Notion-Version": notionVersion };
  let results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: "Date", date: { is_not_empty: true } },
          { property: "REALIZED PNL", number: { is_not_empty: true } },
        ],
      },
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

function extractTrades(pages) {
  const trades = [];
  for (const page of pages) {
    const props = page.properties || {};
    const dateVal = props["Date"]?.date?.start;
    const pnlVal = props["REALIZED PNL"]?.number;
    if (!dateVal || pnlVal === null || pnlVal === undefined) continue;
    trades.push({ date: dateVal.slice(0, 10), pnl: Math.round(pnlVal * 100) / 100 });
  }
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return trades;
}

// Maps DASHBOARD page id -> realized PnL, so journal entries can be joined to a
// real dollar amount via their "FP 10K DASHBOARD" relation.
function buildDashboardPnlMap(pages) {
  const map = {};
  for (const page of pages) {
    const pnlVal = page.properties?.["REALIZED PNL"]?.number;
    if (pnlVal !== null && pnlVal !== undefined) {
      map[page.id] = Math.round(pnlVal * 100) / 100;
    }
  }
  return map;
}

async function queryJournalPages() {
  const attempts = [
    { url: `https://api.notion.com/v1/data_sources/${JOURNAL_DATA_SOURCE_ID}/query`, notionVersion: "2025-09-03" },
    { url: `https://api.notion.com/v1/databases/${JOURNAL_DATA_SOURCE_ID}/query`, notionVersion: "2022-06-28" },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const rows = await paginateJournalQuery(attempt.url, attempt.notionVersion);
      console.log(`Fetched ${rows.length} journal rows via ${attempt.url}`);
      return rows;
    } catch (err) {
      console.warn(`Journal attempt against ${attempt.url} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error("All Notion journal query attempts failed");
}

async function paginateJournalQuery(url, notionVersion) {
  const headers = { ...HEADERS_BASE, "Notion-Version": notionVersion };
  let results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: { property: "ENTRY TIME ", date: { is_not_empty: true } },
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Needs an entry time that's a datetime *range* (start = entry, end = exit) to
// compute a real duration, and a "FP 10K DASHBOARD" relation that resolves to a
// page with a known PnL. Entries missing either are silently skipped rather
// than guessed at.
function extractDurationTrades(journalPages, pnlMap) {
  const rows = [];
  for (const page of journalPages) {
    const props = page.properties || {};
    const entryDate = props["ENTRY TIME "]?.date;
    if (!entryDate?.start || !entryDate?.end) continue;
    const start = new Date(entryDate.start);
    const end = new Date(entryDate.end);
    const durationMin = Math.round(((end - start) / 60000) * 100) / 100;
    if (!isFinite(durationMin) || durationMin <= 0) continue;
    const relIds = (props["FP 10K DASHBOARD"]?.relation || []).map((r) => r.id);
    const matchId = relIds.find((id) => pnlMap[id] !== undefined);
    if (matchId === undefined) continue;
    rows.push({ durationMin, pnl: pnlMap[matchId] });
  }
  rows.sort((a, b) => a.durationMin - b.durationMin);
  return rows;
}

// If the journal side fails (e.g. the Notion integration hasn't been shared
// with the PHASE 1 JOURNAL database), fall back to whatever DURATION_TRADES
// is already embedded in the file rather than losing that chart's data.
function extractExistingDurationTrades(html) {
  const m = html.match(/const DURATION_TRADES = (\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return [];
  }
}

function updateHtml(trades, durationTrades) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const syncedAt = new Date().toISOString(); // full timestamp, not just a date — needed to detect staleness

  const tradesLiteral = JSON.stringify(trades);
  const durationLiteral = JSON.stringify(durationTrades);
  const newBlock =
`// SYNC_MARKER_START
// Auto-updated by .github/workflows/sync.yml — do not hand-edit between the markers.
const DATA_SYNCED_AT = "${syncedAt}";
const TRADES = ${tradesLiteral};
const DURATION_TRADES = ${durationLiteral};
// SYNC_MARKER_END`;

  const re = /\/\/ SYNC_MARKER_START[\s\S]*?\/\/ SYNC_MARKER_END/;
  if (!re.test(html)) {
    throw new Error("Could not find SYNC_MARKER_START / SYNC_MARKER_END block in index.html");
  }
  const updated = html.replace(re, newBlock);
  fs.writeFileSync(HTML_PATH, updated, "utf8");
  console.log(`Wrote ${trades.length} trades and ${durationTrades.length} duration points into ${HTML_PATH} (synced at ${syncedAt}).`);
}

(async () => {
  try {
    const pages = await queryAllPages();
    const trades = extractTrades(pages);
    const pnlMap = buildDashboardPnlMap(pages);

    // Kept separate from the block above on purpose: if the integration hasn't
    // been shared with PHASE 1 JOURNAL (or that query fails for any reason),
    // we still want the core trades/calendar sync below to succeed and commit.
    let durationTrades;
    try {
      const journalPages = await queryJournalPages();
      durationTrades = extractDurationTrades(journalPages, pnlMap);
    } catch (journalErr) {
      console.warn("Journal duration sync failed — keeping previous DURATION_TRADES and continuing:", journalErr.message);
      durationTrades = extractExistingDurationTrades(fs.readFileSync(HTML_PATH, "utf8"));
    }

    updateHtml(trades, durationTrades);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
})();
