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

function formatDateTime(value) {
  if (!value) {
    return 'N/A';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return date.toLocaleString('vi-VN', {
    timeZone:
      CONFIG.h4ReportTimezone ||
      'Asia/Ho_Chi_Minh'
  });
}

function formatEntry2(value, direction) {
  const number = Number(value);

  if (Number.isFinite(number) && number > 0) {
    return formatNumber(number, 8);
  }

  return direction === 'LONG'
    ? 'Chờ hồi về vùng hỗ trợ đẹp'
    : 'Chờ hồi lên vùng kháng cự đẹp';
}

function normalizeDirection(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function getSymbol(snapshot) {
  return (
    snapshot?.symbol ||
    CONFIG.symbol ||
    'BTC-USDT'
  );
}

function getDisplayInterval(snapshot) {
  return (
    snapshot?.entryInterval ||
    snapshot?.interval ||
    CONFIG.entryInterval ||
    CONFIG.interval ||
    'N/A'
  );
}

function getTradeDirection(trade) {
  return normalizeDirection(
    trade?.direction ||
    trade?.signal
  );
}

function getTradeEventPrice(
  trade,
  eventType,
  details = {}
) {
  const directPrice = Number(
    details.eventPrice ??
    details.price
  );

  if (
    Number.isFinite(directPrice) &&
    directPrice > 0
  ) {
    return directPrice;
  }

  const normalizedEvent = String(
    eventType || ''
  )
    .trim()
    .toUpperCase();

  if (normalizedEvent === 'TP1_HIT') {
    return Number(
      trade?.tp1_hit_price ??
      trade?.take_profit1
    );
  }

  if (normalizedEvent === 'TP2_HIT') {
    return Number(
      trade?.tp2_hit_price ??
      trade?.take_profit2
    );
  }

  if (normalizedEvent === 'SL_HIT') {
    return Number(
      trade?.sl_hit_price ??
      trade?.stop_loss
    );
  }

  if (normalizedEvent === 'ENTRY2_HIT') {
    return Number(
      trade?.entry2_hit_price ??
      trade?.entry2
    );
  }

  if (normalizedEvent === 'DCA') {
    return Number(
      trade?.average_entry ??
      trade?.entry2 ??
      trade?.entry1
    );
  }

  return Number(
    trade?.average_entry ??
    trade?.entry1
  );
}

function getTradeEventInfo(
  eventType,
  trade
) {
  const normalizedEvent = String(
    eventType || ''
  )
    .trim()
    .toUpperCase();

  if (normalizedEvent === 'TP1_HIT') {
    return {
      icon: '✅',
      title: 'ĐÃ CHẠM TP1',
      statusText:
        'Kèo vẫn tiếp tục theo dõi TP2 hoặc Stop Loss.',
      resultText:
        'Đạt mục tiêu lợi nhuận thứ nhất.'
    };
  }

  if (normalizedEvent === 'TP2_HIT') {
    return {
      icon: '🎯',
      title: 'ĐÃ CHẠM TP2',
      statusText:
        'Kèo đã hoàn tất và được đóng trong hệ thống thống kê.',
      resultText:
        'WIN TP2'
    };
  }

  if (normalizedEvent === 'SL_HIT') {
    const hitTp1Before = Boolean(
      trade?.tp1_hit_at
    );

    return {
      icon: '🛑',
      title: 'ĐÃ CHẠM STOP LOSS',
      statusText:
        'Kèo đã kết thúc và bot được phép chờ tín hiệu mới.',
      resultText:
        hitTp1Before
          ? 'Đã đạt TP1 trước khi quay lại SL'
          : 'LOSS SL'
    };
  }

  if (normalizedEvent === 'EXPIRED') {
    return {
      icon: '⏳',
      title: 'KÈO HẾT HIỆU LỰC',
      statusText:
        'Kèo đã được đóng theo thời gian hiệu lực cấu hình.',
      resultText:
        trade?.tp1_hit_at
          ? 'Đã đạt TP1 trước khi hết hạn'
          : 'Chưa đạt TP hoặc SL'
    };
  }

  if (normalizedEvent === 'ENTRY2_HIT') {
    return {
      icon: '📍',
      title: 'GIÁ ĐÃ CHẠM ENTRY 2',
      statusText:
        'Bot tiếp tục theo dõi điều kiện DCA, TP và SL.',
      resultText:
        'Đã vào vùng giá thứ hai'
    };
  }

  if (normalizedEvent === 'DCA') {
    return {
      icon: '🔁',
      title: 'ĐÃ GHI NHẬN DCA',
      statusText:
        'DCA được lưu vào cùng lệnh gốc, không tạo kèo mới.',
      resultText:
        `Số lần DCA: ${formatNumber(trade?.dca_count, 0)}`
    };
  }

  if (normalizedEvent === 'CANCELLED') {
    return {
      icon: '🚫',
      title: 'KÈO ĐÃ HỦY',
      statusText:
        'Kèo không còn được theo dõi trong hệ thống.',
      resultText:
        'CANCELLED'
    };
  }

  return {
    icon: 'ℹ️',
    title:
      normalizedEvent ||
      'CẬP NHẬT KÈO',

    statusText:
      'Hệ thống vừa cập nhật trạng thái của kèo.',

    resultText:
      trade?.outcome ||
      trade?.status ||
      'N/A'
  };
}

/**
 * Nội dung call kèo cho FBT.
 */
function buildFbtSignalMessage(
  decision,
  snapshot
) {
  const signal =
    decision.signal;

  const isDca =
    decision.isDca === true;

  const direction =
    normalizeDirection(
      signal.signal
    );

  const isLong =
    direction === 'LONG';

  const directionIcon =
    isLong
      ? '🔵'
      : '🔴';

  const title =
    isDca
      ? `${directionIcon} <b>DCA ${escapeHtml(direction)}</b>`
      : `${directionIcon} <b>LỆNH ${escapeHtml(direction)}</b>`;

  const funding =
    snapshot?.premium?.lastFundingRate ??
    snapshot?.funding?.fundingRate ??
    0;

  const fundingPct =
    Number(funding) * 100;

  const typeText =
    isDca
      ? 'DCA'
      : 'Entry mới';

  const entry1 =
    signal.entry1 ??
    signal.entry;

  const entry2 =
    signal.entry2;

  const entry2Label =
    isLong
      ? 'Entry 2 - hỗ trợ đẹp'
      : 'Entry 2 - kháng cự đẹp';

  return [
    title,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(getSymbol(snapshot))}`,
    `⏱ <b>Khung entry:</b> ${escapeHtml(getDisplayInterval(snapshot))}`,
    `📊 <b>Loại:</b> ${escapeHtml(typeText)}`,
    '',
    `📍 <b>Entry 1:</b> ${formatNumber(entry1, 8)}`,
    `📍 <b>${escapeHtml(entry2Label)}:</b> ${formatEntry2(entry2, direction)}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(signal.stopLoss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(signal.takeProfit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(signal.takeProfit2, 8)}`,
    '',
    `📦 <b>Quantity:</b> ${formatNumber(decision.quantity, 8)}`,
    `💵 <b>Notional:</b> ${formatNumber(decision.notional, 2)} USDT`,
    `⚡ <b>Leverage:</b> x${formatNumber(
      decision.leverage ??
      CONFIG.maxLeverage,
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

/**
 * Nội dung call kèo riêng cho CDT.
 */
function buildCdtSignalMessage(
  decision,
  snapshot
) {
  const signal =
    decision.signal;

  const direction =
    normalizeDirection(
      signal.signal
    );

  const isLong =
    direction === 'LONG';

  const directionIcon =
    isLong
      ? '🔵'
      : '🔴';

  const directionText =
    isLong
      ? 'ƯU TIÊN LONG'
      : 'ƯU TIÊN SHORT';

  const entry1 =
    signal.entry1 ??
    signal.entry;

  const entry2 =
    signal.entry2;

  const entry2Description =
    isLong
      ? 'Vùng hỗ trợ khung lớn'
      : 'Vùng kháng cự khung lớn';

  const confidence =
    Number(signal.confidence);

  let assessmentText =
    'Setup ở mức tham khảo';

  if (confidence >= 80) {
    assessmentText =
      'Setup đang có độ đồng thuận tốt';
  } else if (confidence >= 70) {
    assessmentText =
      'Setup tương đối ổn, vẫn cần quản lý vốn';
  } else if (confidence >= 60) {
    assessmentText =
      'Setup có tín hiệu nhưng độ chắc chắn chưa cao';
  }

  return [
    '📣 <b>THƯ KÝ CDT BÁO KÈO</b>',
    '',
    `${directionIcon} <b>${escapeHtml(directionText)}</b>`,
    '',
    `📌 <b>Cặp giao dịch:</b> ${escapeHtml(getSymbol(snapshot))}`,
    `⏱ <b>Khung quan sát:</b> ${escapeHtml(getDisplayInterval(snapshot))}`,
    '',
    '🎯 <b>VÙNG VÀO LỆNH</b>',
    `• <b>Entry 1:</b> ${formatNumber(entry1, 8)}`,
    `• <b>Entry 2:</b> ${formatEntry2(entry2, direction)}`,
    `• <i>${escapeHtml(entry2Description)}</i>`,
    '',
    '🛡 <b>QUẢN TRỊ RỦI RO</b>',
    `• <b>Stop Loss:</b> ${formatNumber(signal.stopLoss, 8)}`,
    `• <b>TP1:</b> ${formatNumber(signal.takeProfit1, 8)}`,
    `• <b>TP2:</b> ${formatNumber(signal.takeProfit2, 8)}`,
    '',
    `⚖️ <b>RR:</b> ${formatNumber(decision.rr, 2)}`,
    `🎯 <b>Độ tin cậy:</b> ${formatNumber(signal.confidence, 2)}%`,
    '',
    `📝 <b>Thư ký đánh giá:</b> ${escapeHtml(assessmentText)}`,
    `🧠 <b>Nhận định nhanh:</b> ${escapeHtml(signal.reason || '')}`,
    '',
    `⚠️ <b>Lưu ý:</b> ${escapeHtml(
      signal.riskNote ||
      'Không FOMO, ưu tiên chia vốn tại hai vùng entry.'
    )}`,
    '',
    '<b>Anh em chủ động quản lý vốn, không all-in và không đuổi giá.</b>',
    '',
    '<i>Nội dung mang tính tham khảo, không phải lời khuyên đầu tư.</i>'
  ].join('\n');
}

/**
 * Nội dung cập nhật TP/SL cho FBT.
 */
function buildFbtTradeEventMessage(
  trade,
  eventType,
  details = {}
) {
  const info =
    getTradeEventInfo(
      eventType,
      trade
    );

  const direction =
    getTradeDirection(trade);

  const eventPrice =
    getTradeEventPrice(
      trade,
      eventType,
      details
    );

  return [
    `${info.icon} <b>${escapeHtml(info.title)}</b>`,
    '',
    `📌 <b>Symbol:</b> ${escapeHtml(trade?.symbol || CONFIG.symbol)}`,
    `📈 <b>Hướng:</b> ${escapeHtml(direction || 'N/A')}`,
    `🆔 <b>Trade ID:</b> #${escapeHtml(trade?.id || 'N/A')}`,
    `💵 <b>Giá ghi nhận:</b> ${formatNumber(eventPrice, 8)}`,
    '',
    `📍 <b>Entry trung bình:</b> ${formatNumber(
      trade?.average_entry ??
      trade?.entry1,
      8
    )}`,
    `🛑 <b>Stop Loss:</b> ${formatNumber(trade?.stop_loss, 8)}`,
    `✅ <b>TP1:</b> ${formatNumber(trade?.take_profit1, 8)}`,
    `✅ <b>TP2:</b> ${formatNumber(trade?.take_profit2, 8)}`,
    '',
    `📊 <b>Kết quả:</b> ${escapeHtml(info.resultText)}`,
    `📝 <b>Trạng thái:</b> ${escapeHtml(info.statusText)}`,
    `🕒 <b>Thời gian:</b> ${escapeHtml(
      formatDateTime(
        details.eventTime ||
        new Date()
      )
    )}`,
    '',
    '<i>Kết quả được bot ghi nhận tự động theo dữ liệu giá thị trường.</i>'
  ].join('\n');
}

/**
 * Nội dung cập nhật TP/SL cho CDT.
 */
function buildCdtTradeEventMessage(
  trade,
  eventType,
  details = {}
) {
  const info =
    getTradeEventInfo(
      eventType,
      trade
    );

  const direction =
    getTradeDirection(trade);

  const eventPrice =
    getTradeEventPrice(
      trade,
      eventType,
      details
    );

  return [
    '📣 <b>THƯ KÝ CDT CẬP NHẬT KÈO</b>',
    '',
    `${info.icon} <b>${escapeHtml(info.title)}</b>`,
    '',
    `📌 <b>Cặp:</b> ${escapeHtml(trade?.symbol || CONFIG.symbol)}`,
    `📈 <b>Hướng:</b> ${escapeHtml(direction || 'N/A')}`,
    `💵 <b>Giá ghi nhận:</b> ${formatNumber(eventPrice, 8)}`,
    `📊 <b>Kết quả:</b> ${escapeHtml(info.resultText)}`,
    '',
    `📝 ${escapeHtml(info.statusText)}`,
    '',
    '<b>Anh em tiếp tục tuân thủ quản lý vốn, không tự ý đuổi theo giá.</b>',
    '',
    '<i>Dữ liệu được hệ thống tự động ghi nhận để thống kê chất lượng tín hiệu AI.</i>'
  ].join('\n');
}

/**
 * Gửi một tin nhắn Telegram.
 */
async function postTelegramMessage({
  botToken,
  chatId,
  text,
  targetName,
  replyToMessageId = null
}) {
  if (!botToken || !chatId) {
    return {
      sent: false,

      target:
        targetName,

      reason:
        `Thiếu token hoặc chat id của ${targetName}`
    };
  }

  const url =
    `https://api.telegram.org/bot` +
    `${botToken}/sendMessage`;

  const payload = {
    chat_id:
      chatId,

    text,

    parse_mode:
      'HTML',

    disable_web_page_preview:
      true
  };

  const numericReplyId =
    Number(replyToMessageId);

  if (
    Number.isFinite(numericReplyId) &&
    numericReplyId > 0
  ) {
    payload.reply_parameters = {
      message_id:
        numericReplyId,

      allow_sending_without_reply:
        true
    };
  }

  const response =
    await axios.post(
      url,
      payload,
      {
        timeout:
          15000
      }
    );

  if (!response.data?.ok) {
    throw new Error(
      `${targetName} gửi thất bại: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return {
    sent: true,

    target:
      targetName,

    chatId,

    messageId:
      response.data.result?.message_id
  };
}

/**
 * Gửi nhiều đích Telegram độc lập.
 */
async function sendTelegramTasks(tasks) {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0
  ) {
    return {
      sent: false,
      messageId: null,
      fbt: null,
      cdt: null,
      results: [],

      reason:
        'Không có Telegram FBT hoặc CDT nào được bật/cấu hình'
    };
  }

  const settled =
    await Promise.allSettled(
      tasks.map(task =>
        postTelegramMessage(task)
      )
    );

  const results =
    settled.map(
      (item, index) => {
        const target =
          tasks[index].targetName;

        if (
          item.status === 'fulfilled'
        ) {
          return {
            ok: true,
            target,
            ...item.value
          };
        }

        const errorMessage =
          item.reason?.response?.data
            ?.description ||
          item.reason?.response?.data ||
          item.reason?.message ||
          String(item.reason);

        return {
          ok: false,
          sent: false,
          target,

          error:
            errorMessage
        };
      }
    );

  const successResults =
    results.filter(
      item =>
        item.ok === true
    );

  const firstSuccess =
    successResults[0];

  return {
    sent:
      successResults.length > 0,

    messageId:
      firstSuccess?.messageId ||
      null,

    fbt:
      results.find(
        item =>
          item.target === 'FBT'
      ) || null,

    cdt:
      results.find(
        item =>
          item.target === 'CDT'
      ) || null,

    results
  };
}

/**
 * Gửi tín hiệu mới hoặc DCA vào FBT và CDT.
 */
export async function sendCommunitySignalToTelegram(
  decision,
  snapshot
) {
  const direction =
    normalizeDirection(
      decision?.signal?.signal
    );

  if (
    !decision?.approved ||
    ![
      'LONG',
      'SHORT'
    ].includes(direction)
  ) {
    return {
      sent: false,

      reason:
        'Tín hiệu chưa đủ điều kiện gửi Telegram'
    };
  }

  const tasks = [];

  if (CONFIG.telegramEnabled) {
    if (
      !CONFIG.telegramBotToken ||
      !CONFIG.telegramChatId
    ) {
      console.error(
        'FBT Telegram thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
      );
    } else {
      tasks.push({
        botToken:
          CONFIG.telegramBotToken,

        chatId:
          CONFIG.telegramChatId,

        text:
          buildFbtSignalMessage(
            decision,
            snapshot
          ),

        targetName:
          'FBT'
      });
    }
  }

  if (CONFIG.cdtTelegramEnabled) {
    if (
      !CONFIG.cdtTelegramBotToken ||
      !CONFIG.cdtTelegramChatId
    ) {
      console.error(
        'CDT Telegram thiếu CDT_TELEGRAM_BOT_TOKEN hoặc CDT_TELEGRAM_CHAT_ID'
      );
    } else {
      tasks.push({
        botToken:
          CONFIG.cdtTelegramBotToken,

        chatId:
          CONFIG.cdtTelegramChatId,

        text:
          buildCdtSignalMessage(
            decision,
            snapshot
          ),

        targetName:
          'CDT'
      });
    }
  }

  const result =
    await sendTelegramTasks(
      tasks
    );

  console.log(
    'Kết quả gửi Telegram signal:',
    result
  );

  return result;
}

/**
 * Gửi cập nhật TP1, TP2, SL hoặc hết hạn.
 *
 * trade là row từ bảng ai_trades.
 */
export async function sendTradeEventToTelegram(
  trade,
  eventType,
  details = {}
) {
  const normalizedEvent =
    String(eventType || '')
      .trim()
      .toUpperCase();

  const supportedEvents = [
    'TP1_HIT',
    'TP2_HIT',
    'SL_HIT',
    'EXPIRED',
    'ENTRY2_HIT',
    'DCA',
    'CANCELLED'
  ];

  if (!trade?.id) {
    return {
      sent: false,

      reason:
        'Thiếu dữ liệu trade để gửi cập nhật Telegram'
    };
  }

  if (
    !supportedEvents.includes(
      normalizedEvent
    )
  ) {
    return {
      sent: false,

      reason:
        `Event Telegram không hỗ trợ: ${normalizedEvent}`
    };
  }

  const tasks = [];

  if (
    CONFIG.telegramEnabled &&
    CONFIG.telegramBotToken &&
    CONFIG.telegramChatId
  ) {
    tasks.push({
      botToken:
        CONFIG.telegramBotToken,

      chatId:
        CONFIG.telegramChatId,

      text:
        buildFbtTradeEventMessage(
          trade,
          normalizedEvent,
          details
        ),

      targetName:
        'FBT',

      replyToMessageId:
        trade.telegram_fbt_message_id
    });
  }

  if (
    CONFIG.cdtTelegramEnabled &&
    CONFIG.cdtTelegramBotToken &&
    CONFIG.cdtTelegramChatId
  ) {
    tasks.push({
      botToken:
        CONFIG.cdtTelegramBotToken,

      chatId:
        CONFIG.cdtTelegramChatId,

      text:
        buildCdtTradeEventMessage(
          trade,
          normalizedEvent,
          details
        ),

      targetName:
        'CDT',

      replyToMessageId:
        trade.telegram_cdt_message_id
    });
  }

  const result =
    await sendTelegramTasks(
      tasks
    );

  console.log(
    `Kết quả gửi Telegram event ${normalizedEvent}:`,
    result
  );

  return result;
}

/**
 * Chia báo cáo thành nhiều tin nhắn
 * để không vượt giới hạn Telegram.
 */
function splitWeeklyReportMessage(
  text,
  maxLength = 3900
) {
  const content =
    String(text || '')
      .trim();

  if (!content) {
    return [];
  }

  if (
    content.length <=
    maxLength
  ) {
    return [
      content
    ];
  }

  const lines =
    content.split('\n');

  const chunks = [];
  let currentChunk = '';

  for (
    const line of lines
  ) {
    const candidate =
      currentChunk
        ? `${currentChunk}\n${line}`
        : line;

    if (
      candidate.length <=
      maxLength
    ) {
      currentChunk =
        candidate;

      continue;
    }

    if (currentChunk) {
      chunks.push(
        currentChunk
      );

      currentChunk = '';
    }

    /*
     * Trường hợp một dòng riêng lẻ
     * vẫn dài hơn giới hạn Telegram.
     */
    if (
      line.length >
      maxLength
    ) {
      let remaining =
        line;

      while (
        remaining.length >
        maxLength
      ) {
        chunks.push(
          remaining.slice(
            0,
            maxLength
          )
        );

        remaining =
          remaining.slice(
            maxLength
          );
      }

      currentChunk =
        remaining;
    } else {
      currentChunk =
        line;
    }
  }

  if (currentChunk) {
    chunks.push(
      currentChunk
    );
  }

  return chunks;
}

/**
 * Gửi nhiều phần của báo cáo
 * tới một group Telegram.
 */
async function sendWeeklyReportToTarget({
  botToken,
  chatId,
  html,
  targetName
}) {
  const chunks =
    splitWeeklyReportMessage(
      html
    );

  if (
    chunks.length === 0
  ) {
    return {
      sent: false,

      target:
        targetName,

      reason:
        'Nội dung báo cáo tuần đang trống'
    };
  }

  const messageIds = [];

  for (
    let index = 0;
    index < chunks.length;
    index += 1
  ) {
    let text =
      chunks[index];

    /*
     * Khi báo cáo bị chia thành
     * nhiều phần, thêm số thứ tự.
     */
    if (
      chunks.length > 1 &&
      index > 0
    ) {
      text = [
        `📊 <b>TỔNG KẾT TUẦN - PHẦN ${index + 1}/${chunks.length}</b>`,
        '',
        text
      ].join('\n');
    }

    const result =
      await postTelegramMessage({
        botToken,
        chatId,
        text,
        targetName
      });

    if (
      result?.messageId
    ) {
      messageIds.push(
        result.messageId
      );
    }
  }

  return {
    sent: true,

    target:
      targetName,

    chatId,

    messageId:
      messageIds[0] ||
      null,

    lastMessageId:
      messageIds.at(-1) ||
      null,

    messageIds,

    parts:
      chunks.length
  };
}

/**
 * Gửi báo cáo tổng kết lệnh trong tuần
 * tới FBT và CDT.
 *
 * report được tạo từ weeklyReporter.js:
 *
 * {
 *   html,
 *   totals,
 *   startTime,
 *   endTime
 * }
 */
export async function sendWeeklyTradeReportToTelegram(
  report
) {
  const html =
    String(
      report?.html || ''
    ).trim();

  if (!html) {
    return {
      sent: false,
      messageId: null,
      fbt: null,
      cdt: null,
      results: [],

      reason:
        'Báo cáo tuần không có nội dung'
    };
  }

  const targets = [];

  /**
   * Gửi báo cáo vào FBT.
   */
  if (CONFIG.telegramEnabled) {
    if (
      !CONFIG.telegramBotToken ||
      !CONFIG.telegramChatId
    ) {
      console.error(
        'Weekly report FBT thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
      );
    } else {
      targets.push({
        botToken:
          CONFIG.telegramBotToken,

        chatId:
          CONFIG.telegramChatId,

        html,

        targetName:
          'FBT'
      });
    }
  }

  /**
   * Gửi báo cáo vào CDT.
   */
  if (
    CONFIG.cdtTelegramEnabled
  ) {
    if (
      !CONFIG.cdtTelegramBotToken ||
      !CONFIG.cdtTelegramChatId
    ) {
      console.error(
        'Weekly report CDT thiếu CDT_TELEGRAM_BOT_TOKEN hoặc CDT_TELEGRAM_CHAT_ID'
      );
    } else {
      targets.push({
        botToken:
          CONFIG.cdtTelegramBotToken,

        chatId:
          CONFIG.cdtTelegramChatId,

        html,

        targetName:
          'CDT'
      });
    }
  }

  if (
    targets.length === 0
  ) {
    return {
      sent: false,
      messageId: null,
      fbt: null,
      cdt: null,
      results: [],

      reason:
        'Không có Telegram FBT hoặc CDT nào được bật/cấu hình'
    };
  }

  /*
   * FBT và CDT gửi độc lập.
   * Một group lỗi không ảnh hưởng group còn lại.
   */
  const settled =
    await Promise.allSettled(
      targets.map(
        target =>
          sendWeeklyReportToTarget(
            target
          )
      )
    );

  const results =
    settled.map(
      (
        item,
        index
      ) => {
        const target =
          targets[index]
            .targetName;

        if (
          item.status ===
          'fulfilled'
        ) {
          return {
            ok: true,
            target,
            ...item.value
          };
        }

        const errorMessage =
          item.reason
            ?.response
            ?.data
            ?.description ||
          item.reason
            ?.response
            ?.data ||
          item.reason
            ?.message ||
          String(
            item.reason
          );

        return {
          ok: false,

          sent: false,

          target,

          error:
            errorMessage
        };
      }
    );

  const successResults =
    results.filter(
      item =>
        item.ok === true &&
        item.sent === true
    );

  const failedResults =
    results.filter(
      item =>
        item.ok !== true ||
        item.sent !== true
    );

  const firstSuccess =
    successResults[0];

  const telegramResult = {
    sent:
      successResults.length > 0,

    messageId:
      firstSuccess
        ?.messageId ||
      null,

    fbt:
      results.find(
        item =>
          item.target ===
          'FBT'
      ) || null,

    cdt:
      results.find(
        item =>
          item.target ===
          'CDT'
      ) || null,

    results
  };

  console.log(
    'Kết quả gửi weekly report Telegram:',
    {
      sent:
        telegramResult.sent,

      success:
        successResults.length,

      failed:
        failedResults.length,

      totalTrades:
        report?.totals
          ?.allTrades,

      resultTrades:
        report?.totals
          ?.resultTrades,

      totalRoe:
        report?.totals
          ?.totalRoe,

      results
    }
  );

  return telegramResult;
}
