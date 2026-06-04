// api/us-analyze.js — 美股分析（Yahoo Finance）修正版
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    return Math.round(arr.slice(i-period+1, i+1).reduce((a,v)=>a+v,0)/period*100)/100;
  });
}

function ema(arr, period) {
  const k = 2/(period+1), r = new Array(arr.length).fill(null);
  let st = 0;
  while (st < arr.length && arr[st] == null) st++;
  if (st+period-1 >= arr.length) return r;
  r[st+period-1] = arr.slice(st,st+period).reduce((a,v)=>a+v,0)/period;
  for (let i = st+period; i < arr.length; i++) r[i] = arr[i]*k + r[i-1]*(1-k);
  return r.map(v => v!=null ? Math.round(v*100)/100 : null);
}

function calcMACD(closes) {
  const e12=ema(closes,12), e26=ema(closes,26);
  const ml=closes.map((_,i)=>e12[i]!=null&&e26[i]!=null?Math.round((e12[i]-e26[i])*100)/100:null);
  const sl=ema(ml,9);
  const hist=ml.map((v,i)=>v!=null&&sl[i]!=null?Math.round((v-sl[i])*100)/100:null);
  return { ml, sl, hist };
}

function calcRSI(prices, period=14) {
  if (prices.length < period+1) return null;
  let ag=0, al=0;
  for (let i=1;i<=period;i++){const d=prices[i]-prices[i-1];if(d>=0)ag+=d;else al-=d;}
  ag/=period; al/=period;
  for (let i=period+1;i<prices.length;i++){
    const d=prices[i]-prices[i-1];
    ag=(ag*(period-1)+(d>=0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0?100:Math.round((100-100/(1+ag/al))*100)/100;
}

function calcKD(highs, lows, closes, period=9) {
  const k=[],d=[];
  for (let i=0;i<closes.length;i++){
    if(i<period-1){k.push(null);d.push(null);continue;}
    const hh=Math.max(...highs.slice(i-period+1,i+1));
    const ll=Math.min(...lows.slice(i-period+1,i+1));
    const rsv=hh===ll?50:(closes[i]-ll)/(hh-ll)*100;
    const pk=k.length>0&&k[k.length-1]!=null?k[k.length-1]:50;
    const pd=d.length>0&&d[d.length-1]!=null?d[d.length-1]:50;
    k.push(Math.round((pk*2/3+rsv/3)*100)/100);
    d.push(Math.round((pd*2/3+k[k.length-1]/3)*100)/100);
  }
  return { k, d };
}

function toMonthly(timestamps, closes, highs, lows) {
  const m={};
  for (let i=0;i<timestamps.length;i++){
    const dt=new Date(timestamps[i]*1000);
    const ym=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
    if(!m[ym])m[ym]={date:ym,high:highs[i],low:lows[i],close:closes[i]};
    else{m[ym].high=Math.max(m[ym].high,highs[i]);m[ym].low=Math.min(m[ym].low,lows[i]);m[ym].close=closes[i];}
  }
  return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date));
}

// ★ 修正：MA 文案正確對應
function generateSignal(price, ma20, ma60, ma120, ma240, rsi, macdHist, monthK) {
  const signals=[];
  let bull=0, bear=0;
  if (ma240!=null) {
    if(price>ma240){signals.push({type:'bullish',text:`現價站上年線（MA240=${ma240}），長線結構健康`});bull+=2;}
    else{signals.push({type:'bearish',text:`現價跌破年線（MA240=${ma240}），長線趨勢偏弱`});bear+=2;}
  }
  if (ma60!=null&&ma120!=null) {
    if(ma60>ma120){signals.push({type:'bullish',text:`季線（MA60=${ma60}）> 半年線（MA120=${ma120}），中期多頭`});bull++;}
    else{signals.push({type:'bearish',text:`季線（MA60=${ma60}）< 半年線（MA120=${ma120}），中期空頭`});bear++;}
  }
  if (macdHist!=null) {
    if(macdHist>0){signals.push({type:'bullish',text:`MACD 柱狀圖為正，動能偏多`});bull++;}
    else if(macdHist<0){signals.push({type:'bearish',text:`MACD 柱狀圖為負，動能偏空`});bear++;}
  }
  if (monthK!=null) {
    if(monthK<20){signals.push({type:'bullish',text:`月KD K值 ${monthK} 低檔，中長期超賣`});bull+=2;}
    else if(monthK>80){signals.push({type:'bearish',text:`月KD K值 ${monthK} 高檔，留意壓力`});bear++;}
    else signals.push({type:'neutral',text:`月KD K值 ${monthK}，中性區間`});
  }
  if(rsi!=null){
    if(rsi<40){signals.push({type:'bullish',text:`RSI ${rsi} 偏低，有回升空間`});bull++;}
    else if(rsi>70){signals.push({type:'bearish',text:`RSI ${rsi} 偏高，注意短線`});bear++;}
  }
  let overall='neutral',summary='中性觀望，等待明確訊號';
  if(bull>=4){overall='bullish';summary='多項指標偏多，中長期觀察機會較佳';}
  else if(bull>bear){overall='bullish';summary='偏多格局，可分批觀察';}
  else if(bear>=4){overall='bearish';summary='多項指標偏空，建議等待落底';}
  else if(bear>bull){overall='bearish';summary='偏空格局，建議觀望';}
  return {overall,summary,signals,bullScore:bull,bearScore:bear};
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Content-Type","application/json");
  if(req.method==="OPTIONS")return res.status(200).end();

  const { symbol } = req.query;
  if(!symbol)return res.status(400).json({error:"請提供股票代號，例如 AAPL"});

  const sym = symbol.trim().toUpperCase();
  if(!/^[A-Z]{1,5}$/.test(sym))return res.status(400).json({error:`「${sym}」不是有效的美股代號`});

  try {
    const url=`${BASE}/${encodeURIComponent(sym)}?interval=1d&range=2y`;
    const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
    if(!r.ok)throw new Error(`Yahoo Finance 錯誤: ${r.status}`);
    const json=await r.json();
    const result=json.chart?.result?.[0];
    if(!result)throw new Error(`查無股票代號 ${sym}，請確認代號是否正確`);

    const meta=result.meta;
    const timestamps=result.timestamp||[];
    const q=result.indicators?.quote?.[0]||{};
    const rawCloses=q.close||[], opens=q.open||[], highs=q.high||[], lows=q.low||[], volumes=q.volume||[];

    // 過濾有效資料
    const valid=[];
    for(let i=0;i<rawCloses.length;i++){
      if(rawCloses[i]!=null)valid.push(i);
    }
    if(valid.length<30)throw new Error("歷史資料不足，請稍後再試");

    const vCloses=valid.map(i=>Math.round(rawCloses[i]*100)/100);
    const vHighs=valid.map(i=>highs[i]||rawCloses[i]);
    const vLows=valid.map(i=>lows[i]||rawCloses[i]);
    const vTs=valid.map(i=>timestamps[i]);
    const n=vCloses.length;

    const ma20arr=sma(vCloses,20), ma60arr=sma(vCloses,60);
    const ma120arr=sma(vCloses,120), ma240arr=sma(vCloses,240);
    const {ml,sl,hist}=calcMACD(vCloses);
    const rsi=calcRSI(vCloses.slice(-50));
    const monthly=toMonthly(vTs,vCloses,vHighs,vLows);
    const {k:mk,d:md}=calcKD(monthly.map(d=>d.high),monthly.map(d=>d.low),monthly.map(d=>d.close),9);

    const lastP=vCloses[n-1];
    const prev=vCloses[n-2];
    const changePct=prev?Math.round((lastP-prev)/prev*10000)/100:null;
    const last252=vCloses.slice(-252);
    const lastDate=new Date(vTs[n-1]*1000).toISOString().split('T')[0];
    const lastOrigIdx=valid[n-1];

    // ★ 修正均線位置文案
    const maPos=[];
    if(ma60arr[n-1]!=null)  maPos.push(lastP>ma60arr[n-1]  ?`站上季線（${ma60arr[n-1]}）`:`跌破季線（${ma60arr[n-1]}）`);
    if(ma120arr[n-1]!=null) maPos.push(lastP>ma120arr[n-1] ?`站上半年線（${ma120arr[n-1]}）`:`跌破半年線（${ma120arr[n-1]}）`);
    if(ma240arr[n-1]!=null) maPos.push(lastP>ma240arr[n-1] ?`站上年線（${ma240arr[n-1]}）`:`跌破年線（${ma240arr[n-1]}）`);

    const indicators={
      ma20:ma20arr[n-1], ma60:ma60arr[n-1], ma120:ma120arr[n-1], ma240:ma240arr[n-1],
      rsi, macd_line:ml[n-1], macd_signal:sl[n-1], macd_hist:hist[n-1],
      month_k:mk[mk.length-1], month_d:md[md.length-1],
      high_52w:Math.max(...last252), low_52w:Math.min(...last252),
      ma_position:maPos,
    };

    const signal=generateSignal(lastP,ma20arr[n-1],ma60arr[n-1],ma120arr[n-1],ma240arr[n-1],rsi,hist[n-1],mk[mk.length-1]);

    const valuation={
      per:meta.trailingPE?Math.round(meta.trailingPE*10)/10:null,
      pbr:null,
      yield:meta.dividendYield?Math.round(meta.dividendYield*10000)/100:null,
      date:lastDate, currency:meta.currency||'USD',
    };

    // ★ 修正：history 確保 60 筆有效資料
    const hist60=[];
    for(let i=Math.max(0,n-60);i<n;i++){
      hist60.push({
        date:new Date(vTs[i]*1000).toISOString().split('T')[0],
        close:vCloses[i], volume:volumes[valid[i]]||0,
        ma20:ma20arr[i], ma60:ma60arr[i], ma240:ma240arr[i],
        macd:ml[i], macd_signal:sl[i], macd_hist:hist[i],
      });
    }

    return res.status(200).json({
      stock_id:sym, name:meta.shortName||meta.symbol,
      market:'us', currency:meta.currency||'USD',
      updated:lastDate,
      data_note:'資料來源：Yahoo Finance，可能非即時報價',
      price:{
        close:lastP,
        open:Math.round((opens[lastOrigIdx]||lastP)*100)/100,
        high:Math.round((highs[lastOrigIdx]||lastP)*100)/100,
        low:Math.round((lows[lastOrigIdx]||lastP)*100)/100,
        volume:volumes[lastOrigIdx]||0,
        change_percent:changePct,
      },
      indicators, signal, valuation, monthly_revenue:null, history:hist60,
    });
  } catch(err){
    console.error("[us-analyze]",err.message);
    return res.status(500).json({error:err.message||"資料暫時無法取得，請稍後再試"});
  }
};
