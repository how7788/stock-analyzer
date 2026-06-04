// api/analyze.js — 純資料版（快速）
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
  if (json.status !== 200) throw new Error(`FinMind 錯誤: ${json.msg}`);
  return json.data || [];
}

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    const s = arr.slice(i - period + 1, i + 1).reduce((a, v) => a + v, 0) / period;
    return Math.round(s * 100) / 100;
  });
}

function ema(arr, period) {
  const k = 2 / (period + 1);
  const r = new Array(arr.length).fill(null);
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
  for (let i = 1; i <= period; i++) { const d = prices[i] - prices[i-1]; if (d >= 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    ag = (ag*(period-1) + (d>=0?d:0)) / period;
    al = (al*(period-1) + (d<0?-d:0)) / period;
  }
  return al === 0 ? 100 : Math.round((100 - 100/(1 + ag/al)) * 100) / 100;
}

function calcKD(highs, lows, closes, period = 9) {
  const k = [], d = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { k.push(null); d.push(null); continue; }
    const hh = Math.max(...highs.slice(i-period+1, i+1));
    const ll = Math.min(...lows.slice(i-period+1, i+1));
    const rsv = hh === ll ? 50 : (closes[i]-ll)/(hh-ll)*100;
    const pk = k.length > 0 && k[k.length-1] != null ? k[k.length-1] : 50;
    const pd = d.length > 0 && d[d.length-1] != null ? d[d.length-1] : 50;
    const kv = Math.round((pk*2/3 + rsv/3)*100)/100;
    const dv = Math.round((pd*2/3 + kv/3)*100)/100;
    k.push(kv); d.push(dv);
  }
  return { k, d };
}

function toMonthly(daily) {
  const m = {};
  for (const d of daily) {
    const ym = d.date.slice(0, 7);
    if (!m[ym]) m[ym] = { date:ym, open:parseFloat(d.open), high:parseFloat(d.max), low:parseFloat(d.min), close:parseFloat(d.close) };
    else { m[ym].high = Math.max(m[ym].high, parseFloat(d.max)); m[ym].low = Math.min(m[ym].low, parseFloat(d.min)); m[ym].close = parseFloat(d.close); }
  }
  return Object.values(m).sort((a,b) => a.date.localeCompare(b.date));
}

function generateSignal(price, ma20, ma60, ma120, ma240, rsi, macdHist, monthK) {
  const signals = [];
  let bull = 0, bear = 0;
  if (ma240) {
    if (price > ma240) { signals.push({type:'bullish', text:`現價站上年線 ${ma240}，長線結構健康`}); bull+=2; }
    else { signals.push({type:'bearish', text:`現價跌破年線 ${ma240}，長線趨勢偏弱`}); bear+=2; }
  }
  if (ma60 && ma120) {
    if (ma60 > ma120) { signals.push({type:'bullish', text:`季線 ${ma60} > 半年線 ${ma120}，中期多頭排列`}); bull++; }
    else { signals.push({type:'bearish', text:`季線 ${ma60} < 半年線 ${ma120}，中期空頭排列`}); bear++; }
  }
  if (macdHist != null) {
    if (macdHist > 0) { signals.push({type:'bullish', text:`MACD 柱狀圖翻正，動能偏多`}); bull++; }
    else if (macdHist < 0) { signals.push({type:'bearish', text:`MACD 柱狀圖為負，動能偏空`}); bear++; }
    else signals.push({type:'neutral', text:`MACD 柱狀圖接近零軸`});
  }
  if (monthK != null) {
    if (monthK < 20) { signals.push({type:'bullish', text:`月KD K值 ${monthK} 低檔，中長期超賣訊號`}); bull+=2; }
    else if (monthK > 80) { signals.push({type:'bearish', text:`月KD K值 ${monthK} 高檔，留意中長期壓力`}); bear++; }
    else signals.push({type:'neutral', text:`月KD K值 ${monthK}，位於中性區間`});
  }
  if (rsi != null) {
    if (rsi < 40) { signals.push({type:'bullish', text:`RSI ${rsi} 偏低，有回升空間`}); bull++; }
    else if (rsi > 70) { signals.push({type:'bearish', text:`RSI ${rsi} 偏高，短線注意`}); bear++; }
  }
  let overall = 'neutral', summary = '中性觀望，尚無明確進場訊號';
  if (bull >= 4) { overall='bullish'; summary='多項指標偏多，中長期布局機會較佳'; }
  else if (bull > bear) { overall='bullish'; summary='偏多格局，可考慮分批佈局'; }
  else if (bear >= 4) { overall='bearish'; summary='多項指標偏空，建議等待落底訊號'; }
  else if (bear > bull) { overall='bearish'; summary='偏空格局，建議觀望或減碼'; }
  return { overall, summary, signals, bullScore:bull, bearScore:bear };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id } = req.query;
  if (!stock_id) return res.status(400).json({ error: "請提供 stock_id 參數" });

  try {
    const raw = await finmindFetch("TaiwanStockPrice", stock_id, daysAgo(420));
    if (!raw || raw.length === 0) return res.status(404).json({ error: `查無股票代號 ${stock_id}` });

    raw.sort((a,b) => a.date.localeCompare(b.date));
    const latest = raw[raw.length-1];
    const closes = raw.map(d => parseFloat(d.close));
    const highs = raw.map(d => parseFloat(d.max));
    const lows = raw.map(d => parseFloat(d.min));
    const n = closes.length;

    const ma5 = sma(closes,5), ma20 = sma(closes,20);
    const ma60 = sma(closes,60), ma120 = sma(closes,120), ma240 = sma(closes,240);
    const { ml, sl, hist } = calcMACD(closes);
    const rsi = calcRSI(closes.slice(-50));

    const monthly = toMonthly(raw);
    const { k:mk, d:md } = calcKD(monthly.map(d=>d.high), monthly.map(d=>d.low), monthly.map(d=>d.close), 9);
    const monthK = mk[mk.length-1], monthD = md[md.length-1];

    const prev = closes[n-2];
    const changePct = prev ? Math.round((closes[n-1]-prev)/prev*10000)/100 : null;
    const last252 = closes.slice(-252);

    // 本益比（平行抓，不 block 主流程）
    let valuation = null;
    try {
      const perRaw = await finmindFetch("TaiwanStockPER", stock_id, daysAgo(10));
      if (perRaw && perRaw.length > 0) {
        // FinMind 欄位：PER, PBR, dividend_yield
        const last = perRaw[perRaw.length-1];
        console.log("PER sample:", JSON.stringify(last)); // debug
        valuation = {
          date: last.date,
          per: last.PER != null ? Math.round(last.PER*10)/10 : null,
          pbr: last.PBR != null ? Math.round(last.PBR*100)/100 : null,
          yield: last.dividend_yield != null ? Math.round(last.dividend_yield*100)/100 : null,
          raw: last, // 回傳原始讓前端 debug
        };
      }
    } catch(e) { console.log("PER error:", e.message); }

    // 月營收
    let monthly_revenue = null;
    try {
      const revRaw = await finmindFetch("TaiwanStockMonthRevenue", stock_id, daysAgo(90));
      if (revRaw && revRaw.length > 0) {
        revRaw.sort((a,b) => a.date.localeCompare(b.date));
        const last = revRaw[revRaw.length-1];
        const prev2 = revRaw.length >= 2 ? revRaw[revRaw.length-2] : null;
        monthly_revenue = {
          date: last.date, revenue: last.revenue,
          yoy: last.revenue_year_over_year ?? null,
          mom: prev2 ? Math.round((last.revenue-prev2.revenue)/prev2.revenue*10000)/100 : null,
        };
      }
    } catch(_) {}

    const maPos = [];
    const p = closes[n-1];
    if (ma60[n-1]) maPos.push(p > ma60[n-1] ? '站上季線' : '跌破季線');
    if (ma120[n-1]) maPos.push(p > ma120[n-1] ? '站上半年線' : '跌破半年線');
    if (ma240[n-1]) maPos.push(p > ma240[n-1] ? '站上年線' : '跌破年線');

    const indicators = {
      ma5:ma5[n-1], ma20:ma20[n-1], ma60:ma60[n-1], ma120:ma120[n-1], ma240:ma240[n-1],
      rsi, macd_line:ml[n-1], macd_signal:sl[n-1], macd_hist:hist[n-1],
      month_k:monthK, month_d:monthD,
      high_52w:Math.max(...last252), low_52w:Math.min(...last252), ma_position:maPos,
    };

    const signal = generateSignal(p, ma20[n-1], ma60[n-1], ma120[n-1], ma240[n-1], rsi, hist[n-1], monthK);

    const history = raw.slice(-60).map((d,i) => {
      const idx = n-60+i;
      return { date:d.date, close:parseFloat(d.close), volume:parseInt(d.Trading_Volume||0),
        ma20:ma20[idx], ma60:ma60[idx], ma240:ma240[idx],
        macd:ml[idx], macd_signal:sl[idx], macd_hist:hist[idx] };
    });

    return res.status(200).json({
      stock_id, name:latest.stock_name||stock_id, updated:latest.date,
      price:{ close:p, open:parseFloat(latest.open), high:parseFloat(latest.max),
              low:parseFloat(latest.min), volume:parseInt(latest.Trading_Volume||0), change_percent:changePct },
      indicators, signal, valuation, monthly_revenue, history,
    });
  } catch(err) {
    console.error("[analyze]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
