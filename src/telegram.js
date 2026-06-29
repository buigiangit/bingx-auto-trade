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

export async function sendExecutedOrderToTelegram(
  execution,
  decision,
  snapshot
) {
  if (!CONFIG.telegramEnabled) {
    return {
      sent: false,
      reason: 'Telegram đang tắt'
    };
  }

  if (!execution?.executed) {
    return {
      sent: false,
      reason: 'Order chưa được gửi thành công lên BingX'
    };
  }

  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    throw new Error(
      'Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
    );
  }

  const signal = execution.signal;
  const isDca = execution.isDca === true;

  const icon = signal === 'LONG' ? '🔵' : '🔴';

  const title = isDca
    ? `${icon} <b>ĐÃ DCA ${escapeHtml(signal)}</b>`
    : `${icon} <b>ĐÃ VÀO LỆNH ${escapeHtml(signal)}</b>`;

  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const indicators = snapshot?.indicators || {};

  const text = [
    title,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(execution.symbol)}`,
    `⏱ <b>Khung:</b> ${escapeHtml(CONFIG.interval)}`,
    `🆔 <b>Order ID:</b> ${escapeHtml(execution.orderId || 'N/A')}`,
    `📋 <b>Trạng thái:</b> ${escapeHtml(execution.status || 'N/A')}`,
    '',
    `📍 <b>Entry khớp:</b> ${formatNumber(execution.entry, 8)}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(execution.stopLoss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(execution.takeProfit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(execution.takeProfit2, 8)}`,
    '',
    `📦 <b>Quantity:</b> ${formatNumber(execution.quantity, 8)}`,
    `💵 <b>Notional:</b> ${formatNumber(execution.notional, 2)} USDT`,
    `⚡ <b>Leverage:</b> x${formatNumber(execution.leverage, 0)}`,
    `⚖️ <b>RR:</b> ${formatNumber(decision.rr, 2)}`,
    '',
    `📊 <b>Trend:</b> ${escapeHtml(indicators.trend || 'N/A')}`,
    `📈 <b>RSI:</b> ${formatNumber(indicators.rsi14 ?? indicators.rsi, 2)}`,
    `💰 <b>Funding:</b> ${formatNumber(Number(funding) * 100, 5)}%`,
    '',
    `🧠 <b>Lý do:</b> ${escapeHtml(decision.signal?.reason || '')}`,
    `⚠️ <b>Lưu ý:</b> ${escapeHtml(decision.signal?.riskNote || '')}`,
    '',
    isDca
      ? '<i>Lệnh DCA đã được gửi thành công lên BingX.</i>'
      : '<i>Lệnh đã được gửi thành công lên BingX.</i>'
  ].join('\n');

  const url =
    `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;

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
      `Telegram gửi thất bại: ${JSON.stringify(response.data)}`
    );
  }

  return {
    sent: true,
    messageId: response.data.result?.message_id
  };
}
