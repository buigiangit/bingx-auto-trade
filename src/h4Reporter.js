import axios from 'axios';
import OpenAI from 'openai';
import { CONFIG } from './config.js';
import { buildMarketSnapshot } from './market.js';
import { addIndicators } from './indicators.js';

let openaiClient = null;
let lastReportKey = null;
let isH4ReportRunning = false;

function getOpenAIClient() {
if (!CONFIG.openaiApiKey) {
throw new Error(
'Thiếu OPENAI_API_KEY để tạo bài phân tích H4'
);
}

if (!openaiClient) {
openaiClient = new OpenAI({
apiKey: CONFIG.openaiApiKey
});
}

return openaiClient;
}

function escapeHtml(value) {
return String(value ?? '')
.replaceAll('&', '&')
.replaceAll('<', '<')
.replaceAll('>', '>');
}

function formatNumber(value, digits = 2) {
const number = Number(value);

if (!Number.isFinite(number)) {
return 'N/A';
}

return number.toLocaleString('en-US', {
maximumFractionDigits: digits
});
}

function maskToken(token) {
const value = String(token || '');

if (value.length <= 12) {
return '***';
}

return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getVietnamTimeParts(date = new Date()) {
const formatter = new Intl.DateTimeFormat(
'en-CA',
{
timeZone:
CONFIG.h4ReportTimezone ||
'Asia/Ho_Chi_Minh',

```
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}
```

);

const parts = Object.fromEntries(
formatter
.formatToParts(date)
.map(part => [
part.type,
part.value
])
);

return {
dateKey:
`${parts.year}-${parts.month}-${parts.day}`,

```
timeKey:
  `${parts.hour}:${parts.minute}`,

fullKey:
  `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
```

};
}

function shouldSendH4ReportNow() {
if (!CONFIG.h4ReportEnabled) {
return {
shouldSend: false,
reason: 'H4_REPORT_ENABLED=false'
};
}

const times = Array.isArray(
CONFIG.h4ReportTimes
)
? CONFIG.h4ReportTimes
: [];

if (times.length === 0) {
return {
shouldSend: false,
reason: 'Chưa cấu hình H4_REPORT_TIMES'
};
}

const timeParts =
getVietnamTimeParts();

const matched =
times.includes(
timeParts.timeKey
);

if (!matched) {
return {
shouldSend: false,
reason:
`Chưa tới giờ gửi H4. Hiện tại ${timeParts.timeKey}`,
timeParts
};
}

if (
lastReportKey === timeParts.fullKey
) {
return {
shouldSend: false,
reason:
`Đã gửi report cho mốc ${timeParts.fullKey}`,
timeParts
};
}

return {
shouldSend: true,
timeParts
};
}

function buildReportTargets() {
const tokens = Array.isArray(
CONFIG.h4ReportBotTokens
)
? CONFIG.h4ReportBotTokens
: [];

const chatIds = Array.isArray(
CONFIG.h4ReportChatIds
)
? CONFIG.h4ReportChatIds
: [];

if (tokens.length === 0) {
throw new Error(
'Thiếu H4_REPORT_BOT_TOKENS'
);
}

if (chatIds.length === 0) {
throw new Error(
'Thiếu H4_REPORT_CHAT_IDS'
);
}

/*

* Trường hợp 1:
* 1 bot đăng nhiều channel.
  */
  if (tokens.length === 1) {
  return chatIds.map(chatId => ({
  botToken:
  tokens[0],

  chatId
  }));
  }

/*

* Trường hợp 2:
* token 1 -> chat id 1
* token 2 -> chat id 2
  */
  if (tokens.length === chatIds.length) {
  return tokens.map(
  (botToken, index) => ({
  botToken,
  chatId:
  chatIds[index]
  })
  );
  }

throw new Error(
`Cấu hình H4 report không khớp: ` +
`H4_REPORT_BOT_TOKENS có ${tokens.length} token, ` +
`H4_REPORT_CHAT_IDS có ${chatIds.length} chat id. ` +
`Hãy dùng 1 token cho nhiều chat id, hoặc số token bằng số chat id.`
);
}

function buildMarketPayload(snapshot) {
const indicators =
snapshot.indicators || {};

const candles =
Array.isArray(snapshot.candles)
? snapshot.candles.slice(-60)
: [];

return {
symbol:
snapshot.symbol,

```
interval:
  snapshot.interval,

lastPrice:
  indicators.lastClose,

trend:
  indicators.trend,

ema34:
  indicators.ema34,

ema89:
  indicators.ema89,

ema200:
  indicators.ema200,

rsi14:
  indicators.rsi14,

macd:
  indicators.macd,

atr14:
  indicators.atr14,

support:
  indicators.support,

resistance:
  indicators.resistance,

volume:
  indicators.volume,

funding:
  snapshot.premium?.lastFundingRate ??
  snapshot.funding?.fundingRate,

openInterest:
  snapshot.oi?.openInterest,

spreadPct:
  snapshot.book?.spreadPct,

recentCandles:
  candles.map(candle => ({
    time:
      candle.time,

    open:
      candle.open,

    high:
      candle.high,

    low:
      candle.low,

    close:
      candle.close,

    volume:
      candle.volume
  }))
```

};
}

async function generateH4Article(snapshot) {
const client =
getOpenAIClient();

const market =
buildMarketPayload(snapshot);

const prompt = `
Bạn là một trader crypto chuyên viết bài update thị trường cho cộng đồng.

Hãy viết một bài phân tích BTC khung H4 bằng tiếng Việt, văn phong gần gũi trader, rõ ràng, không quá dài.

Yêu cầu bài viết:

1. Có tiêu đề ngắn.
2. Nhận định xu hướng chính H4.
3. Phân tích EMA, RSI, MACD, volume nếu có dữ liệu.
4. Nêu vùng hỗ trợ và kháng cự quan trọng.
5. Nêu kịch bản LONG/SHORT/WAIT theo kiểu tham khảo.
6. Có cảnh báo rủi ro.
7. Không khẳng định chắc chắn giá sẽ tăng/giảm.
8. Không nói đây là lời khuyên đầu tư.
9. Không nhắc đến bot đang trade, lệnh BingX hoặc API.
10. Không dùng markdown bảng.
11. Có thể dùng emoji vừa phải.
12. Viết như bài đăng channel Telegram cho cộng đồng trader.

Dữ liệu thị trường:
${JSON.stringify(market)}
`;

const response =
await client.responses.create({
model:
CONFIG.openaiModel,

```
  input:
    prompt,

  max_output_tokens:
    1200
});
```

const text =
response.output_text ||
'';

if (!text.trim()) {
throw new Error(
'OpenAI không trả về bài phân tích H4'
);
}

return text.trim();
}

function buildTelegramMessage(
article,
snapshot
) {
const indicators =
snapshot.indicators || {};

const header = [
'📊 <b>FBT - BTC H4 UPDATE</b>',
'',
`📌 <b>Symbol:</b> ${escapeHtml(snapshot.symbol)}`,
`⏱ <b>Khung:</b> H4`,
`💰 <b>Giá:</b> ${formatNumber(indicators.lastClose, 2)}`,
`📈 <b>Trend:</b> ${escapeHtml(indicators.trend || 'N/A')}`,
''
].join('\n');

const footer = [
'',
'<i>Thông tin chỉ mang tính tham khảo, không phải lời khuyên đầu tư.</i>'
].join('\n');

return (
header +
escapeHtml(article) +
footer
);
}

async function sendTelegramMessage(
target,
text
) {
const url =
`https://api.telegram.org/bot` +
`${target.botToken}/sendMessage`;

const response =
await axios.post(
url,
{
chat_id:
target.chatId,

```
    text,

    parse_mode:
      'HTML',

    disable_web_page_preview:
      true
  },
  {
    timeout: 20000
  }
);
```

if (!response.data?.ok) {
throw new Error(
`Telegram gửi thất bại: ` +
`${JSON.stringify(response.data)}`
);
}

return {
sent: true,

```
chatId:
  target.chatId,

messageId:
  response.data.result?.message_id
```

};
}

async function sendH4ArticleToAllChannels(
article,
snapshot
) {
const targets =
buildReportTargets();

const text =
buildTelegramMessage(
article,
snapshot
);

const settled =
await Promise.allSettled(
targets.map(target =>
sendTelegramMessage(
target,
text
)
)
);

const results =
settled.map((item, index) => {
const target =
targets[index];

```
  if (item.status === 'fulfilled') {
    return {
      ok: true,

      chatId:
        target.chatId,

      botToken:
        maskToken(target.botToken),

      result:
        item.value
    };
  }

  return {
    ok: false,

    chatId:
      target.chatId,

    botToken:
      maskToken(target.botToken),

    error:
      item.reason?.response?.data ||
      item.reason?.message ||
      String(item.reason)
  };
});
```

const successCount =
results.filter(item => item.ok).length;

const failedCount =
results.length - successCount;

console.log(
'Kết quả gửi H4 report:',
{
total:
results.length,

```
  success:
    successCount,

  failed:
    failedCount,

  results
}
```

);

return {
total:
results.length,

```
success:
  successCount,

failed:
  failedCount,

results
```

};
}

export async function runH4ReportOnce() {
const raw =
await buildMarketSnapshot('4h');

const snapshot =
addIndicators(raw);

const article =
await generateH4Article(snapshot);

const telegramResult =
await sendH4ArticleToAllChannels(
article,
snapshot
);

console.log(
'Đã xử lý H4 report:',
telegramResult
);

return {
snapshot,
article,
telegramResult
};
}

export async function checkAndSendH4Report() {
if (isH4ReportRunning) {
console.log(
'H4 report đang chạy, bỏ qua lần check này...'
);

```
return;
```

}

const check =
shouldSendH4ReportNow();

if (!check.shouldSend) {
return;
}

isH4ReportRunning = true;

try {
console.log(
`Đến giờ gửi H4 report: ${check.timeParts.fullKey}`
);

```
await runH4ReportOnce();

lastReportKey =
  check.timeParts.fullKey;
```

} catch (error) {
console.error(
'Gửi H4 report lỗi:',
error.response?.data ||
error.message ||
String(error)
);
} finally {
isH4ReportRunning = false;
}
}

export function startH4ReportScheduler() {
if (!CONFIG.h4ReportEnabled) {
console.log(
'H4 report scheduler: OFF'
);

```
return;
```

}

console.log(
'H4 report scheduler: ON'
);

console.log(
`H4 report times: ${(CONFIG.h4ReportTimes || []).join(', ')}`
);

console.log(
`H4 report timezone: ${CONFIG.h4ReportTimezone}`
);

console.log(
`H4 report targets: ${
      Array.isArray(CONFIG.h4ReportChatIds)
        ? CONFIG.h4ReportChatIds.length
        : 0
    } channel(s)`
);

/*

* Check mỗi phút để không bị lỡ mốc giờ.
  */
  setInterval(
  async () => {
  await checkAndSendH4Report();
  },
  60 * 1000
  );

/*

* Check ngay lúc bot vừa start.
  */
  checkAndSendH4Report();
  }
