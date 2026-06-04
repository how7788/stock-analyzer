// api/ai-zone.js — 決策儀表盤版（強化 JSON 解析）
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

  const biasFromMa20 = indicators?.ma20
    ? Math.round(((price?.close - indicators.ma20) / indicators.ma20) * 10000) / 100 : null;
  const biasFromMa60 = indicators?.ma60
    ? Math.round(((price?.close - indicators.ma60) / indicators.ma60) * 10000) / 100 : null;

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
    ? `PE=${valuation.per ?? "N/A"} PB=${valuation.pbr ?? "N/A"} 殖利率=${valuation.yield ?? "N/A"}%`
    : "估值資料暫無";

  // 簡化 prompt，避免 AI 在 JSON 裡放危險字元
  const prompt = `你是台股/美股中長期投資分析師。根據以下數據輸出決策儀表盤。

股票：${name}(${stock_id}) 市場：${isUS?"美股":"台股"} 現價：${price?.close}${cur}
漲跌：${price?.change_percent}%
均線：MA20=${indicators?.ma20} MA60=${indicators?.ma60} MA120=${indicators?.ma120} MA240=${indicators?.ma240}
均線排列：${maArr}
乖離MA20：${biasFromMa20}% 乖離MA60：${biasFromMa60}%
均線位置：${(indicators?.ma_position||[]).join("/")}
RSI：${indicators?.rsi} MACD柱：${indicators?.macd_hist} 月KD K=${indicators?.month_k}
52週高：${indicators?.high_52w} 52週低：${indicators?.low_52w}
${valStr}
${monthly_revenue ? `月營收年增率：${monthly_revenue.yoy}%` : ""}
系統訊號：多方${signal?.bullScore} 空方${signal?.bearScore} 結論：${signal?.summary}

規則：乖離率>8%嚴禁追高；均線多頭才做多；月KD>80謹慎；給出精確買入/停損/目標價。

請嚴格只輸出下面的JSON，不要輸出其他任何文字，不要有markdown代碼塊：
{
  "verdict": "buy",
  "verdict_label": "逢低分批佈局",
  "score": 72,
  "entry_quality": "good",
  "entry_label": "現在是好買點",
  "buy_low": 280,
  "buy_high": 295,
  "stop_loss": 260,
  "target_6m": 330,
  "target_12m": 370,
  "checklist": [
    {"item": "均線排列", "status": "pass", "note": "多頭排列"},
    {"item": "乖離率合理", "status": "pass", "note": "未超買"},
    {"item": "MACD動能", "status": "pass", "note": "柱狀翻正"},
    {"item": "月KD位置", "status": "warn", "note": "K值偏高注意"},
    {"item": "RSI區間", "status": "pass", "note": "中性偏強"},
    {"item": "年線支撐", "status": "pass", "note": "站上年線"}
  ],
  "bias_warning": null,
  "strategy": "可於均線附近分三批買入",
  "reason": "長線結構健康均線多頭排列",
  "risk_factors": ["月KD偏高留意短線回檔", "大盤系統風險"],
  "catalysts": ["站上所有均線", "MACD動能偏多"],
  "risk": "medium",
  "wait_for": null
}

以上只是格式示例，請根據實際數據填入正確數值。
verdict只能是buy/watch/avoid三選一。
status只能是pass/warn/fail三選一。
risk只能是low/medium/high三選一。
entry_quality只能是excellent/good/fair/poor四選一。
所有字串值不得包含雙引號。`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) return res.status(500).json({ error: `AI API 錯誤 ${r.status}` });

    const json = await r.json();
    let text = json.content?.[0]?.text || "";

    // 移除 markdown 代碼塊
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // 提取最外層 JSON 物件
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "AI 未回傳 JSON", raw: text.slice(0, 200) });
    }
    let jsonStr = text.slice(start, end + 1);

    // 多重修復
    jsonStr = jsonStr
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // 危險控制字元
      .replace(/,(\s*[}\]])/g, "$1")                  // 尾部逗號
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')      // 沒引號的 key
      ;

    // 嘗試解析
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch(e1) {
      // 若失敗，嘗試只取 checklist 前的部分，單獨修復
      try {
        // 強制把 checklist 裡的 note 值清理
        jsonStr = jsonStr.replace(/"note"\s*:\s*"([^"]*?)"/g, (m, v) => {
          const clean = v.replace(/[\n\r"]/g, " ").trim();
          return `"note":"${clean}"`;
        });
        parsed = JSON.parse(jsonStr);
      } catch(e2) {
        return res.status(500).json({
          error: "JSON 解析失敗: " + e2.message,
          raw: jsonStr.slice(0, 400)
        });
      }
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
