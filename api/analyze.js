export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { prompt } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  
  const data = await response.json();
  const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
  res.status(200).json({ text });
}
