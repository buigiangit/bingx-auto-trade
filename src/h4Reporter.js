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

function listFromValue(value, defaultValue = '') {
if (Array.isArray(value)) {
return value
.map(item => String(item).trim())
.filter(Boolean);
}

return String(value || defaultValue)
.split(',')
.map(item => item.trim())
.filter(Boolean);
}

function getReportConfig() {
const enabled =
CONFIG.h4ReportEnabled === true ||
process.env.H4_REPORT_ENABLED === 'true';

const times = listFromValue(
CONFIG.h4ReportTimes,
process.env.H4_REPORT_TIMES ||
'03:05,07:05,11:05,15:05,19:05,23:05'
);

const timezone =
CONFIG.h4ReportTimezone ||
process.env.H4_REPORT_TIMEZONE ||
'Asia/Ho_Chi_Minh';

const botTokens = listFromValue(
CONFIG.h4ReportBotTokens,
process.env.H4_REPORT_BOT_TOKENS || ''
);

const chatIds = listFromValue(
CONFIG.h4ReportChatIds,
process.env.H4_REPORT_CHAT_IDS || ''
);

return {
enabled,
times,
timezone,
botTokens,
chatIds
};
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
const reportConfig = getReportConfig();

const formatter = new Intl.DateTimeFormat(
'en-CA',
{
timeZone: reportConfig.timezone,
year: 'numeric',
month: '2-digit',
day: '2-digit',
hour: '2-digit',
minute: '2-digit',
hour12: false,
hourCycle: 'h23'
}
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


timeKey:
  `${parts.hour}:${parts.minute}`,

fullKey:
  `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`


};
}

function shouldSendH4ReportNow() {
const reportConfig = getReportConfig();

if (!reportConfig.enabled) {
return {
shouldSend: false,
reason: 'H4_REPORT_ENABLED=false'
};
}

if (reportConfig.times.length === 0) {
return {
shouldSend: false,
reason: 'Chưa cấu hình H4_REPORT_TIMES'
};
}

const timeParts =
getVietnamTimeParts();

const matched =
reportConfig.times.includes(
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
const reportConfig = getReportConfig();

const tokens =
reportConfig.botTokens;

const chatIds =
reportConfig.chatIds;

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


};
}

function extractOpenAIText(response) {
if (
typeof response?.output_text === 'string' &&
response.output_text.trim()
) {
return response.output_text.trim();
}

const output =
Array.isArray(response?.output)
? response.output
: [];

const parts = [];

for (const item of output) {
const content =
Array.isArray(item?.content)
? item.content
: [];


for (const block of content) {
  if (typeof block?.text === 'string') {
    parts.push(block.text);
  }
}


}

return parts.join('\n').trim();
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
13. Độ dài tối đa khoảng 2.500 ký tự.

Dữ liệu thị trường:
${JSON.stringify(market)}
`;

const response =
await client.responses.create({
model:
CONFIG.openaiModel,


  input:
    prompt,

  max_output_tokens:
    900
});


const text =
extractOpenAIText(response);

if (!text.trim()) {
throw new Error(
'OpenAI không trả về bài phân tích H4'
);
}

return text.trim();
}

function splitTextByLength(text, maxLength = 2600) {
const paragraphs = String(text || '')
.split('\n');

const chunks = [];
let current = '';

for (const paragraph of paragraphs) {
const candidate =
current
? `${current}\n${paragraph}`
: paragraph;


if (candidate.length <= maxLength) {
  current = candidate;
  continue;
}

if (current) {
  chunks.push(current);
  current = '';
}

if (paragraph.length <= maxLength) {
  current = paragraph;
  continue;
}

for (
  let index = 0;
  index < paragraph.length;
  index += maxLength
) {
  chunks.push(
    paragraph.slice(
      index,
      index + maxLength
    )
  );
}


}

if (current) {
chunks.push(current);
}

return chunks.length > 0
? chunks
: [text];
}

function buildTelegramMessages(
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

const chunks =
splitTextByLength(article, 2600);

return chunks.map((chunk, index) => {
const isFirst =
index === 0;


const isLast =
  index === chunks.length - 1;

return [
  isFirst ? header : '',
  escapeHtml(chunk),
  isLast ? footer : ''
]
  .filter(Boolean)
  .join('');


});
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


if (!response.data?.ok) {
throw new Error(
`Telegram gửi thất bại: ` +
`${JSON.stringify(response.data)}`
);
}

return {
sent: true,


chatId:
  target.chatId,

messageId:
  response.data.result?.message_id


};
}

async function sendArticleToTarget(
target,
messages
) {
const sentMessages = [];

for (const text of messages) {
const result =
await sendTelegramMessage(
target,
text
);


sentMessages.push(result);


}

return {
chatId:
target.chatId,


sent:
  true,

messages:
  sentMessages


};
}

async function sendH4ArticleToAllChannels(
article,
snapshot
) {
const targets =
buildReportTargets();

const messages =
buildTelegramMessages(
article,
snapshot
);

const settled =
await Promise.allSettled(
targets.map(target =>
sendArticleToTarget(
target,
messages
)
)
);

const results =
settled.map((item, index) => {
const target =
targets[index];


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


const successCount =
results.filter(item => item.ok).length;

const failedCount =
results.length - successCount;

console.log(
'Kết quả gửi H4 report:',
{
total:
results.length,


  success:
    successCount,

  failed:
    failedCount,

  results
}


);

return {
total:
results.length,


success:
  successCount,

failed:
  failedCount,

results


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


return;


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


await runH4ReportOnce();

lastReportKey =
  check.timeParts.fullKey;


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
const reportConfig =
getReportConfig();

if (!reportConfig.enabled) {
console.log(
'H4 report scheduler: OFF'
);

return;

}

console.log(
'H4 report scheduler: ON'
);

console.log(
`H4 report times: ${reportConfig.times.join(', ')}`
);

console.log(
`H4 report timezone: ${reportConfig.timezone}`
);

console.log(
`H4 report targets: ${reportConfig.chatIds.length} channel(s)`
);

setInterval(
async () => {
await checkAndSendH4Report();
},
60 * 1000
);

checkAndSendH4Report();
}
