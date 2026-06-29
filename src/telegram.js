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

function getTelegramUrl(method) {
  return (
    `https://api.telegram.org/bot` +
    `${CONFIG.telegramBotToken}/${method}`
  );
}

function buildOrderMessage(
  decision,
  snapshot,
  state,
  order = null,
  errorMessage = ''
) {
  const signal = decision.signal;
  const isDca = decision.isDca === true;

  const icon =
    signal.signal === 'LONG'
      ? '🔵'
      : '🔴';

  let title;

  if (state === 'SENDING') {
    title = isDca
      ? `⏳ ${icon} <b>ĐANG GỬI DCA ${escapeHtml(signal.signal)}</b>`
      : `⏳ ${icon} <b>ĐANG GỬI LỆNH ${escapeHtml(signal.signal)}</b>`;
  } else if (state === 'SUCCESS') {
    title = isDca
      ? `✅ ${icon} <b>ĐÃ GỬI DCA ${escapeHtml(signal.signal)}</b>`
      : `✅ ${icon} <b>ĐÃ GỬI LỆNH ${escapeHtml(signal.signal)}</b>`;
  } else {
    title = isDca
      ? `❌ ${icon} <b>DCA ${escapeHtml(signal.signal)} BỊ TỪ CHỐI</b>`
      : `❌ ${icon} <b>LỆNH ${escapeHtml(signal.signal)} BỊ TỪ CHỐI</b>`;
  }

  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const executedEntry = Number(
    order?.avgPrice ??
    order?.price ??
    signal.entry
  );

  const executedQuantity = Number(
    order?.executedQty ??
    order?.quantity ??
    decision.quantity
  );

  const lines = [
    title,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(CONFIG.symbol)}`,
    `⏱ <b>Khung:</b> ${escapeHtml(CONFIG.interval)}`,
    `📊 <b>Loại:</b> ${isDca ? 'DCA' : 'Entry mới'}`,
    '',
    `📍 <b>Entry:</b> ${formatNumber(executedEntry, 8)}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(signal.stopLoss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(signal.takeProfit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(signal.takeProfit2, 8)}`,
    '',
    `📦 <b>Quantity:</b> ${formatNumber(executedQuantity, 8)}`,
    `💵 <b>Notional:</b> ${formatNumber(decision.notional, 2)} USDT`,
    `⚡ <b>Leverage:</b> x${formatNumber(
      decision.leverage ?? CONFIG.maxLeverage,
      0
    )}`,
    `⚖️ <b>RR:</b> ${formatNumber(decision.rr, 2)}`,
    `🎯 <b>Confidence:</b> ${formatNumber(signal.confidence, 2)}%`,
    `💰 <b>Funding:</b> ${formatNumber(Number(funding) * 100, 5)}%`,
    '',
    `🧠 <b>Lý do:</b> ${escapeHtml(signal.reason || '')}`,
    `⚠️ <b>Lưu ý:</b> ${escapeHtml(signal.riskNote || '')}`
  ];

  if (state === 'SUCCESS') {
    lines.push(
      '',
      `🆔 <b>Order ID:</b> ${escapeHtml(
        order?.orderId ??
        order?.orderID ??
        order?.clientOrderId ??
        'N/A'
      )}`,
      `📋 <b>Trạng thái:</b> ${escapeHtml(order?.status || 'SUCCESS')}`
    );
  }

  if (state === 'FAILED') {
    lines.push(
      '',
      `❗ <b>Lỗi:</b> ${escapeHtml(errorMessage || 'BingX từ chối lệnh')}`
    );
  }

  return lines.join('\n');
}

export async function sendOrderAttemptToTelegram(
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

  const text = buildOrderMessage(
    decision,
    snapshot,
    'SENDING'
  );

  const response = await axios.post(
    getTelegramUrl('sendMessage'),
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

export async function updateOrderTelegramStatus(
  messageId,
  decision,
  snapshot,
  state,
  order = null,
  errorMessage = ''
) {
  if (
    !CONFIG.telegramEnabled ||
    !messageId
  ) {
    return {
      updated: false
    };
  }

  const text = buildOrderMessage(
    decision,
    snapshot,
    state,
    order,
    errorMessage
  );

  const response = await axios.post(
    getTelegramUrl('editMessageText'),
    {
      chat_id: CONFIG.telegramChatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    },
    {
      timeout: 15000
    }
  );

  return {
    updated: response.data?.ok === true
  };
}
