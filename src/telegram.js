import axios from 'axios';
import { CONFIG } from './config.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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

function buildCommunitySignalMessage(
  decision,
  snapshot
) {
  const signal = decision.signal;
  const isDca = decision.isDca === true;

  const isLong = signal.signal === 'LONG';

  const directionIcon = isLong
    ? '🔵'
    : '🔴';

  const title = isDca
    ? `${directionIcon} <b>DCA ${escapeHtml(signal.signal)}</b>`
    : `${directionIcon} <b>LỆNH ${escapeHtml(signal.signal)}</b>`;

  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const fundingPct =
    Number(funding) * 100;

  const typeText = isDca
    ? 'DCA'
    : 'Entry mới';

  return [
    '<b>FBT - Auto Trade</b>',
    title,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(CONFIG.symbol)}`,
    `⏱ <b>Khung:</b> ${escapeHtml(CONFIG.interval)}`,
    `📊 <b>Loại:</b> ${typeText}`,
    '',
    `📍 <b>Entry:</b> ${formatNumber(signal.entry, 8)}`,
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
    '<i>Thông tin chỉ mang tính tham khảo, không phải lời khuyên đầu tư.</i>'
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
