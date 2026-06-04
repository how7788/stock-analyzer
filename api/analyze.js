// api/analyze.js — 中長期版本
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

// 簡單移動平均
function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return Math.round(slice.reduce((s, v) => s + v, 0) / period * 100) / 100;
  });
}

// EMA
function ema(arr, period) {
  const k = 2 / (period + 1);
  const result = new Array(arr.length).fill(null);
  let start = 0;
  while (start < arr.length && arr[start] == null) start++;
  if (start + period - 1 >= arr.length) return result;
  result[start + period - 1] = arr.slice(start, start + period).reduce((s, v) => s + v, 0) / period;
  for (let i = start + period; i < arr.length; i++) {
    result[i] = arr[i] * k + result[i - 1] * (1 - k);
  }
  return result.map(v => v != null ? Math.round(v * 100) / 100 : null);
}

// MACD
function calcMACD(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null
      ? Math.round((ema12[i] - ema26[i]) * 100) / 100
      : null
  );
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine.map((v, i) =>
    v != null && signalLine[i] != null
      ? Math.round((v - signalLine[i]) * 100) / 100
      : null
  );
  return { macdLine, signalLine, histogram };
}

// RSI
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
}

// KD Stochastic（月K用月線資料）
function calcKD(highs, lows, closes, period = 9) {
  const k = [], d = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { k.push(null); d.push(null); continue; }
    const sliceH = highs.slice(i - period + 1, i + 1);
    const sliceL = lows.slice(i - period + 1, i + 1);
    const hh = Math.max(...sliceH);
    const ll = Math.min(...sliceL);
    const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
    const prevK = k.length > 0 && k[k.length - 1] != null ? k[k.length - 1] : 50;
    const prevD = d.length > 0 && d[d.length - 1] != null ? d[d.length - 1] : 50;
    const kVal = Math.round((prevK * 2 / 3 + rsv / 3) * 100) / 100;
    const dVal = Math.round((prevD * 2 / 3 + kVal / 3) * 100) / 100;
    k.push(kVal); d.push(dVal);
  }
  return { k, d };
}

// 把日線資料轉成月線
function toMonthly(daily) {
  const monthly = {};
  for (const d of daily) {
    const ym = d.date.slice(0, 7);
    if (!monthly[ym]) monthly[ym] = { date: ym, open: parseFloat(d.open), high: parseFloat(d.max), low: parseFloat(d.min), close: parseFloat(d.close) };
    else {
      monthly[ym].high = Math.max(monthly[ym].high, parseFloat(d.max));
      monthly[ym].low = Math.min(monthly[ym].low, parseFloat(d.min));
      monthly[ym].close = parseFloat(d.close);
    }
  }
  return Object.values(monthly).sort((a, b) => a.date.localeCompare(b.date));
}

// 判斷MA位置
function maPosition(price, ma60, ma120, ma240) {
  const levels = [];
  if (ma60) levels.push(price > ma60 ? '站上季線' : '跌破季線');
  if (ma120) levels.push(price > ma120 ? '站上半年線' : '跌破半年線');
  if (ma240) levels.push(price > ma240 ? '站上年線' : '跌破年線');
  return levels;
}

// 綜合訊號（中長期版）
function generateSignal(price, ma20, ma60, ma120, ma240, rsi, macd, monthKD) {
  const signals = [];
  let bullScore = 0, bearScore = 0;

  // 均線位置（權重較高）
  if (ma240) {
    if (price > ma240) { signals.push({ type: 'bullish', text: `現價 ${price} 站上年線 ${ma240}，長線結構健康` }); bullScore += 2; }
    else { signals.push({ type: 'bearish', text: `現價跌破年線 ${ma240}，長線趨勢偏弱` }); bearScore += 2; }
  }
  if (ma60 && ma120) {
    if (ma60 > ma120) { signals.push({ type: 'bullish', text: `季線 ${ma60} > 半年線 ${ma120}，中期多頭排列` }); bullScore++; }
    else { signals.push({ type: 'bearish', text: `季線 ${ma60} < 半年線 ${ma120}，中期空頭排列` }); bearScore++; }
  }

  // MACD
  if (macd.histogram != null) {
    if (macd.histogram > 0 && macd.macd > 0) { signals.push({ type: 'bullish', text: `MACD 柱狀圖為正，動能偏多` }); bullScore++; }
    else if (macd.histogram < 0 && macd.macd < 0) { signals.push({ type: 'bearish', text: `MACD 柱狀圖為負，動能偏空` }); bearScore++; }
    else { signals.push({ type: 'neutral', text: `MACD 訊號中性，等待方向確立` }); }
  }

  // 月KD
  if (monthKD && monthKD.k != null) {
    if (monthKD.k < 20) { signals.push({ type: 'bullish', text: `月KD K值 ${monthKD.k} 低檔，中長期超賣` }); bullScore += 2; }
    else if (monthKD.k > 80) { signals.push({ type: 'bearish', text: `月KD K值 ${monthKD.k} 高檔，中長期超買` }); bearScore++; }
    else { signals.push({ type: 'neutral', text: `月KD K值 ${monthKD.k}，位於中性區間` }); }
  }

  // RSI
  if (rsi != null) {
    if (rsi < 40) { signals.push({ type: 'bullish', text: `RSI ${rsi} 偏低，有回升空間` }); bullScore++; }
    else if (rsi > 70) { signals.push({ type: 'bearish', text: `RSI ${rsi} 偏高，短線注意` }); bearScore++; }
  }

  let overall = 'neutral', summary = '中性觀望，尚無明確進場訊號';
  if (bullScore >= 4) { overall = 'bullish'; summary = '多項指標偏多，中長期布局機會較佳'; }
  else if (bullScore > bearScore) { overall = 'bullish'; summary = '偏多格局，可考慮分批佈局'; }
  else if (bearScore >= 4) { overall = 'bearish'; summary = '多項指標偏空，建議等待落底訊號'; }
  else if (bearScore > bullScore) { overall = 'bearish'; summary = '偏空格局，建議觀望或減碼'; }

  return { overall, summary, signals, bullScore, bearScore };
}

// AI 中長期買入區間
async function getAIBuyZone(stockData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const { stock_id, name, price, indicators, signal, valuation, monthly_revenue } = stockData;

  const prompt = `你是專注中長期價值投資的台股分析師。請根據以下技術面與基本面數據，評估當前是否為好的中長期買入時機，只回傳 JSON 不要其他文字：

股票：${name}（${stock_id}）
現價：${price.close}
52週高：${indicators.high_52w} / 低：${indicators.low_52w}
均線：MA20=${indicators.ma20} MA60=${indicators.ma60} MA120=${indicators.ma120} MA240=${indicators.ma240}
MACD：${indicators.macd_line} / Signal：${indicators.macd_signal} / 柱：${indicators.macd_hist}
RSI(14)：${indicators.rsi}
月KD：K=${indicators.month_k} D=${indicators.month_d}
${valuation ? `本益比(PER)：${valuation.per} / 股價淨值比(PBR)：${valuation.pbr} / 殖利率：${valuation.yield}%` : ''}
${monthly_revenue ? `最新月營收年增率：${monthly_revenue.yoy}%` : ''}
訊號評分：多方 ${signal.bullScore} / 空方 ${signal.bearScore}
綜合判斷：${signal.summary}

請給出中長期（3-12個月）的買入建議：
{
  "entry_quality": "excellent" | "good" | "fair" | "poor",
  "entry_label": "現在是否好買點（10字內）",
  "buy_low": 建議買入下緣（數字）,
  "buy_high": 建議買入上緣（數字）,
  "stop_loss": 中長期停損價（數字）,
  "target_6m": 6個月目標價（數字）,
  "target_12m": 12個月目標價（數字）,
  "strategy": "建議操作策略（60字內，例如分批買入方式）",
  "reason": "中長期看多/看空的核心理由（50字內）",
  "risk": "low" | "medium" | "high",
  "wait_for": "若現在不是好時機，等什麼條件才進場（30字，若現在是好時機填null）"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const text = json.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請提供 stock_id 參數" });

  try {
    // 拉 400 天日線（計算年線 MA240 需要）
    const raw = await finmindFetch("TaiwanStockPrice", stock_id, daysAgo(420));
    if (!raw || raw.length === 0) return res.status(404).json({ error: `查無股票代號 ${stock_id}` });

    raw.sort((a, b) => a.date.localeCompare(b.date));
    const latest = raw[raw.length - 1];
    const closes = raw.map(d => parseFloat(d.close));
    const highs = raw.map(d => parseFloat(d.max));
    const lows = raw.map(d => parseFloat(d.min));

    // 均線
    const ma5arr = sma(closes, 5);
    const ma20arr = sma(closes, 20);
    const ma60arr = sma(closes, 60);
    const ma120arr = sma(closes, 120);
    const ma240arr = sma(closes, 240);
    const n = closes.length;

    const latestMa5 = ma5arr[n-1];
    const latestMa20 = ma20arr[n-1];
    const latestMa60 = ma60arr[n-1];
    const latestMa120 = ma120arr[n-1];
    const latestMa240 = ma240arr[n-1];

    // MACD
    const { macdLine, signalLine, histogram } = calcMACD(closes);
    const latestMACD = { macd: macdLine[n-1], signal: signalLine[n-1], histogram: histogram[n-1] };

    // RSI
    const rsi = calcRSI(closes.slice(-50));

    // 月KD
    const monthly = toMonthly(raw);
    const mCloses = monthly.map(d => d.close);
    const mHighs = monthly.map(d => d.high);
    const mLows = monthly.map(d => d.low);
    const { k: mkArr, d: mdArr } = calcKD(mHighs, mLows, mCloses, 9);
    const monthKD = { k: mkArr[mkArr.length-1], d: mdArr[mdArr.length-1] };

    // 漲跌
    const prev = n >= 2 ? closes[n-2] : null;
    const changePercent = prev ? Math.round((closes[n-1] - prev) / prev * 10000) / 100 : null;

    // 52週高低
    const last252 = closes.slice(-252);
    const high52 = Math.max(...last252);
    const low52 = Math.min(...last252);

    // 估值（本益比/殖利率）
    let valuation = null;
    try {
      const perData = await finmindFetch("TaiwanStockPER", stock_id, daysAgo(30));
      if (perData && perData.length > 0) {
        const lastPer = perData[perData.length - 1];
        valuation = {
          per: lastPer.PER != null ? Math.round(lastPer.PER * 10) / 10 : null,
          pbr: lastPer.PBR != null ? Math.round(lastPer.PBR * 100) / 100 : null,
          yield: lastPer.dividend_yield != null ? Math.round(lastPer.dividend_yield * 100) / 100 : null,
          date: lastPer.date,
        };
      }
    } catch (_) {}

    // 月營收
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
          mom: prev2 ? Math.round((last.revenue - prev2.revenue) / prev2.revenue * 10000) / 100 : null,
        };
      }
    } catch (_) {}

    const price = {
      close: closes[n-1], open: parseFloat(latest.open),
      high: parseFloat(latest.max), low: parseFloat(latest.min),
      volume: parseInt(latest.Trading_Volume || 0),
      change_percent: changePercent,
    };

    const indicators = {
      ma5: latestMa5, ma20: latestMa20,
      ma60: latestMa60, ma120: latestMa120, ma240: latestMa240,
      rsi,
      macd_line: latestMACD.macd, macd_signal: latestMACD.signal, macd_hist: latestMACD.histogram,
      month_k: monthKD.k, month_d: monthKD.d,
      high_52w: high52, low_52w: low52,
      ma_position: maPosition(closes[n-1], latestMa60, latestMa120, latestMa240),
    };

    const signal = generateSignal(closes[n-1], latestMa20, latestMa60, latestMa120, latestMa240, rsi, latestMACD, monthKD);

    // 近60日歷史給圖表
    const history = raw.slice(-60).map((d, i, arr) => {
      const idx = n - 60 + i;
      return {
        date: d.date, close: parseFloat(d.close),
        volume: parseInt(d.Trading_Volume || 0),
        ma20: ma20arr[idx], ma60: ma60arr[idx], ma240: ma240arr[idx],
        macd: macdLine[idx], macd_signal: signalLine[idx], macd_hist: histogram[idx],
      };
    });

    const stockData = {
      stock_id, name: latest.stock_name || stock_id,
      updated: latest.date, price, indicators, signal,
      valuation, monthly_revenue, history,
    };

    const buy_zone = await getAIBuyZone(stockData);
    return res.status(200).json({ ...stockData, buy_zone });

  } catch (err) {
    console.error("[analyze] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
