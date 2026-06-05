// api/daily-focus.js — 每日產業焦點導航

const SOURCE_MAP = {
  'cnyes.com': '鉅亨網', 'moneydj.com': 'MoneyDJ', 'cmoney.tw': 'CMoney',
  'udn.com': '聯合報', 'money.udn.com': '經濟日報', 'ltn.com.tw': '自由財經',
  'ettoday.net': 'ETtoday', 'ctee.com.tw': '工商時報', 'businesstoday.com.tw': '今周刊',
  'technews.tw': '科技新報', 'digitimes.com.tw': 'Digitimes', 'newtalk.tw': '新頭殼',
  'today.line.me': 'LINE TODAY', 'ec.ltn.com.tw': '自由財經', 'wealth.com.tw': '財訊',
};

function getSource(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    for (const [d, n] of Object.entries(SOURCE_MAP)) {
      if (host.includes(d)) return n;
    }
    const parts = host.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch (_) { return '財經媒體'; }
}

async function fetchNews(tavilyKey) {
  const queries = [
    "台股 AI伺服器 半導體 強勢族群 產業焦點 2026",
    "台積電 聯發科 鴻海 廣達 最新消息 今日",
    "台股 資金輪動 題材 法人買賣 今日重點",
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: tavilyKey, query: q,
          search_depth: "basic", max_results: 5, days: 2,
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));
    clearTimeout(timer);
    const seen = new Set();
    const articles = [];
    for (const r of results) {
      for (const item of (r.results || [])) {
        const url = item.url || '', content = item.content || '';
        if (!seen.has(url) && content.length > 100) {
          seen.add(url);
          articles.push({ title: item.title || '', url, snippet: content.slice(0, 400), source: getSource(url), published: item.published_date || null });
        }
      }
    }
    return articles.slice(0, 12);
  } catch (_) { clearTimeout(timer); return []; }
}

async function analyzeWithClaude(apiKey, articles, targetDate) {
  const newsText = articles.length
    ? articles.map((a, i) => `[${i + 1}] 來源:${a.source}\n標題:${a.title}\n內容:${a.snippet}`).join('\n\n')
    : '（今日無新聞，請根據近期市場知識生成）';

  const prompt = `你是台股產業分析師。根據以下近期新聞，整理出${targetDate}最重要的4個產業焦點，每個聚焦一個核心題材與族群。

新聞資料：
${newsText}

只輸出以下 JSON，不含任何其他文字，所有字串值不含雙引號或換行符號：
{
  "date": "${targetDate}",
  "headline": "今日市場核心關注",
  "cards": [
    {
      "source": "CMoney",
      "title": "台積電訂單吃緊，AI晶圓需求強勁",
      "summary": "AI客戶持續拉貨推升台積電先進製程稼動率至高位，CoWoS等先進封裝產能同步供不應求。法人預估2026年先進製程收入佔比將超過六成，晶圓代工主線結構受惠確立。",
      "sectors": ["晶圓代工", "AI先進封裝"],
      "color": "blue"
    },
    {
      "source": "鉅亨網",
      "title": "AI伺服器ODM供應鏈資金全面聚焦",
      "summary": "廣達緯創鴻海等ODM廠受GB200出貨訂單帶動強勢表現，資金同步擴散至散熱模組與機殼周邊族群。市場預期AI伺服器規格升級延續性將支撐供應鏈整段行情。",
      "sectors": ["AI伺服器組裝", "散熱模組"],
      "color": "green"
    },
    {
      "source": "科技新報",
      "title": "DRAM報價預期走升，模組記憶體領漲",
      "summary": "AI應用拉動DRAM及NAND需求，南亞科華邦電等一般型DRAM族群強勢表現。資金從HBM高頻寬記憶體擴散至利基記憶體模組，群聯威剛等受模組報價支撐同步走升。",
      "sectors": ["記憶體模組", "利基記憶體"],
      "color": "amber"
    },
    {
      "source": "工商時報",
      "title": "關稅談判進展，IC通路半導體設備出貨暢旺",
      "summary": "全球貿易協議談判持續推進，轉單具全球市占的半導體零組件廠商IC通路商與晶圓廠設備商受惠，出口市場資金轉向核心供應鏈護城河標的。",
      "sectors": ["IC通路", "晶圓廠設備"],
      "color": "purple"
    }
  ]
}

規則：cards固定4個，涵蓋不同產業面向；source用實際新聞來源；summary約100字；sectors2-3個台股習慣板塊名稱；color從blue/green/amber/purple/red/teal選一個。`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2500, messages: [{ role: "user", content: prompt }] }),
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const json = await r.json();
    let text = (json.content?.[0]?.text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s === -1) throw new Error('No JSON');
    let str = text.slice(s, e + 1).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(str); }
    catch (_) { return JSON.parse(str.replace(/[\r\n]/g, ' ')); }
  } catch (e) { clearTimeout(timer); throw e; }
}

function getAvailableDates() {
  const dates = [];
  const d = new Date();
  let count = 0;
  while (count < 7) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dates.push({ label: count === 0 ? '今日' : `${m}/${dd}`, value: `${d.getFullYear()}-${m}-${dd}` });
      count++;
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tavilyKey = process.env.TAVILY_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!tavilyKey || !anthropicKey) return res.status(500).json({ error: "缺少 API Key" });

  const dates = getAvailableDates();
  const requestDate = req.query.date || dates[0]?.value;

  try {
    const articles = await fetchNews(tavilyKey);
    const analysis = await analyzeWithClaude(anthropicKey, articles, requestDate);
    return res.status(200).json({ ...analysis, available_dates: dates });
  } catch (err) {
    console.error('[daily-focus]', err.message);
    return res.status(500).json({ error: err.message || '分析失敗，請稍後再試' });
  }
};
