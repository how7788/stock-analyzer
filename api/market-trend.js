// api/market-trend.js — 全球大盤即時行情（Yahoo Finance）
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

const MARKETS = [
  { id: "^TWII",  name: "台灣加權",   abbr: "TWII"   },
  { id: "^IXIC",  name: "那斯達克",   abbr: "NASDAQ" },
  { id: "^GSPC",  name: "S&P 500",    abbr: "SPX"    },
  { id: "^SOX",   name: "費城半導體", abbr: "SOX"    },
  { id: "TSM",    name: "台積電 ADR", abbr: "TSM"    },
  { id: "NVDA",   name: "輝達 NVDA",  abbr: "NVDA"   },
  { id: "^N225",  name: "日経 225",   abbr: "N225"   },
  { id: "^KS11",  name: "韓國綜合",   abbr: "KOSPI"  },
  { id: "^VIX",   name: "VIX 恐慌",  abbr: "VIX"    },
];

async function fetchQuote(symbol) {
  const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data");
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  if (!price || !prev) throw new Error("No price");
  const change = Math.round((price - prev) * 100) / 100;
  const changePct = Math.round((price - prev) / prev * 10000) / 100;
  return { price, change, changePct, prev };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const results = await Promise.allSettled(
    MARKETS.map(m => fetchQuote(m.id).then(q => ({ ...m, ...q, error: false })))
  );

  const data = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { ...MARKETS[i], price: null, change: null, changePct: null, error: true }
  );

  return res.status(200).json({ data, updated: new Date().toISOString() });
};
