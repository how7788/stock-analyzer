// api/hot-themes.js — 熱門題材掃描（新聞 + 成交量 + AI 推薦）
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

async function getTopVolumeStocks(token) {
  // 抓近 3 天高成交量台股（作為熱門股參考）
  try {
    const res = await fetch(
      `${FINMIND_BASE}?dataset=TaiwanStockPrice&start_date=${daysAgo(3)}&token=${token}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (json.status !== 200) return [];

    // 按成交量排序，取前 30
    const data = json.data || [];
    const byStock = {};
    for (const d of data) {
      const vol = parseInt(d.Trading_Volume || 0);
      if (!byStock[d.stock_id] || vol > byStock[d.stock_id].vol) {
        byStock[d.stock_id] = {
          stock_id: d.stock_id,
          name: d.stock_name || d.stock_id,
          close: parseFloat(d.close),
          vol,
          date: d.date,
        };
      }
    }
    return Object.values(byStock)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 30);
  } catch (_) { return []; }
}

async function searchThemeNews(tavilyKey, market) {
  const queries = market === 'us'
    ? [
        "US stock market hot sectors themes 2026 week",
        "AI semiconductor energy defense stock surge 2026",
      ]
    : [
        "台股 熱門族群 主流題材 本週 2026",
        "台股 AI 半導體 電動車 伺服器 成交量 強勢",
      ];

  const results = await Promise.all(queries.map(q =>
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: q,
        search_depth: "basic",
        max_results: 5,
        days: 7,
        include_answer: false,
        include_raw_content: false,
      }),
    }).then(r => r.json()).catch(() => ({ results: [] }))
  ));

  // 合併新聞
  const seen = new Set();
  const articles = [];
  for (const r of results) {
    for (const item of (r.results || [])) {
      if (!seen.has(item.url) && (item.content || '').length > 80) {
        seen.add(item.url);
        articles.push({
          title: item.title,
          url: item.url,
          snippet: (item.content || '').slice(0, 250),
          source: (() => { try { return new URL(item.url).hostname.replace('www.',''); } catch(_) { return ''; } })(),
          published: item.published_date || null,
        });
      }
    }
  }
  return articles.slice(0, 8);
}

async function analyzeWithClaude(apiKey, market, topStocks, articles) {
  const isTW = market !== 'us';
  const mktLabel = isTW ? '台股' : '美股';

  const stocksText = topStocks.length
    ? `近期高成交量股票：\n` + topStocks.slice(0, 20).map(s =>
        `${s.stock_id} ${s.name} 成交量${(s.vol/1e4).toFixed(0)}萬 收${s.close}`
      ).join('\n')
    : '（無成交量資料）';

  const newsText = articles.length
    ? `近期熱門新聞摘要：\n` + articles.map(a => `• ${a.title}\n  ${a.snippet.slice(0,120)}`).join('\n\n')
    : '（無新聞資料）';

  const prompt = `你是台股/美股題材研究分析師，擅長發掘市場熱門題材與強勢族群。

市場：${mktLabel}
分析日期：${new Date().toLocaleDateString('zh-TW')}

${stocksText}

${newsText}

請根據以上資料，分析當前市場最熱門的題材，只輸出 JSON 不要其他文字：
{
  "updated": "今日日期",
  "market_mood": "多方/盤整/偏空",
  "mood_reason": "市場氣氛說明（30字內）",
  "themes": [
    {
      "name": "AI伺服器",
      "heat": 9,
      "why_hot": "CoWoS需求強勁訂單滿載",
      "key_stocks": [
        {"id": "2330", "name": "台積電", "reason": "CoWoS主要供應商"},
        {"id": "3034", "name": "聯詠", "reason": "相關受惠"}
      ],
      "risk": "AI題材估值偏高需注意",
      "news_ref": "法說會展望樂觀"
    }
  ],
  "watch_list": ["值得追蹤的股票代號1", "代號2", "代號3"],
  "avoid_sectors": ["目前應避開的族群1", "族群2"]
}

請給出 3-5 個題材，每個題材 2-3 檔推薦股。
${isTW ? '台股代號用4-6位數字，名稱用繁體中文。' : '美股用英文代號。'}
規則：
- 所有字串值不得含雙引號、換行符號
- reason/why_hot/risk 欄位最多20個字，不要有標點符號堆疊
- key_stocks 每個題材最多3檔
- JSON 必須可以直接被 JSON.parse() 解析`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API 錯誤 ${r.status}`);

  const json = await r.json();
  let text = (json.content?.[0]?.text || "")
    .replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start === -1) throw new Error("AI 未回傳有效 JSON");

  let jsonStr = text.slice(start, end + 1)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(jsonStr);
  } catch(e1) {
    jsonStr = jsonStr.replace(/"([^"\\\n]*)"/g, (m, v) =>
      `"${v.replace(/\n/g,' ').replace(/\r/g,' ').trim()}"`
    ).replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(jsonStr);
    } catch(e2) {
      throw new Error("JSON 解析失敗: " + e2.message);
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tavilyKey = process.env.TAVILY_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const finmindToken = process.env.FINMIND_TOKEN;

  if (!tavilyKey || !anthropicKey) {
    return res.status(500).json({ error: "缺少 API Key 設定" });
  }

  const market = req.query.market || 'tw';

  try {
    // 並行抓新聞 + 成交量
    const [articles, topStocks] = await Promise.all([
      searchThemeNews(tavilyKey, market),
      market === 'tw' && finmindToken ? getTopVolumeStocks(finmindToken) : Promise.resolve([]),
    ]);

    // Claude 整合分析
    const analysis = await analyzeWithClaude(anthropicKey, market, topStocks, articles);

    return res.status(200).json({
      ...analysis,
      news_sources: articles.map(a => ({
        title: a.title,
        url: a.url,
        source: a.source,
        published: a.published,
      })),
    });
  } catch (err) {
    console.error("[hot-themes]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
