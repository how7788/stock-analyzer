// api/ai-zone.js — 決策儀表盤版（參考 daily_stock_analysis 設計）
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

  // 計算乖離率（判斷是否追高）
  const biasFromMa20 = indicators?.ma20
    ? Math.round(((price?.close - indicators.ma20) / indicators.ma20) * 10000) / 100
    : null;
  const biasFromMa60 = indicators?.ma60
    ? Math.round(((price?.close - indicators.ma60) / indicators.ma60) * 10000) / 100
    : null;

  // 判斷均線多頭/空頭排列
  const maArrangement = (() => {
    const { ma20, ma60, ma120 } = indicators || {};
    if (ma20 && ma60 && ma120) {
      if (ma20 > ma60 && ma60 > ma120) return "多頭排列（MA20 > MA60 > MA120）";
      if (ma20 < ma60 && ma60 < ma120) return "空頭排列（MA20 < MA60 < MA120）";
      return "均線糾結，方向不明";
    }
    return "資料不足";
  })();

  const valStr = valuation
    ? `本益比(P/E)：${valuation.per ?? "—"} / 股價淨值比(P/B)：${valuation.pbr ?? "—"} / 殖利率：${valuation.yield ?? "—"}%`
    : "估值資料暫無";

  const revenueStr = monthly_revenue
    ? `最新月營收年增率：${monthly_revenue.yoy}%，月增率：${monthly_revenue.mom}%`
    : "";

  const prompt = `你是一位專注中長期（3～12個月）價值投資的分析師，擅長台股與美股。
請根據以下數據，輸出「決策儀表盤」格式的分析報告，只回傳 JSON，不要其他文字。

=== 股票資訊 ===
股票：${name}（${stock_id}）｜市場：${isUS ? "美股" : "台股"}｜幣別：${cur}
現價：${price?.close} ${cur}
今日：開 ${price?.open} / 高 ${price?.high} / 低 ${price?.low}
漲跌幅：${price?.change_percent}%｜成交量：${price?.volume?.toLocaleString()}

=== 均線技術面 ===
MA20：${indicators?.ma20}｜MA60：${indicators?.ma60}｜MA120：${indicators?.ma120}｜MA240：${indicators?.ma240}
均線排列：${maArrangement}
現價 vs MA20 乖離率：${biasFromMa20 != null ? biasFromMa20 + "%" : "—"}
現價 vs MA60 乖離率：${biasFromMa60 != null ? biasFromMa60 + "%" : "—"}
均線位置：${(indicators?.ma_position || []).join("、") || "—"}
52週高：${indicators?.high_52w}｜52週低：${indicators?.low_52w}

=== 動能指標 ===
RSI(14)：${indicators?.rsi}
MACD 柱狀：${indicators?.macd_hist}｜DIF：${indicators?.macd_line}｜DEA：${indicators?.macd_signal}
月KD：K=${indicators?.month_k}｜D=${indicators?.month_d}

=== 基本面 ===
${valStr}
${revenueStr}

=== 系統訊號 ===
多方訊號分數：${signal?.bullScore}｜空方訊號分數：${signal?.bearScore}
系統判斷：${signal?.summary}

=== 交易紀律規則（必須遵守）===
1. 乖離率超過 +8% 嚴禁追高，需標記風險
2. 均線多頭排列才考慮做多
3. 月KD > 80 高檔超買需謹慎
4. 必須給出精確買入價、停損價、目標價
5. 每項檢查條件必須明確標示「✅ 滿足」「⚠️ 注意」「❌ 不滿足」

請回傳以下 JSON 格式：
{
  "verdict": "buy" | "watch" | "avoid",
  "verdict_label": "核心結論（10字內，如：逢低分批佈局、等待回測支撐）",
  "score": 分析評分 0-100（整數）,
  "entry_quality": "excellent" | "good" | "fair" | "poor",
  "entry_label": "現在買點評估（8字內）",
  "buy_low": 建議買入下緣（數字）,
  "buy_high": 建議買入上緣（數字）,
  "stop_loss": 中長期停損價（數字）,
  "target_6m": 6個月目標價（數字）,
  "target_12m": 12個月目標價（數字）,
  "checklist": [
    {"item": "檢查項目名稱", "status": "pass" | "warn" | "fail", "note": "說明"},
    ...
  ],
  "bias_warning": 若乖離率超 8% 填入警告文字否則填 null,
  "strategy": "分批佈局操作策略（60字內）",
  "reason": "中長期核心理由（50字內）",
  "risk_factors": ["風險點1", "風險點2"],
  "catalysts": ["利多催化1", "利多催化2"],
  "risk": "low" | "medium" | "high",
  "wait_for": "若非好時機等什麼條件才進場（30字，是好時機填null）"
}

checklist 必須包含這些項目：
- 均線排列（多頭/空頭）
- 乖離率是否合理（不追高）
- MACD 動能方向
- 月KD 位置
- RSI 超買/超賣
- 年線支撐（站上/跌破）
- 估值合理性（若有資料）`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) return res.status(500).json({ error: `AI API 錯誤 ${r.status}` });

    const json = await r.json();
    const text = json.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "AI 回傳格式錯誤", raw: text.slice(0, 200) });

    return res.status(200).json(JSON.parse(match[0]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
