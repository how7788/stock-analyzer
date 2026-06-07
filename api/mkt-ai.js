// api/mkt-ai.js — AI 大盤技術分析
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY 未設定" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(_) {} }

  const { name, price, indicators } = body || {};
  if (!name) return res.status(400).json({ error: "缺少資料" });

  const ind = indicators || {};
  const p = price?.close;
  const cs = (price?.change_percent || 0) > 0 ? '+' : '';

  const prompt = `你是台股/美股大盤技術分析師。根據以下指數技術數據，給出3-4句重點總結，包含：目前均線結構、動能狀況、短中期風險或機會、操作建議。

指數：${name}
現值：${p?.toLocaleString()}（${cs}${price?.change_percent}%）
月線MA20：${ind.ma20?.toLocaleString() ?? '—'}｜季線MA60：${ind.ma60?.toLocaleString() ?? '—'}｜半年線MA120：${ind.ma120?.toLocaleString() ?? '—'}｜年線MA240：${ind.ma240?.toLocaleString() ?? '—'}
均線位置：${(ind.ma_position||[]).join('、') || '—'}
RSI：${ind.rsi ?? '—'}｜MACD柱：${ind.macd_hist ?? '—'}｜月KD K值：${ind.month_k ?? '—'}
52週高點：${ind.high_52w?.toLocaleString() ?? '—'}｜52週低點：${ind.low_52w?.toLocaleString() ?? '—'}

只回傳3-4句純文字分析，不要標題、不要 JSON、不要 Markdown。直接描述技術面現況與操作建議。`;

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
