export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { prompt } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  let messages = [{ role: 'user', content: prompt }];
  let finalText = '';

  // 最多跑 5 輪處理 tool use
  for (let i = 0; i < 5; i++) {
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
        messages
      })
    });
    
    const data = await response.json();
    const content = data.content || [];
    
    // 收集文字
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) finalText += text;
    
    // 如果結束了就停
    if (data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence') break;
    
    // 如果有 tool_use，繼續對話
    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content });
      const toolResults = content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  res.status(200).json({ text: finalText });
}
