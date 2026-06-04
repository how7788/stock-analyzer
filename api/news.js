// api/news.js — 用 Tavily 搜尋股票相關新聞
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return res.status(500).json({ error: "TAVILY_API_KEY 未設定" });

  const { stock_id, name, market } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請提供 stock_id" });

  const isUS = market === "us";

  // 組合搜尋關鍵字
  const queries = isUS
    ? [`${stock_id} ${name} stock news`, `${name} earnings outlook 2025`]
    : [`${stock_id} ${name} 股票 新聞`, `${name} 營收 法說會 展望`];

  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: q,
          search_depth: "basic",
          max_results: 4,
          days: 7,           // 只抓近 7 天
          include_answer: false,
          include_raw_content: false,
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));

    // 合併去重
    const seen = new Set();
    const articles = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          articles.push({
            title: item.title,
            url: item.url,
            source: item.source || new URL(item.url).hostname,
            published: item.published_date || null,
            snippet: item.content?.slice(0, 150) || "",
            score: item.score || 0,
          });
        }
      }
    }

    // 依相關性排序，最多回傳 6 筆
    articles.sort((a, b) => b.score - a.score);
    const top = articles.slice(0, 6);

    return res.status(200).json({ stock_id, name, articles: top });
  } catch (err) {
    console.error("[news]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
