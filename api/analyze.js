// api/analyze.js — 台股技術分析（v3: +布林通道）
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
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
  if (json.status !== 200) throw new Error(`FinMind 錯誤: ${json.msg}`);
  return json.data || [];
}

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    return Math.round(arr.slice(i - period + 1, i + 1).reduce((a, v) => a + v, 0) / period * 100) / 100;
  });
}

function ema(arr, period) {
  const k = 2 / (period + 1), r = new Array(arr.length).fill(null);
  let st = 0;
  while (st < arr.length && arr[st] == null) st++;
  if (st + period - 1 >= arr.length) return r;
  r[st + period - 1] = arr.slice(st, st + period).reduce((a, v) => a + v, 0) / period;
  for (let i = st + period; i < arr.length; i++) r[i] = arr[i] * k + r[i - 1] * (1 - k);
  return r.map(v => v != null ? Math.round(v * 100) / 100 : null);
}

function calcMACD(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const ml = closes.map((_, i) => e12[i] != null && e26[i] != null ? Math.round((e12[i] - e26[i]) * 100) / 100 : null);
  const sl = ema(ml, 9);
  const hist = ml.map((v, i) => v != null && sl[i] != null ? Math.round((v - sl[i]) * 100) / 100 : null);
  return { ml, sl, hist };
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = prices[i] - prices[i - 1]; if (d >= 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
}

function calcKD(highs, lows, closes, period = 9) {
  const k = [], d = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { k.push(null); d.push(null); continue; }
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
    const pk = k.length > 0 && k[k.length - 1] != null ? k[k.length - 1] : 50;
    const pd = d.length > 0 && d[d.length - 1] != null ? d[d.length - 1] : 50;
    k.push(Math.round((pk * 2 / 3 + rsv / 3) * 100) / 100);
    d.push(Math.round((pd * 2 / 3 + k[k.length - 1] / 3) * 100) / 100);
  }
  return { k, d };
}

function calcBollinger(closes, period = 20) {
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, lower: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const mid = slice.reduce((a, v) => a + v, 0) / period;
    const std = Math.sqrt(slice.reduce((a, v) => a + Math.pow(v - mid, 2), 0) / period);
    return { upper: Math.round((mid + 2 * std) * 100) / 100, lower: Math.round((mid - 2 * std) * 100) / 100 };
  });
}

function toMonthly(daily) {
  const m = {};
  for (const d of daily) {
    const ym = d.date.slice(0, 7);
    if (!m[ym]) m[ym] = { date: ym, open: parseFloat(d.open), high: parseFloat(d.max), low: parseFloat(d.min), close: parseFloat(d.close) };
    else { m[ym].high = Math.max(m[ym].high, parseFloat(d.max)); m[ym].low = Math.min(m[ym].low, parseFloat(d.min)); m[ym].close = parseFloat(d.close); }
  }
  return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
}

function generateSignal(price, ma20, ma60, ma120, ma240, rsi, macdHist, monthK) {
  const signals = []; let bull = 0, bear = 0;
  if (ma240 != null) {
    if (price > ma240) { signals.push({ type: 'bullish', text: `現價站上年線（MA240=${ma240}），長線結構健康` }); bull += 2; }
    else { signals.push({ type: 'bearish', text: `現價跌破年線（MA240=${ma240}），長線趨勢偏弱` }); bear += 2; }
  }
  if (ma60 != null && ma120 != null) {
    if (ma60 > ma120) { signals.push({ type: 'bullish', text: `季線（MA60=${ma60}）> 半年線（MA120=${ma120}），中期多頭排列` }); bull++; }
    else { signals.push({ type: 'bearish', text: `季線（MA60=${ma60}）< 半年線（MA120=${ma120}），中期空頭排列` }); bear++; }
  }
  if (macdHist != null) {
    if (macdHist > 0) { signals.push({ type: 'bullish', text: `MACD 柱狀圖為正，動能偏多` }); bull++; }
    else if (macdHist < 0) { signals.push({ type: 'bearish', text: `MACD 柱狀圖為負，動能偏空` }); bear++; }
    else signals.push({ type: 'neutral', text: `MACD 柱狀圖接近零軸，方向待確認` });
  }
  if (monthK != null) {
    if (monthK < 20) { signals.push({ type: 'bullish', text: `月KD K值 ${monthK} 低檔，中長期超賣訊號` }); bull += 2; }
    else if (monthK > 80) { signals.push({ type: 'bearish', text: `月KD K值 ${monthK} 高檔，留意中長期壓力` }); bear++; }
    else signals.push({ type: 'neutral', text: `月KD K值 ${monthK}，位於中性區間` });
  }
  if (rsi != null) {
    if (rsi < 40) { signals.push({ type: 'bullish', text: `RSI ${rsi} 偏低，有回升空間` }); bull++; }
    else if (rsi > 70) signals.push({ type: 'bearish', text: `RSI ${rsi} 偏高，注意短線壓力` });
  }
  let overall = 'neutral', summary = '中性觀望，尚無明確進場訊號';
  if (bull >= 4) { overall = 'bullish'; summary = '多項指標偏多，中長期觀察機會較佳'; }
  else if (bull > bear) { overall = 'bullish'; summary = '偏多格局，可分批觀察佈局'; }
  else if (bear >= 4) { overall = 'bearish'; summary = '多項指標偏空，建議等待落底訊號'; }
  else if (bear > bull) { overall = 'bearish'; summary = '偏空格局，建議觀望'; }
  return { overall, summary, signals, bullScore: bull, bearScore: bear };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請輸入股票代號，例如 2330" });
  const cleanId = stock_id.trim();
  if (!/^\d{4,6}$/.test(cleanId)) return res.status(400).json({ error: `「${cleanId}」不是有效的台股代號` });

  try {
    const raw = await finmindFetch("TaiwanStockPrice", cleanId, daysAgo(420));
    if (!raw || raw.length === 0) return res.status(404).json({ error: `查無股票代號 ${cleanId}` });

    raw.sort((a, b) => a.date.localeCompare(b.date));
    const latest = raw[raw.length - 1];
    const closes = raw.map(d => parseFloat(d.close));
    const n = closes.length;

    const ma5arr  = sma(closes, 5),  ma20arr  = sma(closes, 20);
    const ma60arr = sma(closes, 60), ma120arr = sma(closes, 120), ma240arr = sma(closes, 240);
    const { ml, sl, hist } = calcMACD(closes);
    const rsi = calcRSI(closes.slice(-50));
    const bollingerArr = calcBollinger(closes);

    const monthly = toMonthly(raw);
    const { k: mk, d: md } = calcKD(monthly.map(d => d.high), monthly.map(d => d.low), monthly.map(d => d.close), 9);
    const monthK = mk[mk.length - 1], monthD = md[md.length - 1];

    const prev = closes[n - 2];
    const changePct = prev ? Math.round((closes[n - 1] - prev) / prev * 10000) / 100 : null;
    const last252 = closes.slice(-252);
    const p = closes[n - 1];

    const maPos = [];
    if (ma60arr[n-1]  != null) maPos.push(p > ma60arr[n-1]  ? `站上季線（${ma60arr[n-1]}）`   : `跌破季線（${ma60arr[n-1]}）`);
    if (ma120arr[n-1] != null) maPos.push(p > ma120arr[n-1] ? `站上半年線（${ma120arr[n-1]}）` : `跌破半年線（${ma120arr[n-1]}）`);
    if (ma240arr[n-1] != null) maPos.push(p > ma240arr[n-1] ? `站上年線（${ma240arr[n-1]}）`   : `跌破年線（${ma240arr[n-1]}）`);

    let valuation = null;
    let stockNameFromPer = null;
    try {
      const perRaw = await finmindFetch("TaiwanStockPER", cleanId, daysAgo(400));
      if (perRaw?.length > 0) {
        const last = perRaw[perRaw.length - 1];
        stockNameFromPer = last.stock_name || last.name || null;
        const pers = perRaw.map(d => d.PER).filter(v => v != null && v > 0);
        const perAvg = pers.length ? Math.round(pers.reduce((a,v) => a+v, 0) / pers.length * 10) / 10 : null;
        const perMin = pers.length ? Math.round(Math.min(...pers) * 10) / 10 : null;
        const perMax = pers.length ? Math.round(Math.max(...pers) * 10) / 10 : null;
        valuation = {
          date: last.date,
          per: last.PER != null ? Math.round(last.PER * 10) / 10 : null,
          pbr: last.PBR != null ? Math.round(last.PBR * 100) / 100 : null,
          yield: last.dividend_yield != null ? Math.round(last.dividend_yield * 100) / 100 : null,
          per_avg_1y: perAvg, per_min_1y: perMin, per_max_1y: perMax,
        };
      }
    } catch (_) {}

    // 若仍無股名，從 TaiwanStockInfo 補抓
    if (!stockNameFromPer) {
      try {
        const token = process.env.FINMIND_TOKEN;
        const infoRes = await fetch(`${FINMIND_BASE}?dataset=TaiwanStockInfo&data_id=${encodeURIComponent(cleanId)}&token=${token}`);
        if (infoRes.ok) {
          const infoJson = await infoRes.json();
          const infoData = infoJson.data || [];
          if (infoData.length > 0) stockNameFromPer = infoData[0].stock_name || infoData[0].name || null;
        }
      } catch (_) {}
    }

    let monthly_revenue = null;
    try {
      const revRaw = await finmindFetch("TaiwanStockMonthRevenue", cleanId, daysAgo(90));
      if (revRaw?.length > 0) {
        revRaw.sort((a, b) => a.date.localeCompare(b.date));
        const last = revRaw[revRaw.length - 1], prev2 = revRaw.length >= 2 ? revRaw[revRaw.length - 2] : null;
        monthly_revenue = { date: last.date, revenue: last.revenue, yoy: last.revenue_year_over_year ?? null, mom: prev2?.revenue ? Math.round((last.revenue - prev2.revenue) / prev2.revenue * 10000) / 100 : null };
      }
    } catch (_) {}

    // 股利資料
    let dividends = [];
    try {
      const divRaw = await finmindFetch("TaiwanStockDividend", cleanId, daysAgo(1200));
      if (divRaw?.length > 0) {
        dividends = divRaw.slice(-6).reverse().map(d => ({
          date: d.date,
          cash: d.cash_dividend != null ? Math.round(d.cash_dividend * 100) / 100 : null,
          stock: d.stock_dividend != null ? Math.round(d.stock_dividend * 100) / 100 : null,
          type: d.type || null,
        }));
      }
    } catch (_) {}

    const indicators = {
      ma5: ma5arr[n-1], ma20: ma20arr[n-1], ma60: ma60arr[n-1], ma120: ma120arr[n-1], ma240: ma240arr[n-1],
      rsi, macd_line: ml[n-1], macd_signal: sl[n-1], macd_hist: hist[n-1],
      month_k: monthK, month_d: monthD,
      high_52w: last252.length ? Math.max(...last252) : null,
      low_52w:  last252.length ? Math.min(...last252) : null,
      ma_position: maPos,
      boll_upper: bollingerArr[n-1]?.upper ?? null,
      boll_lower: bollingerArr[n-1]?.lower ?? null,
    };

    const signal = generateSignal(p, ma20arr[n-1], ma60arr[n-1], ma120arr[n-1], ma240arr[n-1], rsi, hist[n-1], monthK);

    // ★ history 維持 60 筆（避免 timeout），含布林通道
    const history = raw.slice(-60).map((d, i) => {
      const idx = n - 60 + i;
      return {
        date: d.date,
        close: parseFloat(d.close),
        volume: parseInt(d.Trading_Volume || 0),
        ma20:   idx >= 0 ? ma20arr[idx]  : null,
        ma60:   idx >= 0 ? ma60arr[idx]  : null,
        ma240:  idx >= 0 ? ma240arr[idx] : null,
        boll_upper: idx >= 0 ? (bollingerArr[idx]?.upper ?? null) : null,
        boll_lower: idx >= 0 ? (bollingerArr[idx]?.lower ?? null) : null,
        macd:        idx >= 0 ? ml[idx]   : null,
        macd_signal: idx >= 0 ? sl[idx]   : null,
        macd_hist:   idx >= 0 ? hist[idx] : null,
      };
    });

    return res.status(200).json({
      stock_id: cleanId, name: latest.stock_name || stockNameFromPer || cleanId,
      market: 'tw', updated: latest.date,
      data_note: '資料來源：FinMind，可能非即時報價',
      price: { close: p, open: parseFloat(latest.open), high: parseFloat(latest.max), low: parseFloat(latest.min), volume: parseInt(latest.Trading_Volume || 0), change_percent: changePct },
      indicators, signal, valuation, monthly_revenue, dividends, history,
    });
  } catch (err) {
    console.error("[analyze]", err.message);
    return res.status(500).json({ error: err.message || "資料暫時無法取得，請稍後再試" });
  }
};
