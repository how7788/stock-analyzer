// api/institutional.js — 台股籌碼面（三大法人）獨立端點
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { stock_id } = req.query;
  if (!stock_id) return res.status(400).json({ error: "缺少 stock_id" });

  const token = process.env.FINMIND_TOKEN;
  if (!token) return res.status(500).json({ error: "FINMIND_TOKEN 未設定" });

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = daysAgo(10);
    const url = `${FINMIND_BASE}?dataset=TaiwanStockInstitutionalInvestors&data_id=${encodeURIComponent(stock_id)}&start_date=${startDate}&end_date=${endDate}&token=${token}`;
    const res2 = await fetch(url);
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    const json = await res2.json();
    if (json.status !== 200) throw new Error(json.msg || "FinMind 錯誤");

    const data = json.data || [];
    if (!data.length) return res.status(200).json({ available: false });

    const last5 = data.slice(-5);
    let foreign = 0, trust = 0, dealer = 0;
    for (const d of last5) {
      foreign += Number(d.Foreign_Investor_Buy_Sell ?? ((Number(d.Foreign_Investor_Buy)||0) - (Number(d.Foreign_Investor_Sell)||0)));
      trust   += Number(d.Investment_Trust_Buy_Sell ?? ((Number(d.Investment_Trust_Buy)||0) - (Number(d.Investment_Trust_Sell)||0)));
      dealer  += Number(d.Dealer_Buy_Sell ?? ((Number(d.Dealer_Buy)||0) - (Number(d.Dealer_Sell)||0)));
    }

    return res.status(200).json({
      available: true,
      date: last5[last5.length - 1].date,
      days: last5.length,
      foreign_5d: Math.round(foreign / 1000),
      trust_5d:   Math.round(trust   / 1000),
      dealer_5d:  Math.round(dealer  / 1000),
      total_5d:   Math.round((foreign + trust + dealer) / 1000),
    });
  } catch (err) {
    console.error("[institutional]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
