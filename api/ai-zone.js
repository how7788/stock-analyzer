// api/ai-zone.js — 含分批進場結構化輸出
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY 未設定" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(_) {} }

  const { stock_id, name, market, currency, price, indicators, signal, valuation, monthly_revenue } = body || {};
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  const isUS = market === "us";
  const cur = currency || (isUS ? "USD" : "TWD");

  const biasMA20 = indicators?.ma20 ? Math.round(((price?.close - indicators.ma20) / indicators.ma20) * 10000) / 100 : null;
  const biasMA60 = indicators?.ma60 ? Math.round(((price?.close - indicators.ma60) / indicators.ma60) * 10000) / 100 : null;
  const pctFrom52High = indicators?.high_52w ? Math.round(((price?.close - indicators.high_52w) / indicators.high_52w) * 10000) / 100 : null;
  const pctFrom52Low = indicators?.low_52w ? Math.round(((price?.close - indicators.low_52w) / indicators.low_52w) * 10000) / 100 : null;

  const maArr = (() => {
    const { ma20, ma60, ma120 } = indicators || {};
    if (ma20 && ma60 && ma120) {
      if (ma20 > ma60 && ma60 > ma120) return "多頭排列";
      if (ma20 < ma60 && ma60 < ma120) return "空頭排列";
      return "均線糾結";
    }
    return "資料不足";
  })();

  const valStr = valuation
    ? `P/E=${valuation.per ?? "N/A"}  P/B=${valuation.pbr ?? "N/A"}  殖利率=${valuation.yield ?? "N/A"}%`
    : "估值資料無";

  const prompt = `你是台股/美股中長期趨勢投資分析師，給自己用，請直接明確。

股票：${name}（${stock_id}）${isUS?"美股":"台股"}  現價：${price?.close}${cur}  漲跌：${price?.change_percent}%
MA20=${indicators?.ma20}  MA60=${indicators?.ma60}  MA120=${indicators?.ma120}  MA240=${indicators?.ma240}
均線排列：${maArr}  乖離MA20：${biasMA20}%  乖離MA60：${biasMA60}%
均線位置：${(indicators?.ma_position || []).join("｜")}
RSI：${indicators?.rsi}  MACD柱：${indicators?.macd_hist}  月KD K=${indicators?.month_k}
52週高：${indicators?.high_52w}（距高點${pctFrom52High}%）  52週低：${indicators?.low_52w}（距低點+${pctFrom52Low}%）
${valStr}
${monthly_revenue ? `月營收年增率：${monthly_revenue.yoy}%  月增率：${monthly_revenue.mom}%` : ""}
多方${signal?.bullScore}  空方${signal?.bearScore}  ${signal?.summary}

只輸出以下 JSON，不要其他文字，所有字串值不含雙引號或換行符號：
{
  "verdict": "buy",
  "verdict_label": "可分批布局",
  "score": 72,
  "entry_quality": "good",
  "entry_label": "現在適合進場",
  "stop_loss": 260,
  "target_6m": 340,
  "target_12m": 390,
  "batches": [
    {"batch": 1, "ratio": "30%", "price_low": 275, "price_high": 285, "trigger": "現價附近MA20支撐"},
    {"batch": 2, "ratio": "40%", "price_low": 260, "price_high": 270, "trigger": "回測MA60支撐"},
    {"batch": 3, "ratio": "30%", "price_low": 245, "price_high": 255, "trigger": "跌至MA120強支撐"}
  ],
  "checklist": [
    {"item": "均線排列", "status": "pass", "note": "完整多頭排列"},
    {"item": "乖離率", "status": "pass", "note": "MA20乖離3%合理"},
    {"item": "MACD動能", "status": "pass", "note": "柱狀翻正"},
    {"item": "月KD", "status": "warn", "note": "K值79偏高留意"},
    {"item": "RSI", "status": "pass", "note": "65中性偏強"},
    {"item": "年線支撐", "status": "pass", "note": "站上年線"},
    {"item": "距52週高點", "status": "warn", "note": "距高點-8%"},
    {"item": "估值", "status": "pass", "note": "P/E合理"}
  ],
  "bias_warning": null,
  "reason": "均線多頭排列MACD翻正長線結構健康",
  "risk_factors": ["月KD偏高短線有回檔", "大盤系統風險"],
  "catalysts": ["站上所有均線", "MACD持續翻正"],
  "risk": "medium",
  "wait_for": null
}

以上是格式示例，請依實際數據填入。batches 給3批分批進場計劃，每批有比例/價格區間/觸發條件。
verdict：buy/watch/avoid  status：pass/warn/fail  risk：low/medium/high  entry_quality：excellent/good/fair/poor`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return res.status(500).json({ error: `AI API 錯誤 ${r.status}` });

    const json = await r.json();
    let text = (json.content?.[0]?.text || "")
      .replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1) return res.status(500).json({ error: "AI 未回傳 JSON", raw: text.slice(0, 200) });

    let jsonStr = text.slice(s, e + 1)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/,(\s*[}\]])/g, "$1");

    try { return res.status(200).json(JSON.parse(jsonStr)); }
    catch(_) {
      jsonStr = jsonStr.replace(/\r\n/g," ").replace(/\r/g," ").replace(/\n/g," ")
        .replace(/,(\s*[}\]])/g, "$1");
      try { return res.status(200).json(JSON.parse(jsonStr)); }
      catch(e2) { return res.status(500).json({ error: "JSON 解析失敗: " + e2.message }); }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
