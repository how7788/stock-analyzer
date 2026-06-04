// api/ai-zone.js — 直接明確版（個人使用，去除過度合規）
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

  // 計算乖離率
  const biasMA20 = indicators?.ma20 ? Math.round(((price?.close - indicators.ma20) / indicators.ma20) * 10000) / 100 : null;
  const biasMA60 = indicators?.ma60 ? Math.round(((price?.close - indicators.ma60) / indicators.ma60) * 10000) / 100 : null;

  // 距離52週高低點百分比
  const pctFrom52High = indicators?.high_52w ? Math.round(((price?.close - indicators.high_52w) / indicators.high_52w) * 10000) / 100 : null;
  const pctFrom52Low = indicators?.low_52w ? Math.round(((price?.close - indicators.low_52w) / indicators.low_52w) * 10000) / 100 : null;

  const maArr = (() => {
    const { ma20, ma60, ma120 } = indicators || {};
    if (ma20 && ma60 && ma120) {
      if (ma20 > ma60 && ma60 > ma120) return "多頭排列（MA20>MA60>MA120）";
      if (ma20 < ma60 && ma60 < ma120) return "空頭排列（MA20<MA60<MA120）";
      return "均線糾結";
    }
    return "資料不足";
  })();

  const valStr = valuation
    ? `P/E=${valuation.per ?? "N/A"}  P/B=${valuation.pbr ?? "N/A"}  殖利率=${valuation.yield ?? "N/A"}%`
    : "估值資料無";

  const prompt = `你是一位專門做台股/美股中長期趨勢投資的分析師，給自己用的分析報告，不需要過度保守。請根據以下數據，直接給出明確操作判斷。

=== 基本資料 ===
股票：${name}（${stock_id}）｜${isUS ? "美股" : "台股"}｜現價：${price?.close} ${cur}
漲跌：${price?.change_percent}%

=== 均線技術面 ===
MA20=${indicators?.ma20}  MA60=${indicators?.ma60}  MA120=${indicators?.ma120}  MA240=${indicators?.ma240}
均線排列：${maArr}
現價乖離 MA20：${biasMA20}%  乖離 MA60：${biasMA60}%
均線位置：${(indicators?.ma_position || []).join("｜")}

=== 動能指標 ===
RSI(14)：${indicators?.rsi}
MACD 柱狀：${indicators?.macd_hist}  DIF：${indicators?.macd_line}  DEA：${indicators?.macd_signal}
月KD：K=${indicators?.month_k}  D=${indicators?.month_d}

=== 位置評估 ===
52週高：${indicators?.high_52w}（距高點 ${pctFrom52High}%）
52週低：${indicators?.low_52w}（距低點 +${pctFrom52Low}%）

=== 基本面 ===
${valStr}
${monthly_revenue ? `月營收年增率：${monthly_revenue.yoy}%  月增率：${monthly_revenue.mom}%` : "月營收：無資料"}

=== 訊號 ===
多方${signal?.bullScore} 空方${signal?.bearScore}｜${signal?.summary}

=== 判斷規則 ===
- 乖離 MA60 超過 +10% 要標記追高風險
- 月KD > 80 高檔超買要提醒
- 均線多頭排列才適合多方佈局
- 給出具體的分批買入價位
- 明確說是否適合現在進場

請只輸出以下 JSON，不要其他任何文字：
{
  "verdict": "buy",
  "verdict_label": "可分批布局",
  "score": 72,
  "entry_quality": "good",
  "entry_label": "現在適合進場",
  "buy_low": 280,
  "buy_high": 300,
  "stop_loss": 260,
  "target_6m": 340,
  "target_12m": 390,
  "checklist": [
    {"item": "均線排列", "status": "pass", "note": "完整多頭排列"},
    {"item": "乖離率", "status": "pass", "note": "MA20乖離3%合理"},
    {"item": "MACD動能", "status": "pass", "note": "柱狀翻正"},
    {"item": "月KD位置", "status": "warn", "note": "K值79偏高留意"},
    {"item": "RSI", "status": "pass", "note": "65中性偏強"},
    {"item": "年線支撐", "status": "pass", "note": "站上年線"},
    {"item": "距52週高點", "status": "warn", "note": "距高點-8%"},
    {"item": "估值", "status": "pass", "note": "P/E合理"}
  ],
  "bias_warning": null,
  "strategy": "可在MA20附近分三批買入，第一批3成，等回測MA20再加",
  "reason": "均線多頭排列，MACD翻正，長線結構健康",
  "risk_factors": ["月KD偏高短線有回檔風險", "大盤系統風險"],
  "catalysts": ["站上所有均線", "MACD持續翻正"],
  "risk": "medium",
  "wait_for": null
}

以上是格式示例，請依實際數據填入，給出明確的操作建議。
verdict：buy=適合進場，watch=等待機會，avoid=避開
status：pass=滿足，warn=注意，fail=不滿足
entry_quality：excellent/good/fair/poor
risk：low/medium/high
所有字串不得含雙引號`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return res.status(500).json({ error: `AI API 錯誤 ${r.status}` });

    const json = await r.json();
    let text = json.content?.[0]?.text || "";
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return res.status(500).json({ error: "AI 未回傳 JSON", raw: text.slice(0, 200) });

    let jsonStr = text.slice(start, end + 1)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/,(\s*[}\]])/g, "$1");

    try {
      return res.status(200).json(JSON.parse(jsonStr));
    } catch(e1) {
      jsonStr = jsonStr.replace(/"note"\s*:\s*"([^"]*)"/g, (m, v) =>
        `"note":"${v.replace(/[\n\r"]/g, " ").trim()}"`
      );
      try {
        return res.status(200).json(JSON.parse(jsonStr));
      } catch(e2) {
        return res.status(500).json({ error: "JSON 解析失敗: " + e2.message, raw: jsonStr.slice(0, 300) });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
