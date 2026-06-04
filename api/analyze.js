// api/analyze.js — Vercel Serverless Function (CommonJS)
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

async function finmindFetch(dataset, stockId, startDate) {
  const token = process.env.FINMIND_TOKEN;
  if (!token) throw new Error("FINMIND_TOKEN 未設定");
  const endDate = new Date().toISOString().split("T")[0];
  const url = `${FINMIND_BASE}?dataset=${dataset}&data_id=${encodeURIComponent(stockId)}&start_date=${startDate}&end_date=${endDate}&token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FinMind HTTP 錯誤: ${res.status}`);
  const json = await res.json();
  if (json.status !== 200) throw new Error(`FinMind 錯誤: ${json.msg || JSON.stringify(json)}`);
  return json.data || [];
}

function movingAverage(arr, field, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, d) => s + parseFloat(d[field] || 0), 0) / period;
    return Math.round(avg * 100) / 100;
  });
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
}

function generateSignal(ma5, ma20, rsi) {
  const signals = [];
  if (ma5 != null && ma20 != null) {
    if (ma5 > ma20) signals.push({ type: "bullish", text: `MA5(${ma5}) > MA20(${ma20})，短線偏多` });
    else signals.push({ type: "bearish", text: `MA5(${ma5}) < MA20(${ma20})，短線偏空` });
  }
  if (rsi != null) {
    if (rsi < 30) signals.push({ type: "bullish", text: `RSI ${rsi} 超賣區，留意反彈機會` });
    else if (rsi > 70) signals.push({ type: "bearish", text: `RSI ${rsi} 超買區，注意回檔風險` });
    else signals.push({ type: "neutral", text: `RSI ${rsi} 位於中性區間` });
  }
  const bull = signals.filter(s => s.type === "bullish").length;
  const bear = signals.filter(s => s.type === "bearish").length;
  let overall = "neutral", summary = "中性觀望，等待明確訊號";
  if (bull > bear) { overall = "bullish"; summary = "偏多格局，可關注買點"; }
  else if (bear > bull) { overall = "bearish"; summary = "偏空格局，建議謹慎操作"; }
  return { overall, summary, signals };
}

// AI 買入區間分析
async function getAIBuyZone(stockData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const { stock_id, name, price, indicators, signal, monthly_revenue } = stockData;

  const prompt = `你是台股技術分析師。根據以下數據，給出建議買入價位區間，只回傳 JSON，不要其他文字：

股票：${name}（${stock_id}）
現價：${price.close}
今日：開 ${price.open} / 高 ${price.high} / 低 ${price.low}
漲跌幅：${price.change_percent}%
成交量：${price.volume}
52週高：${indicators.high_52w} / 低：${indicators.low_52w}
MA5：${indicators.ma5} / MA20：${indicators.ma20}
RSI(14)：${indicators.rsi}
訊號：${signal.summary}
${monthly_revenue ? `月營收年增率：${monthly_revenue.yoy}%` : ''}

請根據技術面（支撐位、均線、RSI）給出：
{
  "buy_low": 建議買入下緣價（數字）,
  "buy_high": 建議買入上緣價（數字）,
  "stop_loss": 建議停損價（數字）,
  "target": 短線目標價（數字）,
  "reason": "簡短說明邏輯（50字內）",
  "risk": "low" | "medium" | "high"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const json = await res.json();
    const text = json.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請提供 stock_id 參數" });

  try {
    const raw = await finmindFetch("TaiwanStockPrice", stock_id, daysAgo(90));
    if (!raw || raw.length === 0) return res.status(404).json({ error: `查無股票代號 ${stock_id}` });

    raw.sort((a, b) => a.date.localeCompare(b.date));
    const latest = raw[raw.length - 1];
    const closes = raw.map(d => parseFloat(d.close));

    const ma5arr = movingAverage(raw, "close", 5);
    const ma20arr = movingAverage(raw, "close", 20);
    const rsi = calcRSI(closes);
    const latestMa5 = ma5arr[ma5arr.length - 1];
    const latestMa20 = ma20arr[ma20arr.length - 1];

    const prev = raw.length >= 2 ? parseFloat(raw[raw.length - 2].close) : null;
    const changePercent = prev
      ? Math.round(((parseFloat(latest.close) - prev) / prev) * 10000) / 100
      : null;

    const last252 = closes.slice(-252);
    const high52 = Math.max(...last252);
    const low52 = Math.min(...last252);
    const signal = generateSignal(latestMa5, latestMa20, rsi);

    let monthly_revenue = null;
    try {
      const revRaw = await finmindFetch("TaiwanStockMonthRevenue", stock_id, daysAgo(365));
      if (revRaw && revRaw.length > 0) {
        revRaw.sort((a, b) => a.date.localeCompare(b.date));
        const last = revRaw[revRaw.length - 1];
        const prev2 = revRaw.length >= 2 ? revRaw[revRaw.length - 2] : null;
        monthly_revenue = {
          date: last.date,
          revenue: last.revenue,
          yoy: last.revenue_year_over_year ?? null,
          mom: prev2 ? Math.round(((last.revenue - prev2.revenue) / prev2.revenue) * 10000) / 100 : null,
        };
      }
    } catch (_) {}

    const history = raw.slice(-30).map((d, i) => ({
      date: d.date,
      close: parseFloat(d.close),
      volume: parseInt(d.Trading_Volume || d.volume || 0),
      ma5: ma5arr[raw.length - 30 + i],
      ma20: ma20arr[raw.length - 30 + i],
    }));

    const stockData = {
      stock_id,
      name: latest.stock_name || stock_id,
      updated: latest.date,
      price: {
        close: parseFloat(latest.close),
        open: parseFloat(latest.open),
        high: parseFloat(latest.max),
        low: parseFloat(latest.min),
        volume: parseInt(latest.Trading_Volume || 0),
        change_percent: changePercent,
      },
      indicators: { ma5: latestMa5, ma20: latestMa20, rsi, high_52w: high52, low_52w: low52 },
      signal,
      monthly_revenue,
      history,
    };

    // 呼叫 AI 取得買入區間
    const buy_zone = await getAIBuyZone(stockData);

    return res.status(200).json({ ...stockData, buy_zone });

  } catch (err) {
    console.error("[analyze] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
