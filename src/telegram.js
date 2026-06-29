import axios from 'axios';
import { CONFIG } from './config.js';

const lastAlerts = new Map();

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

function createAlertKey(decision) {
  return [
    CONFIG.symbol,
    decision.signal?.signal,
    decision.signal?.entry,
    decision.signal?.stopLoss,
    decision.signal?.takeProfit1,
    decision.signal?.takeProfit2
  ].join('|');
}

function shouldSendAlert(decision) {
  const key = createAlertKey(decision);
  const previousAlertAt = lastAlerts.get(key);

  if (!previousAlertAt) {
    return true;
  }

  const elapsedSeconds = (Date.now() - previousAlertAt) / 1000;

  return elapsedSeconds >= CONFIG.telegramAlertCooldownSeconds;
}

function markAlertSent(decision) {
  lastAlerts.set(createAlertKey(decision), Date.now());
}

function buildSignalMessage(decision, snapshot) {
  const signal = decision.signal;
  const indicators = snapshot?.indicators || {};

  const signalIcon = signal.signal === 'LONG' ? '🔵' : '🔴';
  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const fundingPct = Number(funding) * 100;

  return [
    `${signalIcon} <b>AI TRADE SIGNAL — ${escapeHtml(signal.signal)}</b>`,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(CONFIG.symbol)}`,
    `⏱ <b>Khung:</b> ${escapeHtml(CONFIG.interval)}`,
    `🎯 <b>Confidence:</b> ${formatNumber(signal.confidence, 2)}%`,
    '',
    `📍 <b>Entry:</b> ${formatNumber(signal.entry, 8)}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(signal.stopLoss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(signal.takeProfit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(signal.takeProfit2, 8)}`,
    '',
    `⚖️ <b>RR:</b> ${formatNumber(decision.rr, 2)}`,
    `📦 <b>Quantity:</b> ${formatNumber(decision.quantity, 8)}`,
    `💵 <b>Notional:</b> ${formatNumber(decision.notional, 2)} USDT`,
    `⚡ <b>Leverage:</b> x${formatNumber(decision.leverage, 0)}`,
    '',
    `📊 <b>Trend:</b> ${escapeHtml(indicators.trend || 'N/A')}`,
    `📈 <b>RSI:</b> ${formatNumber(indicators.rsi, 2)}`,
    `💰 <b>Funding:</b> ${formatNumber(fundingPct, 5)}%`,
    `📖 <b>Spread:</b> ${formatNumber(decision.spreadPct, 5)}%`,
    '',
    `🧠 <b>Nhận định:</b> ${escapeHtml(signal.reason)}`,
    `⚠️ <b>Rủi ro:</b> ${escapeHtml(signal.riskNote)}`,
    '',
    '<i>Tín hiệu tự động, chỉ mang tính tham khảo.</i>'
  ].join('\n');
}

export async function sendTelegramMessage(text) {
  if (!CONFIG.telegramEnabled) {
    return {
      sent: false,
      reason: 'TELEGRAM_ENABLED=false'
    };
  }

  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    throw new Error(
      'Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
    );
  }

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

export async function notifyApprovedSignal(decision, snapshot) {
  const signal = decision?.signal?.signal;

  if (!decision?.approved) {
    return {
      sent: false,
      reason: 'Decision chưa được duyệt'
    };
  }

  if (!['LONG', 'SHORT'].includes(signal)) {
    return {
      sent: false,
      reason: `Không gửi tín hiệu ${signal || 'UNKNOWN'}`
    };
  }

  if (!shouldSendAlert(decision)) {
    return {
      sent: false,
      reason: 'Tín hiệu trùng, đang trong thời gian cooldown'
    };
  }

  const message = buildSignalMessage(decision, snapshot);
  const result = await sendTelegramMessage(message);

  if (result.sent) {
    markAlertSent(decision);
  }

  return result;
}
