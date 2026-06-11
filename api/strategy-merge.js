// api/strategy-merge.js — AI 整合多份策略報告成綜合觀點
module.exports = async function handler(req, res) {
  // 只允許自己的網域與本機開發環境呼叫，避免 API 額度被第三方盜用
  const _origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/.test(_origin) || /\.vercel\.app$/.test((()=>{try{return new URL(_origin).hostname}catch(_){return ""}})())) {
    res.setHeader("Access-Control-Allow-Origin", _origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY 未設定" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(_) {} }

  const { entries } = body || {};
  if (!entries?.length) return res.status(400).json({ error: "缺少策略資料" });

  // 按日期排序，最新的在最後
  const sorted = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const reportsText = sorted.map((e, i) =>
    `【第${i+1}份 | ${e.date || '日期不明'} | ${e.source || '來源未知'}】\n${e.content}`
  ).join('\n\n---\n\n');

  const prompt = `你是資深投資策略分析師。以下是按時間順序排列的多份市場策略報告（從舊到新），請整合成一份「當前綜合策略觀點」。

規則：
1. 以最新的報告為主要依據，較舊的報告做背景參考
2. 若新舊策略有衝突，以較新的為準並說明轉變原因
3. 整合後的觀點要具體且可操作
4. 最多 400 字，用條列式呈現

${reportsText}

請整合輸出以下格式（純文字，不要 Markdown 標題符號）：

大盤研判：[1-2句]
建議持股水位：[百分比與理由]
應減碼族群：[列點]
應加碼/轉進族群：[列點]
關鍵支撐壓力：[列點，含點位]
最新策略重點：[2-3句綜合結論]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Claude ${r.status}`);
    const json = await r.json();
    const synthesis = (json.content?.[0]?.text || "").trim();
    return res.status(200).json({ synthesis, count: entries.length });
  } catch(e) {
    clearTimeout(timeout);
    return res.status(500).json({ error: e.message });
  }
};
