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

function updateHtml(trades) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  const tradesLiteral = JSON.stringify(trades);
  const newBlock =
`// SYNC_MARKER_START
// Auto-updated hourly by .github/workflows/sync.yml — do not hand-edit between the markers.
const DATA_AS_OF = "${today}";
const TRADES = ${tradesLiteral};
// SYNC_MARKER_END`;

  const re = /\/\/ SYNC_MARKER_START[\s\S]*?\/\/ SYNC_MARKER_END/;
  if (!re.test(html)) {
    throw new Error("Could not find SYNC_MARKER_START / SYNC_MARKER_END block in index.html");
  }
  const updated = html.replace(re, newBlock);
  fs.writeFileSync(HTML_PATH, updated, "utf8");
  console.log(`Wrote ${trades.length} trades into ${HTML_PATH} (as of ${today}).`);
}

(async () => {
  try {
    const pages = await queryAllPages();
    const trades = extractTrades(pages);
    updateHtml(trades);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
})();
