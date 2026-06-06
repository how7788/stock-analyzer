// api/analyst.js — 分析師共識（Yahoo Finance quoteSummary）
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id, market } = req.query;
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  // 轉換成 Yahoo Finance 代號
  let symbol;
  if (market === 'jp') symbol = stock_id.replace(/\.T$/i, '') + '.T';
  else if (market === 'us') symbol = stock_id.toUpperCase();
  else symbol = stock_id + '.TW'; // 台股

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,recommendationTrend`;

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Yahoo Finance ${r.status}`);
    const json = await r.json();
    const result = json?.quoteSummary?.result?.[0];
    if (!result) throw new Error("No data");

    const fd = result.financialData || {};
    const rt = result.recommendationTrend?.trend?.[0] || {}; // most recent period

    const targetMean   = fd.targetMeanPrice?.raw ?? null;
    const targetHigh   = fd.targetHighPrice?.raw ?? null;
    const targetLow    = fd.targetLowPrice?.raw ?? null;
    const recKey       = fd.recommendationKey || null;      // "buy","hold","sell","strongBuy","strongSell"
    const recMean      = fd.recommendationMean?.raw ?? null; // 1=Strong Buy...5=Strong Sell
    const numAnalysts  = fd.numberOfAnalystOpinions?.raw ?? null;
    const currentPrice = fd.currentPrice?.raw ?? null;

    // 近期評等分佈
    const trend = {
      strongBuy: rt.strongBuy ?? null,
      buy:       rt.buy       ?? null,
      hold:      rt.hold      ?? null,
      sell:      rt.sell      ?? null,
      strongSell:rt.strongSell ?? null,
    };
    const totalTrend = Object.values(trend).filter(v => v != null).reduce((a, v) => a + v, 0);

    // 上漲空間
    const upside = (targetMean && currentPrice && currentPrice > 0)
      ? Math.round((targetMean - currentPrice) / currentPrice * 10000) / 100
      : null;

    // 人類可讀評等
    const recLabel = {
      strongbuy: '強力買入', buy: '買入', hold: '持有',
      sell: '賣出', strongsell: '強力賣出',
    }[(recKey || '').toLowerCase()] || recKey;

    return res.status(200).json({
      symbol, stock_id, market,
      targetMean, targetHigh, targetLow,
      recKey, recLabel, recMean, numAnalysts,
      upside, currentPrice,
      trend: totalTrend > 0 ? trend : null,
    });
  } catch (err) {
    console.error("[analyst]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
