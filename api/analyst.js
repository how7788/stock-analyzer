// api/analyst.js — 分析師共識（Yahoo Finance）
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id, market } = req.query;
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  let symbol;
  if (market === 'jp') symbol = stock_id.replace(/\.T$/i, '') + '.T';
  else if (market === 'us') symbol = stock_id.toUpperCase();
  else symbol = stock_id + '.TW';

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com",
    "Cache-Control": "no-cache",
  };

  // 嘗試多個端點
  const urls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData%2CrecommendationTrend&corsDomain=finance.yahoo.com`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData%2CrecommendationTrend`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const json = await r.json();

      // v10 quoteSummary
      if (json.quoteSummary?.result?.[0]) {
        const fd = json.quoteSummary.result[0].financialData || {};
        const rt = json.quoteSummary.result[0].recommendationTrend?.trend?.[0] || {};
        const numAnalysts = fd.numberOfAnalystOpinions?.raw ?? null;
        if (!numAnalysts) continue; // 沒有分析師資料，試下一個

        const targetMean = fd.targetMeanPrice?.raw ?? null;
        const targetHigh = fd.targetHighPrice?.raw ?? null;
        const targetLow  = fd.targetLowPrice?.raw ?? null;
        const recKey     = fd.recommendationKey || null;
        const recMean    = fd.recommendationMean?.raw ?? null;
        const currentPrice = fd.currentPrice?.raw ?? null;
        const upside = (targetMean && currentPrice > 0)
          ? Math.round((targetMean - currentPrice) / currentPrice * 10000) / 100 : null;
        const recLabel = { strongbuy:'強力買入', buy:'買入', hold:'持有', sell:'賣出', strongsell:'強力賣出' }[(recKey||'').toLowerCase()] || recKey;
        const trend = { strongBuy: rt.strongBuy??null, buy: rt.buy??null, hold: rt.hold??null, sell: rt.sell??null, strongSell: rt.strongSell??null };
        const tTotal = Object.values(trend).filter(v=>v!=null).reduce((a,v)=>a+v,0);
        return res.status(200).json({
          symbol, stock_id, market,
          targetMean, targetHigh, targetLow,
          recKey, recLabel, recMean, numAnalysts,
          upside, currentPrice,
          trend: tTotal > 0 ? trend : null,
        });
      }
    } catch (_) { continue; }
  }

  // 所有嘗試都失敗
  return res.status(200).json({ available: false, symbol });
};
