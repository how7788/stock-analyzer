// api/market-analyze.js — 大盤技術分析（台灣加權指數 ^TWII）
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

const MARKETS = {
  twii: { symbol: "^TWII", name: "台灣加權指數", currency: "TWD" },
  spx:  { symbol: "^GSPC", name: "S&P 500",      currency: "USD" },
  ixic: { symbol: "^IXIC", name: "那斯達克",      currency: "USD" },
};

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    return Math.round(arr.slice(i-period+1, i+1).reduce((a,v)=>a+v,0)/period*100)/100;
  });
}
function ema(arr, period) {
  const k=2/(period+1), r=new Array(arr.length).fill(null);
  let st=0;
  while(st<arr.length&&arr[st]==null)st++;
  if(st+period-1>=arr.length)return r;
  r[st+period-1]=arr.slice(st,st+period).reduce((a,v)=>a+v,0)/period;
  for(let i=st+period;i<arr.length;i++)r[i]=arr[i]*k+r[i-1]*(1-k);
  return r.map(v=>v!=null?Math.round(v*100)/100:null);
}
function calcMACD(closes) {
  const e12=ema(closes,12),e26=ema(closes,26);
  const ml=closes.map((_,i)=>e12[i]!=null&&e26[i]!=null?Math.round((e12[i]-e26[i])*100)/100:null);
  const sl=ema(ml,9);
  const hist=ml.map((v,i)=>v!=null&&sl[i]!=null?Math.round((v-sl[i])*100)/100:null);
  return {ml,sl,hist};
}
function calcRSI(prices, period=14) {
  if(prices.length<period+1)return null;
  let ag=0,al=0;
  for(let i=1;i<=period;i++){const d=prices[i]-prices[i-1];if(d>=0)ag+=d;else al-=d;}
  ag/=period;al/=period;
  for(let i=period+1;i<prices.length;i++){
    const d=prices[i]-prices[i-1];
    ag=(ag*(period-1)+(d>=0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0?100:Math.round((100-100/(1+ag/al))*100)/100;
}
function calcKD(highs,lows,closes,period=9){
  const k=[],d=[];
  for(let i=0;i<closes.length;i++){
    if(i<period-1){k.push(null);d.push(null);continue;}
    const hh=Math.max(...highs.slice(i-period+1,i+1));
    const ll=Math.min(...lows.slice(i-period+1,i+1));
    const rsv=hh===ll?50:(closes[i]-ll)/(hh-ll)*100;
    const pk=k.length>0&&k[k.length-1]!=null?k[k.length-1]:50;
    const pd=d.length>0&&d[d.length-1]!=null?d[d.length-1]:50;
    k.push(Math.round((pk*2/3+rsv/3)*100)/100);
    d.push(Math.round((pd*2/3+k[k.length-1]/3)*100)/100);
  }
  return {k,d};
}
function toMonthly(timestamps,closes,highs,lows){
  const m={};
  for(let i=0;i<timestamps.length;i++){
    const dt=new Date(timestamps[i]*1000);
    const ym=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
    if(!m[ym])m[ym]={date:ym,high:highs[i],low:lows[i],close:closes[i]};
    else{m[ym].high=Math.max(m[ym].high,highs[i]);m[ym].low=Math.min(m[ym].low,lows[i]);m[ym].close=closes[i];}
  }
  return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const mkt = req.query.market || "twii";
  const info = MARKETS[mkt] || MARKETS.twii;

  try {
    const url = `${BASE}/${encodeURIComponent(info.symbol)}?interval=1d&range=2y`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Yahoo Finance ${r.status}`);
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error("No data");

    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const rawCloses = q.close || [];
    const rawHighs  = q.high  || [];
    const rawLows   = q.low   || [];

    const valid = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (rawCloses[i] != null && rawCloses[i] > 0) {
        valid.push({ ts: timestamps[i], c: rawCloses[i], h: rawHighs[i]||rawCloses[i], l: rawLows[i]||rawCloses[i] });
      }
    }
    if (!valid.length) throw new Error("No valid data");

    const vc = valid.map(d=>d.c), vh = valid.map(d=>d.h), vl = valid.map(d=>d.l);
    const n = vc.length;

    const ma20arr  = sma(vc, 20),  ma60arr  = sma(vc, 60);
    const ma120arr = sma(vc, 120), ma240arr = sma(vc, 240);
    const { ml, sl, hist } = calcMACD(vc);
    const rsi = calcRSI(vc.slice(-50));

    const monthly = toMonthly(valid.map(d=>d.ts), vc, vh, vl);
    const { k: mk, d: md } = calcKD(monthly.map(d=>d.high), monthly.map(d=>d.low), monthly.map(d=>d.close));
    const monthK = mk[mk.length-1], monthD = md[md.length-1];

    const price = meta.regularMarketPrice || vc[n-1];
    const prev  = meta.previousClose || (n>=2 ? vc[n-2] : null);
    const changePct = prev ? Math.round((price-prev)/prev*10000)/100 : null;
    const last252 = vc.slice(-252);
    const p = price;

    const maPos = [];
    if (ma20arr[n-1]  != null) maPos.push(p > ma20arr[n-1]  ? `站上月線（${ma20arr[n-1].toLocaleString()}）`  : `跌破月線（${ma20arr[n-1].toLocaleString()}）`);
    if (ma60arr[n-1]  != null) maPos.push(p > ma60arr[n-1]  ? `站上季線（${ma60arr[n-1].toLocaleString()}）`  : `跌破季線（${ma60arr[n-1].toLocaleString()}）`);
    if (ma120arr[n-1] != null) maPos.push(p > ma120arr[n-1] ? `站上半年線（${ma120arr[n-1].toLocaleString()}）` : `跌破半年線（${ma120arr[n-1].toLocaleString()}）`);
    if (ma240arr[n-1] != null) maPos.push(p > ma240arr[n-1] ? `站上年線（${ma240arr[n-1].toLocaleString()}）`  : `跌破年線（${ma240arr[n-1].toLocaleString()}）`);

    const lastDate = new Date(valid[n-1].ts*1000).toISOString().split("T")[0];
    const history  = valid.slice(-60).map((d,i)=>{
      const idx = n-60+i;
      return {
        date: new Date(d.ts*1000).toISOString().split("T")[0],
        close: d.c, high: d.h, low: d.l,
        ma20:  idx>=0?ma20arr[idx]:null,
        ma60:  idx>=0?ma60arr[idx]:null,
        ma240: idx>=0?ma240arr[idx]:null,
        macd:  idx>=0?ml[idx]:null,
        macd_hist: idx>=0?hist[idx]:null,
      };
    });

    return res.status(200).json({
      market: mkt, name: info.name, symbol: info.symbol, currency: info.currency,
      updated: lastDate,
      price: { close: p, change_percent: changePct },
      indicators: {
        ma20: ma20arr[n-1], ma60: ma60arr[n-1], ma120: ma120arr[n-1], ma240: ma240arr[n-1],
        rsi, macd_hist: hist[n-1], macd_line: ml[n-1], macd_signal: sl[n-1],
        month_k: monthK, month_d: monthD,
        high_52w: last252.length ? Math.max(...last252) : null,
        low_52w:  last252.length ? Math.min(...last252) : null,
        ma_position: maPos,
      },
      history,
    });
  } catch (err) {
    console.error("[market-analyze]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
