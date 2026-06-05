// api/hot-themes.js — 熱門題材掃描（Tool Use 強制 JSON schema）
async function searchThemeNews(tavilyKey, market) {
  const isUS = market === 'us';
  const queries = isUS
    ? ["US stock market hot sectors themes this week 2026", "AI semiconductor defense energy stock surge rally 2026"]
    : ["台股 熱門族群 主流題材 強勢股 本週 2026", "台股 AI 半導體 伺服器 散熱 CoWoS 強勢 資金"];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ api_key: tavilyKey, query: q, search_depth: "basic", max_results: 5, days: 7 }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));
    clearTimeout(timeout);
    const seen = new Set(), articles = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        const url = item.url || '', content = item.content || '';
        if (!seen.has(url) && content.length > 80) {
          seen.add(url);
          articles.push({ title: item.title, url, snippet: content.slice(0, 180),
            source: (() => { try { return new URL(url).hostname.replace('www.',''); } catch(_) { return ''; } })(),
            published: item.published_date || null });
        }
      }
    }
    return articles.slice(0, 8);
  } catch (_) { clearTimeout(timeout); return []; }
}

async function analyzeWithClaude(apiKey, market, articles) {
  const isTW = market !== 'us';
  const newsText = articles.length
    ? articles.map(a => `• ${a.title} | ${a.snippet.slice(0, 100)}`).join('\n')
    : '無新聞資料，請根據一般市場知識分析';

  const userMsg = `你是${isTW ? '台股' : '美股'}題材研究分析師。根據以下近期新聞，分析當前市場最熱門題材，給出3-5個題材，每個2-3檔代表股。\n\n近期新聞：\n${newsText}`;

  // ★ Tool Use：強制 Claude 依 schema 回傳，完全不會有 JSON 格式錯誤
  const tool = {
    name: "report_themes",
    description: "回報市場熱門題材分析結果",
    input_schema: {
      type: "object",
      required: ["market_mood", "mood_reason", "themes", "watch_list", "avoid_sectors"],
      properties: {
        market_mood:    { type: "string", enum: ["多方", "盤整", "偏空"] },
        mood_reason:    { type: "string" },
        themes: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "heat", "why_hot", "key_stocks", "risk"],
            properties: {
              name:     { type: "string" },
              heat:     { type: "integer", minimum: 1, maximum: 10 },
              why_hot:  { type: "string" },
              risk:     { type: "string" },
              news_ref: { type: "string" },
              key_stocks: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "name", "reason"],
                  properties: {
                    id:     { type: "string" },
                    name:   { type: "string" },
                    reason: { type: "string" },
                  }
                }
              }
            }
          }
        },
        watch_list:     { type: "array", items: { type: "string" } },
        avoid_sectors:  { type: "array", items: { type: "string" } },
      }
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        tools: [tool],
        tool_choice: { type: "tool", name: "report_themes" },
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Claude API 錯誤 ${r.status}`);
    const json = await r.json();

    // Tool Use 回傳在 content[].type === 'tool_use' 的 .input 裡
    const toolBlock = (json.content || []).find(b => b.type === 'tool_use');
    if (!toolBlock?.input) throw new Error("AI 未回傳分析結果");
    return toolBlock.input;
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
