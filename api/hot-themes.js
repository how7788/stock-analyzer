// api/hot-themes.js — 熱門題材掃描（Tool Use + 強制只用新聞資料）
async function searchThemeNews(tavilyKey, market) {
  const isUS = market === 'us';
  const queries = isUS
    ? ["US stock market hot sectors themes this week 2026", "AI semiconductor defense energy stock surge 2026"]
    : ["台股 熱門族群 主流題材 強勢股 本週 2026", "台股 AI 半導體 伺服器 散熱 CoWoS 強勢 資金"];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ api_key: tavilyKey, query: q, search_depth: "basic", max_results: 6, days: 7 }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));
    clearTimeout(timeout);
    const seen = new Set(), articles = [];
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
    return articles.slice(0, 10);
  } catch (_) { clearTimeout(timeout); return []; }
}

async function analyzeWithClaude(apiKey, market, articles) {
  const isTW = market !== 'us';

  if (!articles.length) throw new Error("無法取得市場新聞，請稍後再試");

  const newsText = articles.map((a, i) =>
    `[${i + 1}] ${a.title}\n來源: ${a.source} | ${a.snippet.slice(0, 150)}`
  ).join('\n\n');

  const userMsg = `你是${isTW ? '台股' : '美股'}題材研究分析師。

【重要】只根據以下新聞內容分析，不要使用任何訓練資料中的歷史數字（例如指數點位、價格）。

以下是最新市場新聞：
${newsText}

請根據上述新聞：
1. 判斷市場氣氛（多方/盤整/偏空）
2. 整理出3至5個最熱門題材，每個題材列出2至3檔代表股
3. 給出值得關注的股票代號清單
4. 列出目前應避開的族群

${isTW ? '台股股票代號為4-6位數字。' : '美股使用英文代號。'}
請呼叫 report_themes 工具回傳結果。`;

  // Tool Use schema：加詳細描述讓 Haiku 知道要填什麼
  const tool = {
    name: "report_themes",
    description: "根據提供的新聞資料，回報市場熱門題材分析結果。必須填入至少3個themes、3個watch_list、1個avoid_sectors。",
    input_schema: {
      type: "object",
      required: ["market_mood", "mood_reason", "themes", "watch_list", "avoid_sectors"],
      properties: {
        market_mood: {
          type: "string", enum: ["多方", "盤整", "偏空"],
          description: "根據新聞判斷的整體市場氣氛"
        },
        mood_reason: {
          type: "string",
          description: "市場氣氛判斷的原因，50字以內，只根據新聞內容"
        },
        themes: {
          type: "array",
          description: "至少3個、最多5個熱門題材，每個題材要有2-3檔代表股",
          minItems: 3,
          items: {
            type: "object",
            required: ["name", "heat", "why_hot", "key_stocks", "risk"],
            properties: {
              name:    { type: "string", description: "題材名稱，例如 AI伺服器、先進封裝" },
              heat:    { type: "integer", minimum: 1, maximum: 10, description: "熱度分數1-10" },
              why_hot: { type: "string", description: "為何熱門，根據新聞內容說明，50字以內" },
              risk:    { type: "string", description: "主要風險，20字以內" },
              news_ref:{ type: "string", description: "對應的新聞標題關鍵字" },
              key_stocks: {
                type: "array",
                description: "2至3檔代表股",
                minItems: 2,
                items: {
                  type: "object",
                  required: ["id", "name", "reason"],
                  properties: {
                    id:     { type: "string", description: isTW ? "台股4-6位數字代號" : "英文股票代號" },
                    name:   { type: "string", description: "公司名稱" },
                    reason: { type: "string", description: "選股理由，15字以內" },
                  }
                }
              }
            }
          }
        },
        watch_list: {
          type: "array", minItems: 3,
          description: "值得關注的股票代號清單，至少3個",
          items: { type: "string" }
        },
        avoid_sectors: {
          type: "array", minItems: 1,
          description: "目前應避開的族群，至少1個",
          items: { type: "string" }
        },
      }
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        tools: [tool],
        tool_choice: { type: "tool", name: "report_themes" },
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Claude API 錯誤 ${r.status}`);
    const json = await r.json();
    const toolBlock = (json.content || []).find(b => b.type === 'tool_use');
    if (!toolBlock?.input) throw new Error("AI 未回傳分析結果");
    if (!toolBlock.input.themes?.length) throw new Error("AI 回傳的題材清單為空，請重試");
    return toolBlock.input;
  } catch (e) { clearTimeout(timeout); throw e; }
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
