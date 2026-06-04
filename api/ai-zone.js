// api/ai-zone.js — 獨立 AI 分析端點（避免 timeout）
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY 未設定" });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(_) {} }

  const { stock_id, name, price, indicators, signal, valuation, monthly_revenue } = body || {};
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  const valStr = valuation
    ? `本益比(PER)：${valuation.per ?? '—'} / 股價淨值比(PBR)：${valuation.pbr ?? '—'} / 殖利率：${valuation.yield ?? '—'}%`
    : '估值資料暫無';

  const prompt = `你是專注中長期價值投資的台股分析師。根據以下數據評估中長期買入時機，只回傳 JSON 不要其他文字：

股票：${name}（${stock_id}）
現價：${price?.close}
52週高/低：${indicators?.high_52w} / ${indicators?.low_52w}
均線：MA20=${indicators?.ma20} MA60=${indicators?.ma60} MA120=${indicators?.ma120} MA240=${indicators?.ma240}
均線位置：${(indicators?.ma_position||[]).join('、')}
MACD柱：${indicators?.macd_hist} / DIF：${indicators?.macd_line} / DEA：${indicators?.macd_signal}
RSI(14)：${indicators?.rsi}
月KD：K=${indicators?.month_k} D=${indicators?.month_d}
${valStr}
${monthly_revenue ? `最新月營收年增率：${monthly_revenue.yoy}%` : ''}
多方訊號：${signal?.bullScore} / 空方訊號：${signal?.bearScore}
綜合判斷：${signal?.summary}

請給中長期（3~12個月）買入建議：
{
  "entry_quality": "excellent" | "good" | "fair" | "poor",
  "entry_label": "現在買點評估（8字內）",
  "buy_low": 建議買入下緣（數字）,
  "buy_high": 建議買入上緣（數字）,
  "stop_loss": 中長期停損價（數字）,
  "target_6m": 6個月目標價（數字）,
  "target_12m": 12個月目標價（數字）,
  "strategy": "分批布局建議（60字內）",
  "reason": "核心理由（50字內）",
  "risk": "low" | "medium" | "high",
  "wait_for": "若非好時機，等什麼條件才進場（30字，是好時機填null）"
}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":apiKey, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:512, messages:[{role:"user",content:prompt}] }),
    });
    if (!r.ok) return res.status(500).json({ error: `AI API 錯誤 ${r.status}` });
    const json = await r.json();
    const text = json.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "AI 回傳格式錯誤", raw: text });
    return res.status(200).json(JSON.parse(match[0]));
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
