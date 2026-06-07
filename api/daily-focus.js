// api/daily-focus.js — 每日產業焦點導航（今日 + 昨日）

const SOURCE_MAP = {
  'cnyes.com': '鉅亨網', 'moneydj.com': 'MoneyDJ', 'cmoney.tw': 'CMoney',
  'udn.com': '聯合報', 'money.udn.com': '經濟日報', 'ltn.com.tw': '自由財經',
  'ettoday.net': 'ETtoday', 'ctee.com.tw': '工商時報', 'businesstoday.com.tw': '今周刊',
  'technews.tw': '科技新報', 'digitimes.com.tw': 'Digitimes', 'newtalk.tw': '新頭殼',
  'today.line.me': 'LINE TODAY', 'ec.ltn.com.tw': '自由財經', 'wealth.com.tw': '財訊',
  'anuefund.com': 'anuefund', 'growin.com': 'Growin', 'mic.org.tw': '資策會MIC',
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

// daysParam: 1 = 今日（近24h），2 = 昨日（近48h）
async function fetchNews(tavilyKey, daysParam) {
  const queries = [
    "台股 大盤 指數 今日 重要消息 漲跌",
    "台指期貨 夜盤 熔斷 大跌 大漲 最新",
    "台股 AI伺服器 半導體 強勢族群 產業焦點",
    "台積電 聯發科 鴻海 廣達 最新消息",
    "台股 資金輪動 題材 法人買賣 重點",
    "美國科技股 AI 半導體 聯準會 最新消息 中文",
    "聯準會 利率 美債殖利率 通膨 美元指數 中文",
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  const now = Date.now();
  const MS_2D = 2 * 86400000;

  try {
    const results = await Promise.all(queries.map(q =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: tavilyKey, query: q,
          search_depth: "basic", max_results: 5,
          days: daysParam,
        }),
      }).then(r => r.json()).catch(() => ({ results: [] }))
    ));
    clearTimeout(timer);
    const seen = new Set();
    const fresh = [], stale = [];

    for (const r of results) {
      for (const item of (r.results || [])) {
        const url = item.url || '', snippet = item.content || '';
        if (!seen.has(url) && snippet.length > 100) {
          seen.add(url);
          // ── 嚴格日期驗證 ──
          let pubTs = null;
          if (item.published_date) {
            try { const d = new Date(item.published_date); if (!isNaN(d)) pubTs = d.getTime(); } catch(_) {}
          }
          const art = {
            title: item.title || '', url, snippet: snippet.slice(0, 400),
            source: getSource(url), published: item.published_date || null,
            pubTs,
          };
          // 有日期且在 2 天內 → fresh；無日期或較舊 → stale（附加但降權）
          if (pubTs && (now - pubTs) <= MS_2D) fresh.push(art);
          else stale.push(art);
        }
      }
    }

    // 優先用有明確近期日期的文章，不足才補 stale
    const pool = [...fresh];
    if (pool.length < 6) pool.push(...stale.slice(0, 8 - pool.length));
    return pool.slice(0, 10);
  } catch (_) { clearTimeout(timer); return []; }
}

async function analyzeWithClaude(apiKey, articles, targetDate) {
  const newsText = articles.length
    ? articles.map((a, i) => {
        const dateStr = a.published ? a.published.slice(0,10) : '日期未知';
        return `[${i + 1}] 來源:${a.source} | 日期:${dateStr}\n標題:${a.title}\n內容:${a.snippet}`;
      }).join('\n\n')
    : '（今日無新聞資料）';

  // 今天日期用於讓 Claude 判斷新舊
  const todayStr = new Date().toISOString().split('T')[0];

  const prompt = `你是台股產業分析師。今天是 ${todayStr}。根據以下今日最新新聞，整理出${targetDate}最重要的4個產業焦點，每個聚焦一個核心題材與族群。

【重要規則】
1. 只根據下方新聞內容，嚴禁使用訓練資料補充
2. 若文章提到的指數點位、事件、時間明顯不符合今日（${todayStr}），請跳過該文章
3. 若新聞不足，寧可縮短摘要，也不要編造或引用過時資料
4. 每張卡片的 summary 必須來自實際新聞內容

新聞資料（各文章附有來源與發布日期，請優先使用日期最近的）：
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
    }
  ]
}

規則：cards 固定4個，涵蓋不同產業面向；source 用實際新聞來源；summary 約100字；sectors 2-3個台股板塊名稱；color 從 blue/green/amber/purple/red/teal 選一個。重要：只使用上方提供的新聞內容，若新聞中出現明顯過時的數字或事件（如舊點位、舊消息），請跳過該新聞改選其他較新的內容。`;

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
    let str = text.slice(s, e + 1)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(str); }
    catch (_) { return JSON.parse(str.replace(/[\r\n]/g, ' ')); }
  } catch (e) { clearTimeout(timer); throw e; }
}

function getAvailableDates() {
  const fmt = d => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  };

  // 今日用實際日期，不跳過週末
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  return [
    { label: '今日', value: fmt(today), days: 1 },
    { label: '前日', value: fmt(yesterday), days: 2 },
  ];
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
  const requestDate = req.query.date || dates[0].value;

  // 找對應的 daysParam（今日=1，前日=2）
  const matched = dates.find(d => d.value === requestDate);
  const daysParam = matched ? matched.days : 1;

  try {
    const articles = await fetchNews(tavilyKey, daysParam);
    const analysis = await analyzeWithClaude(anthropicKey, articles, requestDate);
    return res.status(200).json({ ...analysis, available_dates: dates });
  } catch (err) {
    console.error('[daily-focus]', err.message);
    return res.status(500).json({ error: err.message || '分析失敗，請稍後再試' });
  }
};
