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

  // 低品質域名與路徑黑名單
  const DOMAIN_BLOCK = [
    'wantgoo.com', 'tw.stock.yahoo.com', 'finance.yahoo.com/quote',
    'goodinfo.tw', 'mops.twse.com.tw', 'stockcharts.com',
    'tradingview.com', 'finviz.com', 'youtube.com', 'youtu.be',
    'cmoney.tw/follow', 'cmoney.tw/notes',
  ];
  const PATH_BLOCK = [
    '/quote/', '/symbol/', '/equities/', '/stocks/', '/investing/stock',
    '/market-data/', '/markets/stocks/', '/companies/',
    '/stock-price', 'stock-price-today', 'live-quote',
  ];

  const isBlocked = (url) => {
    const lower = url.toLowerCase();
    if (DOMAIN_BLOCK.some(d => lower.includes(d))) return true;
    if (PATH_BLOCK.some(p => lower.includes(p))) return true;
    // 純股票代號頁（如 reuters.com/markets/companies/AAPL.O/）
    if (/\/[A-Z]{1,5}\.[A-Z]{1,2}\/?$/.test(url)) return true;
    return false;
  };

  // 嘗試從內文/標題中提取日期
  const extractDate = (item) => {
    if (item.published_date) return item.published_date;
    // 嘗試從 content 或 title 提取日期模式
    const text = (item.content || '') + ' ' + (item.title || '');
    const patterns = [
      /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/,  // 2026年6月5日 or 2026-06-05
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        try {
          const d = new Date(m[0].replace(/年|月/g, '-').replace(/日/g, ''));
          if (!isNaN(d) && d.getFullYear() >= 2024) return d.toISOString();
        } catch(_) {}
      }
    }
    return null;
  };

  // 判斷是否為有實質內容的新聞頁
  const isQualityArticle = (item) => {
    const url = item.url || '';
    const title = item.title || '';
    const snippet = item.content || '';
    if (isBlocked(url)) return false;
    if (snippet.length < 80) return false;
    // 過濾純股價查詢頁標題
    const pricePageTitle = /stock price today|live quote|latest news.*price|price.*latest news/i;
    if (pricePageTitle.test(title)) return false;
    // markdown 連結污染（investing.com stock page 特徵）
    if ((snippet.match(/\[.*?\]\(http/g) || []).length > 3) return false;
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
          const rawDate = extractDate(item);
          let pubDate2 = null;
          if (rawDate) { try { pubDate2 = new Date(rawDate); } catch(_) {} }
          articles.push({
            title: item.title,
            url: item.url,
            source: item.source || (() => {
              try { return new URL(item.url).hostname.replace('www.',''); } catch(_) { return ''; }
            })(),
            published: rawDate || null,
            published_ts: pubDate2 ? pubDate2.getTime() : 0,
            snippet: (item.content || '').replace(/\[.*?\]\(https?:\/\/[^)]+\)/g, '').slice(0, 180).trim(),
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
