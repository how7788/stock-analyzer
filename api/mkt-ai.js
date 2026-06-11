// api/mkt-ai.js — 大盤分析 + 個股綜合總結（輕量 AI）
module.exports = async function handler(req, res) {
  // 只允許自己的網域與本機開發環境呼叫，避免 API 額度被第三方盜用
  const _origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/.test(_origin) || /\.vercel\.app$/.test((()=>{try{return new URL(_origin).hostname}catch(_){return ""}})())) {
    res.setHeader("Access-Control-Allow-Origin", _origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY 未設定" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(_) {} }
  body = body || {};

  const type = body.type || 'market';

  let prompt;

  if (type === 'stock') {
    // 個股綜合總結
    const { name, stock_id, price, indicators, valuation, strategy, market } = body;
    const ind = indicators || {};
    const val = valuation || {};
    const p = price?.close;
    const isTW = market !== 'us' && market !== 'jp';

    const techSummary = [
      ind.ma20 && ind.ma60 ? (ind.ma20 > ind.ma60 ? '月線站上季線多頭排列' : '月線跌破季線偏空') : '',
      ind.rsi != null ? (ind.rsi > 75 ? `RSI ${ind.rsi} 偏高` : ind.rsi < 35 ? `RSI ${ind.rsi} 超賣` : `RSI ${ind.rsi} 中性`) : '',
      ind.macd_hist != null ? (ind.macd_hist > 0 ? 'MACD 動能偏多' : 'MACD 動能偏空') : '',
    ].filter(Boolean).join('、');

    const valSummary = val.per && val.per_avg_1y
      ? `本益比 ${val.per}x（一年均值 ${val.per_avg_1y}x，${val.per > val.per_avg_1y * 1.15 ? '估值偏貴' : val.per < val.per_avg_1y * 0.9 ? '估值偏低' : '估值合理'}）`
      : '';

    const stratSummary = strategy?.totalScore != null
      ? `策略評分 ${strategy.totalScore}/100（${strategy.action}）`
      : '';

    prompt = `你是股票分析師，請根據以下技術與基本面資料，用繁體中文寫出3-4句自然語言的綜合投資判斷。

股票：${name || stock_id}（${isTW ? '台股' : market === 'us' ? '美股' : '日股'}）
現價：${p}
技術面：${techSummary || '資料不足'}
估值：${valSummary || '資料不足'}
${stratSummary}

要求：
1. 第一句說明目前技術面狀況
2. 第二句說明估值與基本面
3. 第三句給出操作方向建議（保守、觀察、分批或避開）
4. 不要說「一定」「穩賺」等過度肯定的話
5. 不超過120字
6. 只輸出純文字，不要標題或標點以外的格式`;

  } else {
    // 大盤指數分析（原有功能）
    const { name, price, indicators } = body;
    const ind = indicators || {};
    const p = price?.close;
    const cs = (price?.change_percent || 0) > 0 ? '+' : '';

    prompt = `你是台股/美股大盤技術分析師。根據以下指數技術數據，給出3-4句重點總結，包含：目前均線結構、動能狀況、短中期風險或機會、操作建議。

指數：${name}
現值：${p?.toLocaleString()}（${cs}${price?.change_percent}%）
月線MA20：${ind.ma20?.toLocaleString() ?? '—'}｜季線MA60：${ind.ma60?.toLocaleString() ?? '—'}｜半年線MA120：${ind.ma120?.toLocaleString() ?? '—'}｜年線MA240：${ind.ma240?.toLocaleString() ?? '—'}
RSI：${ind.rsi ?? '—'}｜MACD柱：${ind.macd_hist ?? '—'}｜月KD K值：${ind.month_k ?? '—'}
52週高點：${ind.high_52w?.toLocaleString() ?? '—'}｜52週低點：${ind.low_52w?.toLocaleString() ?? '—'}

只回傳3-4句純文字分析，不要標題、不要 JSON、不要 Markdown。`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const json = await r.json();
    const summary = (json.content?.[0]?.text || "").trim();
    return res.status(200).json({ summary });
  } catch(e) {
    clearTimeout(timeout);
    return res.status(500).json({ error: e.message });
  }
};
