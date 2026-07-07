import axios from 'axios';
import { CONFIG } from './config.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&')
    .replaceAll('<', '<')
    .replaceAll('>', '>');
}

function formatNumber(value, digits = 4) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  return number.toLocaleString('en-US', {
    maximumFractionDigits: digits
  });
}

function formatEntry2(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return 'Chờ hồi về vùng đẹp';
  }

  return formatNumber(number, 8);
}

function getDisplayInterval(snapshot) {
  return (
    snapshot?.interval ||
    CONFIG.entryInterval ||
    CONFIG.interval ||
    'N/A'
  );
}

function buildCommunitySignalMessage(
  decision,
  snapshot
) {
  const signal = decision.signal;
  const isDca = decision.isDca === true;

  const direction =
    String(signal.signal || '').toUpperCase();

  const isLong =
    direction === 'LONG';

  const directionIcon = isLong
    ? '🔵'
    : '🔴';

  const title = isDca
    ? `${directionIcon} <b>DCA ${escapeHtml(direction)}</b>`
    : `${directionIcon} <b>LỆNH ${escapeHtml(direction)}</b>`;

  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const fundingPct =
    Number(funding) * 100;

  const typeText = isDca
    ? 'DCA'
    : 'Entry mới';

  const entry1 =
    signal.entry1 ??
    signal.entry;

  const entry2 =
    signal.entry2;

  const entry2Label = isLong
    ? 'Entry 2 - hỗ trợ đẹp'
    : 'Entry 2 - kháng cự đẹp';

  return [
    title,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(CONFIG.symbol)}`,
    `⏱ <b>Khung entry:</b> ${escapeHtml(getDisplayInterval(snapshot))}`,
    `📊 <b>Loại:</b> ${escapeHtml(typeText)}`,
    '',
    `📍 <b>Entry 1:</b> ${formatNumber(entry1, 8)}`,
    `📍 <b>${escapeHtml(entry2Label)}:</b> ${formatEntry2(entry2)}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(signal.stopLoss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(signal.takeProfit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(signal.takeProfit2, 8)}`,
    '',
    `📦 <b>Quantity:</b> ${formatNumber(decision.quantity, 8)}`,
    `💵 <b>Notional:</b> ${formatNumber(decision.notional, 2)} USDT`,
    `⚡ <b>Leverage:</b> x${formatNumber(
      decision.leverage ?? CONFIG.maxLeverage,
      0
    )}`,
    `⚖️ <b>RR:</b> ${formatNumber(decision.rr, 2)}`,
    `🎯 <b>Confidence:</b> ${formatNumber(signal.confidence, 2)}%`,
    `💰 <b>Funding:</b> ${formatNumber(fundingPct, 5)}%`,
    '',
    `🧠 <b>Lý do:</b> ${escapeHtml(signal.reason || '')}`,
    `⚠️ <b>Lưu ý:</b> ${escapeHtml(signal.riskNote || '')}`,
    '',
    '<b><i>Thông tin chỉ mang tính tham khảo, không phải lời khuyên đầu tư.</i></b>'
  ].join('\n');
}

export async function sendCommunitySignalToTelegram(
  decision,
  snapshot
) {
  if (!CONFIG.telegramEnabled) {
    return {
      sent: false,
      reason: 'TELEGRAM_ENABLED=false'
    };
  }

  if (
    !CONFIG.telegramBotToken ||
    !CONFIG.telegramChatId
  ) {
    throw new Error(
      'Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
    );
  }

  if (
    !decision?.approved ||
    !['LONG', 'SHORT'].includes(
      decision?.signal?.signal
    )
  ) {
    return {
      sent: false,
      reason: 'Tín hiệu chưa đủ điều kiện gửi Telegram'
    };
  }

  const text = buildCommunitySignalMessage(
    decision,
    snapshot
  );

  const url =
    `https://api.telegram.org/bot` +
    `${CONFIG.telegramBotToken}/sendMessage`;

  const response = await axios.post(
    url,
    {
      chat_id: CONFIG.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    },
    {
      timeout: 15000
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
    messageId:
      response.data.result?.message_id
  };
}
