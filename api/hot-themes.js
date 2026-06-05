// api/hot-themes.js — 熱門題材掃描
async function searchThemeNews(tavilyKey, market) {
  const isUS = market === 'us';
  const queries = isUS
    ? [
        "US stock market hot sectors themes this week 2026",
        "AI semiconductor defense energy stock surge rally 2026",
      ]
    : [
        "台股 熱門族群 主流題材 強勢股 本週 2026",
        "台股 AI 半導體 伺服器 散熱 CoWoS 強勢 資金",
      ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: tavilyKey, query: q,
          search_depth: "basic", max_results: 5, days: 7,
          include_answer: false, include_raw_content: false,
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));
    clearTimeout(timeout);

    const seen = new Set();
    const articles = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        const url = item.url || '', content = item.content || '';
        if (!seen.has(url) && content.length > 80) {
          seen.add(url);
          articles.push({
            title: item.title, url,
            snippet: content.slice(0, 200),
            source: (() => { try { return new URL(url).hostname.replace('www.', ''); } catch (_) { return ''; } })(),
            published: item.published_date || null,
          });
        }
      }
    }
    return articles.slice(0, 8);
  } catch (_) { clearTimeout(timeout); return []; }
}

async function analyzeWithClaude(apiKey, market, articles) {
  const isTW = market !== 'us';
  const newsText = articles.length
    ? articles.map(a => `• ${a.title}\n  ${a.snippet.slice(0, 120)}`).join('\n\n')
    : '（無新聞資料，請根據一般市場知識分析）';

  const prompt = `你是${isTW ? '台股' : '美股'}題材研究分析師。根據以下近期新聞，分析當前市場最熱門題材。

近期新聞：
${newsText}

只輸出以下 JSON，不要其他文字，所有字串值不含雙引號或換行符號：
{
  "updated": "${new Date().toLocaleDateString('zh-TW')}",
  "market_mood": "多方",
  "mood_reason": "AI需求強勁資金持續流入",
  "themes": [
    {
      "name": "AI伺服器",
      "heat": 9,
      "why_hot": "CoWoS需求爆發訂單滿載",
      "key_stocks": [
        {"id": "2330", "name": "台積電", "reason": "CoWoS主要供應商"},
        {"id": "3167", "name": "大量", "reason": "AI設備主流卡位"}
      ],
      "risk": "估值偏高短線有回檔風險",
      "news_ref": "法說展望樂觀"
    }
  ],
  "watch_list": ["2330", "2317", "2454"],
  "avoid_sectors": ["傳產", "金融股"]
}

請給3-5個題材，每個2-3檔股票。market_mood只能是多方/盤整/偏空。重要：所有字串值嚴禁包含雙引號、換行、逗號以外的標點符號。
${isTW ? '台股用4-6位數字代號。' : '美股用英文代號。'}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Claude API 錯誤 ${r.status}`);

    const json = await r.json();
    let text = (json.content?.[0]?.text || "").replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1) throw new Error("AI 未回傳 JSON");

    // ★ 強化版清理（含 Unicode 行分隔符、無效反斜線）
    let jsonStr = text.slice(s, e + 1)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\u2028|\u2029/g, " ")
      .replace(/\r\n|\r|\n/g, " ")
      .replace(/\t/g, " ")
      .replace(/\\(?!["\\\/bfnrtu])/g, "")
      .replace(/,(\s*[}\]])/g, "$1");

    try { return JSON.parse(jsonStr); }
    catch (parseErr) {
      console.error("[hot-themes] JSON parse failed:", parseErr.message, "| snippet:", jsonStr.slice(Math.max(0, jsonStr.length-100)));
      throw new Error("AI 回傳格式錯誤，請重試");
    }
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tavilyKey = process.env.TAVILY_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!tavilyKey || !anthropicKey) return res.status(500).json({ error: "缺少 API Key" });

  const market = req.query.market || 'tw';

  try {
    const articles = await searchThemeNews(tavilyKey, market);
    const analysis = await analyzeWithClaude(anthropicKey, market, articles);
    return res.status(200).json({
      ...analysis,
      news_sources: articles.map(a => ({ title: a.title, url: a.url, source: a.source, published: a.published })),
    });
  } catch (err) {
    console.error("[hot-themes]", err.message);
    return res.status(500).json({ error: err.message || "分析失敗，請稍後再試" });
  }
};
