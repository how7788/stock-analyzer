export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { prompt, stock } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // 抓即時股價
  let stockInfo = '';
  try {
    const symbol = stock.includes('台積電') || stock.includes('2330') ? '2330.TW' :
                   stock.includes('鴻海') || stock.includes('2317') ? '2317.TW' :
                   stock.includes('聯發科') || stock.includes('2454') ? '2454.TW' :
                   stock.includes('NVDA') || stock.includes('輝達') ? 'NVDA' :
                   stock.includes('AAPL') || stock.includes('蘋果') ? 'AAPL' :
                   stock.replace(/\s/g, '');

    const yahooRes = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const yahooData = await yahooRes.json();
    const meta = yahooData?.chart?.result?.[0]?.meta;
    if (meta) {
      stockInfo = `【即時股價資料（來源：Yahoo Finance，${new Date().toLocaleDateString('zh-TW')}）】
股票代號：${symbol}
現價：${meta.regularMarketPrice} ${meta.currency}
今日開盤：${meta.regularMarketOpen}
今日高點：${meta.regularMarketDayHigh}
今日低點：${meta.regularMarketDayLow}
52週高點：${meta.fiftyTwoWeekHigh}
52週低點：${meta.fiftyTwoWeekLow}
市值：${meta.marketCap ? (meta.marketCap / 1e12).toFixed(2) + ' 兆' : '未提供'}
`;
    }
  } catch(e) {
    stockInfo = '（即時股價抓取失敗，請以市場最新數據為準）\n';
  }

  const fullPrompt = stockInfo + '\n' + prompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: fullPrompt }]
    })
  });
  
  const data = await response.json();
  const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
  res.status(200).json({ text });
}
