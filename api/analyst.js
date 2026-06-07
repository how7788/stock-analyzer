// api/analyst.js — 分析師共識（Yahoo Finance with crumb）
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function getYahooCrumb() {
  try {
    // Step 1: 取得 session cookie
    const init = await fetch("https://finance.yahoo.com/", {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const rawCookie = init.headers.get("set-cookie") || "";
    // 擷取 A1 或 A3 cookie
    const match = rawCookie.match(/A[13]=[^;]+/);
    const cookie = match ? match[0] : "";

    // Step 2: 取得 crumb
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": UA,
        "Cookie": cookie,
        "Referer": "https://finance.yahoo.com/",
      },
      signal: AbortSignal.timeout(5000),
    });
    const crumb = crumbRes.ok ? (await crumbRes.text()).trim() : "";
    return { crumb, cookie };
  } catch (_) {
    return { crumb: "", cookie: "" };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id, market } = req.query;
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  let symbol;
  if (market === "jp") symbol = stock_id.replace(/\.T$/i, "") + ".T";
  else if (market === "us") symbol = stock_id.toUpperCase();
  else symbol = stock_id + ".TW";

  try {
    const { crumb, cookie } = await getYahooCrumb();

    const qs = new URLSearchParams({
      modules: "financialData,recommendationTrend",
      crumb: crumb || "",
      formatted: "false",
      lang: "en-US",
      region: "US",
    });

    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${qs}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `https://finance.yahoo.com/quote/${symbol}/analysis`,
        "Cookie": cookie,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) return res.status(200).json({ available: false, reason: `HTTP ${r.status}` });

    const json = await r.json();
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return res.status(200).json({ available: false, reason: "no result" });

    const fd = result.financialData || {};
    const rt = (result.recommendationTrend?.trend || [])[0] || {};
    const numAnalysts = fd.numberOfAnalystOpinions?.raw ?? null;
    if (!numAnalysts) return res.status(200).json({ available: false, reason: "no analysts" });

    const targetMean  = fd.targetMeanPrice?.raw  ?? null;
    const targetHigh  = fd.targetHighPrice?.raw  ?? null;
    const targetLow   = fd.targetLowPrice?.raw   ?? null;
    const recKey      = fd.recommendationKey     ?? null;
    const recMean     = fd.recommendationMean?.raw ?? null;
    const currentPrice = fd.currentPrice?.raw    ?? null;
    const upside = (targetMean && currentPrice > 0)
      ? Math.round((targetMean - currentPrice) / currentPrice * 10000) / 100 : null;
    const recLabel = { strongbuy:"強力買入", buy:"買入", hold:"持有", sell:"賣出", strongsell:"強力賣出" }[(recKey||"").toLowerCase()] || recKey;
    const trend = { strongBuy:rt.strongBuy??null, buy:rt.buy??null, hold:rt.hold??null, sell:rt.sell??null, strongSell:rt.strongSell??null };
    const tTotal = Object.values(trend).filter(v=>v!=null).reduce((a,v)=>a+v,0);

    return res.status(200).json({
      available: true,
      symbol, stock_id, market,
      targetMean, targetHigh, targetLow,
      recKey, recLabel, recMean, numAnalysts,
      upside, currentPrice,
      trend: tTotal > 0 ? trend : null,
    });
  } catch (err) {
    console.error("[analyst]", err.message);
    return res.status(200).json({ available: false, reason: err.message });
  }
};
