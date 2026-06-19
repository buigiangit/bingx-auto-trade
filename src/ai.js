import OpenAI from 'openai';
import { CONFIG } from './config.js';

function safeJson(text) {
  const s = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(s);
}

export async function askAI(snapshot) {
  if (!CONFIG.openaiApiKey) throw new Error('Thiếu OPENAI_API_KEY trong .env');

  const client = new OpenAI({ apiKey: CONFIG.openaiApiKey });
  const recentCandles = snapshot.candles.slice(-80);
  const market = {
    symbol: snapshot.symbol,
    interval: snapshot.interval,
    recentCandles,
    indicators: snapshot.indicators,
    funding: snapshot.funding,
    premium: snapshot.premium,
    openInterest: snapshot.oi,
    book: snapshot.book,
    contract: snapshot.contract
  };

  const prompt = `
Bạn là AI phân tích thị trường crypto futures để tạo tín hiệu mô phỏng, không phải lời khuyên đầu tư.
Chỉ trả JSON hợp lệ, không markdown, không giải thích ngoài JSON.

Luật:
- Chỉ chọn một: LONG, SHORT, WAIT.
- Nếu trend, funding, OI, spread, volume hoặc RR không rõ thì chọn WAIT.
- Không được bịa dữ liệu.
- Entry/SL/TP phải dựa theo dữ liệu giá gần nhất, ATR, hỗ trợ/kháng cự.
- LONG: SL < entry, TP > entry. SHORT: SL > entry, TP < entry.
- Ưu tiên không vào lệnh hơn là vào lệnh yếu.

JSON:
{
  "signal": "LONG|SHORT|WAIT",
  "confidence": 0,
  "reason": "ngắn gọn",
  "entry": null,
  "stopLoss": null,
  "takeProfit1": null,
  "takeProfit2": null,
  "riskNote": "ngắn gọn"
}

Dữ liệu:
${JSON.stringify(market)}
`;

  const res = await client.responses.create({
    model: CONFIG.openaiModel,
    input: prompt
  });

  return safeJson(res.output_text);
}
