// api/news.js — 新聞搜尋 v2（嚴格日期過濾 + 摘要清洗）
module.exports = async function handler(req, res) {
  // 只允許自己的網域與本機開發環境呼叫，避免 API 額度被第三方盜用
  const _origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/.test(_origin) || /\.vercel\.app$/.test((()=>{try{return new URL(_origin).hostname}catch(_){return ""}})())) {
    res.setHeader("Access-Control-Allow-Origin", _origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1200");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return res.status(500).json({ error: "TAVILY_API_KEY 未設定" });

  const { stock_id, name, market } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請提供 stock_id" });
  const isUS = market === "us";

  const queries = isUS
    ? [
        `${stock_id} ${name} stock news analysis 2026`,
        `${name} earnings revenue outlook forecast`,
        `${name} ${stock_id} 中文 最新 分析`,
      ]
    : [
        `${stock_id} ${name} 最新消息 財報 法說 2026`,
        `${name} 營收 展望 產業 分析`,
        `${name} ${stock_id} 國際 外資 美股 中文`,
      ];

  const DOMAIN_BLOCK = [
    'wantgoo.com','tw.stock.yahoo.com','finance.yahoo.com/quote',
    'goodinfo.tw','mops.twse.com.tw','stockcharts.com',
    'tradingview.com','finviz.com','youtube.com','youtu.be',
    'cmoney.tw/follow','cmoney.tw/notes',
  ];
  const PATH_BLOCK = [
    '/quote/','/symbol/','/equities/','/stocks/','/investing/stock',
    '/market-data/','/markets/stocks/','/companies/',
    '/stock-price','stock-price-today','live-quote',
  ];
  const isBlocked = url => {
    const l = url.toLowerCase();
    return DOMAIN_BLOCK.some(d => l.includes(d)) || PATH_BLOCK.some(p => l.includes(p)) || /\/[A-Z]{1,5}\.[A-Z]{1,2}\/?$/.test(url);
  };

  // ── 嚴格摘要清洗 ──────────────────────────────────────────
  const cleanSnippet = (raw) => {
    if (!raw) return '';
    return raw
      .replace(/<[^>]+>/g, ' ')                     // HTML tags
      .replace(/#{1,6}\s*/g, '')                     // Markdown 標題
      .replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1')      // **bold** *italic*
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')  // [text](url)
      .replace(/https?:\/\/\S+/g, '')                // 裸 URL
      .replace(/[>|`~_]{2,}/g, '')                   // 爬蟲殘留
      .replace(/\s{2,}/g, ' ')                       // 多餘空白
      .replace(/^\s*[>\-*•]\s*/gm, '')               // 列表符號
      .trim()
      .slice(0, 200);
  };

  const isQuality = (item) => {
    const url = item.url || '';
    const snippet = cleanSnippet(item.content || '');
    if (isBlocked(url)) return false;
    if (snippet.length < 60) return false;
    if (/stock price today|live quote/i.test(item.title || '')) return false;
    return true;
  };

  const parseDate = (item) => {
    if (item.published_date) {
      try { const d = new Date(item.published_date); if (!isNaN(d)) return d; } catch(_) {}
    }
    const text = (item.content || '') + ' ' + (item.title || '');
    const re = /(20\d{2})[年\-\/](0?[1-9]|1[0-2])[月\-\/](0?[1-9]|[12]\d|3[01])/;
    const m = text.match(re);
    if (m) {
      try { const d = new Date(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`); if (!isNaN(d)) return d; } catch(_) {}
    }
    return null;
  };

  const now = Date.now();
  const MS_14 = 14 * 86400000;

  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey, query: q, search_depth: "basic",
          max_results: 6, days: 14, include_answer: false, include_raw_content: false,
          include_domains: isUS ? ["reuters.com","bloomberg.com","cnbc.com","seekingalpha.com","barrons.com","wsj.com","fool.com","marketwatch.com"] : [],
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));

    const seen = new Set(), recent = [], older = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        if (seen.has(item.url) || !isQuality(item)) continue;
        seen.add(item.url);
        const snippet = cleanSnippet(item.content || '');
        const pub = parseDate(item);
        const ts = pub ? pub.getTime() : 0;
        const source = item.source || (() => { try { return new URL(item.url).hostname.replace('www.',''); } catch(_) { return ''; } })();
        const article = {
          title: item.title || '', url: item.url, source,
          published: pub ? pub.toISOString() : null,
          published_ts: ts, snippet, score: item.score || 0,
        };
        // ── 嚴格 14 日過濾 ──
        if (pub && (now - ts) <= MS_14) recent.push(article);
        else older.push(article);
      }
    }

    // 排序：日期新到舊，其次相關性
    const sortFn = (a, b) => {
      if (a.published_ts && b.published_ts) return b.published_ts - a.published_ts;
      if (a.published_ts) return -1;
      if (b.published_ts) return 1;
      return b.score - a.score;
    };
    recent.sort(sortFn);
    older.sort(sortFn);

    const insufficient = recent.length < 3;
    const articles = [...recent.slice(0, 6), ...(insufficient ? older.slice(0, 3 - recent.length) : [])];

    return res.status(200).json({ stock_id, name, articles, insufficient, recent_count: recent.length });
  } catch (err) {
    console.error("[news]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
