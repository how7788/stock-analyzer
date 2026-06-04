// api/news.js — 新聞搜尋（過濾低品質 + 排序最新）
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

  // 針對不同市場優化搜尋詞
  const queries = isUS
    ? [
        `${stock_id} ${name} stock news analysis 2025 2026`,
        `${name} earnings revenue outlook forecast`,
      ]
    : [
        `${stock_id} ${name} 最新消息 財報 法說 2025 2026`,
        `${name} 營收 展望 產業 分析`,
      ];

  // 低品質域名黑名單（純報價頁、搜尋結果頁）
  const BLOCKLIST = [
    'wantgoo.com', 'tw.stock.yahoo.com', 'cn.investing.com',
    'finance.yahoo.com/quote', 'marketwatch.com/investing/stock',
    'stockcharts.com', 'tradingview.com/chart',
    'finviz.com', 'wsj.com/market-data',
    'goodinfo.tw', 'mops.twse.com.tw',
  ];

  const isBlocked = (url) => BLOCKLIST.some(d => url.includes(d));

  // 判斷是否為有實質內容的新聞頁
  const isQualityArticle = (item) => {
    const url = item.url || '';
    const title = item.title || '';
    const content = item.content || '';
    if (isBlocked(url)) return false;
    if (content.length < 80) return false;  // 太短代表沒實質內容
    // 排除明顯的股價查詢頁
    if (/\/quote\/|\/symbol\/|\/stock\/[A-Z0-9]+\/?$/.test(url)) return false;
    // 排除論壇討論串標題（不含實質財經資訊）
    if (/今日|昨日|漲跌幅|股價查詢/.test(title) && content.length < 200) return false;
    return true;
  };

  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: q,
          search_depth: "basic",
          max_results: 6,
          days: 14,
          include_answer: false,
          include_raw_content: false,
          include_domains: isUS
            ? ["reuters.com","bloomberg.com","cnbc.com","seekingalpha.com","barrons.com","wsj.com","fool.com","marketwatch.com","investing.com"]
            : [],
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));

    // 合併、過濾、去重
    const seen = new Set();
    const articles = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        if (!seen.has(item.url) && isQualityArticle(item)) {
          seen.add(item.url);
          // 解析發布日期
          let pubDate = null;
          if (item.published_date) {
            try { pubDate = new Date(item.published_date); } catch(_) {}
          }
          articles.push({
            title: item.title,
            url: item.url,
            source: item.source || (() => {
              try { return new URL(item.url).hostname.replace('www.',''); } catch(_) { return ''; }
            })(),
            published: item.published_date || null,
            published_ts: pubDate ? pubDate.getTime() : 0,
            snippet: (item.content || '').slice(0, 180),
            score: item.score || 0,
          });
        }
      }
    }

    // 排序：優先最新（有日期），其次相關性
    articles.sort((a, b) => {
      if (a.published_ts && b.published_ts) return b.published_ts - a.published_ts;
      if (a.published_ts) return -1;
      if (b.published_ts) return 1;
      return b.score - a.score;
    });

    return res.status(200).json({ stock_id, name, articles: articles.slice(0, 6) });
  } catch (err) {
    console.error("[news]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
