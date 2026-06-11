// api/jp-analyze.js — 日股分析（Yahoo Finance .T 格式）
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

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
function generateSignal(price,ma20,ma60,ma120,ma240,rsi,macdHist,monthK){
  const signals=[];let bull=0,bear=0;
  if(ma240!=null){
    if(price>ma240){signals.push({type:'bullish',text:`現價站上年線（MA240=${ma240}），長線結構健康`});bull+=2;}
    else{signals.push({type:'bearish',text:`現價跌破年線（MA240=${ma240}），長線趨勢偏弱`});bear+=2;}
  }
  if(ma60!=null&&ma120!=null){
    if(ma60>ma120){signals.push({type:'bullish',text:`季線（MA60=${ma60}）> 半年線，中期多頭`});bull++;}
    else{signals.push({type:'bearish',text:`季線（MA60=${ma60}）< 半年線，中期空頭`});bear++;}
  }
  if(macdHist!=null){
    if(macdHist>0){signals.push({type:'bullish',text:`MACD 柱狀圖為正，動能偏多`});bull++;}
    else if(macdHist<0){signals.push({type:'bearish',text:`MACD 柱狀圖為負，動能偏空`});bear++;}
  }
  if(monthK!=null){
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
  else if(bull>bear){overall='bullish';summary='偏多格局，可分批觀察布局';}
  else if(bear>=4){overall='bearish';summary='多項指標偏空，建議等待落底訊號';}
  else if(bear>bull){overall='bearish';summary='偏空格局，建議觀望';}
  return {overall,summary,signals,bullScore:bull,bearScore:bear};
}

module.exports = async function handler(req,res){
  // 只允許自己的網域與本機開發環境呼叫，避免 API 額度被第三方盜用
  const _origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/.test(_origin) || /\.vercel\.app$/.test((()=>{try{return new URL(_origin).hostname}catch(_){return ""}})())) {
    res.setHeader("Access-Control-Allow-Origin", _origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  if(req.method==="OPTIONS")return res.status(200).end();

  let { symbol } = req.query;
  if(!symbol)return res.status(400).json({error:"請提供日股代號，例如 6758（Sony）、8035（東京電子）"});

  // 移除 .T 後綴後驗證，再補回
  const clean = symbol.trim().replace(/\.T$/i,'').replace(/\.t$/i,'');
  if(!/^\d{4,5}$/.test(clean))return res.status(400).json({error:`「${symbol}」不是有效的日股代號（4-5位數字）`});
  const sym = clean + '.T';   // Yahoo Finance 日股格式

  try {
    const url=`${BASE}/${encodeURIComponent(sym)}?interval=1d&range=2y`;
    const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error(`Yahoo Finance 錯誤: ${r.status}`);
    const json=await r.json();
    const result=json.chart?.result?.[0];
    if(!result)throw new Error(`查無日股代號 ${clean}，請確認代號是否正確`);

    const meta=result.meta;
    const timestamps=result.timestamp||[];
    const q=result.indicators?.quote?.[0]||{};
    const closes=(q.close||[]).map(v=>v!=null?Math.round(v*100)/100:null);
    const highs=(q.high||[]).map(v=>v!=null?Math.round(v*100)/100:null);
    const lows=(q.low||[]).map(v=>v!=null?Math.round(v*100)/100:null);
    const volumes=q.volume||[];

    // 過濾有效資料
    const valid=[];
    for(let i=0;i<timestamps.length;i++){
      if(closes[i]!=null&&closes[i]>0)valid.push({ts:timestamps[i],c:closes[i],h:highs[i]||closes[i],l:lows[i]||closes[i],v:volumes[i]||0});
    }
    if(!valid.length)throw new Error(`${clean} 暫無有效歷史資料`);

    const vc=valid.map(d=>d.c),vh=valid.map(d=>d.h),vl=valid.map(d=>d.l),vts=valid.map(d=>d.ts);
    const n=vc.length;

    const ma20arr=sma(vc,20),ma60arr=sma(vc,60),ma120arr=sma(vc,120),ma240arr=sma(vc,240);
    const {ml,sl,hist}=calcMACD(vc);
    const rsi=calcRSI(vc.slice(-50));
    const monthly=toMonthly(vts,vc,vh,vl);
    const {k:mk,d:md}=calcKD(monthly.map(d=>d.high),monthly.map(d=>d.low),monthly.map(d=>d.close),9);
    const monthK=mk[mk.length-1],monthD=md[md.length-1];

    const price=meta.regularMarketPrice||vc[n-1];
    const prev=meta.previousClose||(n>=2?vc[n-2]:null);
    const changePct=prev?Math.round((price-prev)/prev*10000)/100:null;
    const last252=vc.slice(-252);

    const maPos=[];
    const p=price;
    if(ma60arr[n-1]!=null)maPos.push(p>ma60arr[n-1]?`站上季線（${ma60arr[n-1]}）`:`跌破季線（${ma60arr[n-1]}）`);
    if(ma120arr[n-1]!=null)maPos.push(p>ma120arr[n-1]?`站上半年線（${ma120arr[n-1]}）`:`跌破半年線（${ma120arr[n-1]}）`);
    if(ma240arr[n-1]!=null)maPos.push(p>ma240arr[n-1]?`站上年線（${ma240arr[n-1]}）`:`跌破年線（${ma240arr[n-1]}）`);

    const indicators={
      ma20:ma20arr[n-1],ma60:ma60arr[n-1],ma120:ma120arr[n-1],ma240:ma240arr[n-1],
      rsi,macd_line:ml[n-1],macd_signal:sl[n-1],macd_hist:hist[n-1],
      month_k:monthK,month_d:monthD,
      high_52w:last252.length?Math.max(...last252):null,
      low_52w:last252.length?Math.min(...last252):null,
      ma_position:maPos,
    };
    const signal=generateSignal(p,ma20arr[n-1],ma60arr[n-1],ma120arr[n-1],ma240arr[n-1],rsi,hist[n-1],monthK);

    const lastDate=new Date(vts[n-1]*1000).toISOString().split('T')[0];
    const history=valid.slice(-60).map((d,i)=>{
      const idx=n-60+i;
      return {
        date:new Date(d.ts*1000).toISOString().split('T')[0],
        close:d.c,volume:d.v,
        ma20:idx>=0?ma20arr[idx]:null,ma60:idx>=0?ma60arr[idx]:null,ma240:idx>=0?ma240arr[idx]:null,
        macd:idx>=0?ml[idx]:null,macd_signal:idx>=0?sl[idx]:null,macd_hist:idx>=0?hist[idx]:null,
      };
    });

    return res.status(200).json({
      stock_id:clean,
      name:meta.longName||meta.shortName||clean,
      market:'jp',
      currency:'JPY',
      updated:lastDate,
      data_note:'資料來源：Yahoo Finance，可能非即時報價',
      price:{
        close:price,
        open:meta.regularMarketOpen||vc[n-1],
        high:meta.regularMarketDayHigh||vh[n-1],
        low:meta.regularMarketDayLow||vl[n-1],
        volume:valid[n-1]?.v||0,
        change_percent:changePct,
      },
      indicators,signal,history,
    });
  } catch(err){
    console.error("[jp-analyze]",err.message);
    return res.status(500).json({error:err.message||"日股資料暫時無法取得"});
  }
};
