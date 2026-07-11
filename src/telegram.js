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

function formatEntry2(value, direction) {
  const number = Number(value);

  if (Number.isFinite(number) && number > 0) {
    return formatNumber(number, 8);
  }

  return direction === 'LONG'
    ? 'Chờ hồi về vùng hỗ trợ đẹp'
    : 'Chờ hồi lên vùng kháng cự đẹp';
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
    snapshot?.interval ||
    CONFIG.entryInterval ||
    CONFIG.interval ||
    'N/A'
  );
}

/**
 * Nội dung call kèo cho FBT hiện tại.
 */
function buildFbtSignalMessage(
  decision,
  snapshot
) {
  const signal = decision.signal;
  const isDca = decision.isDca === true;

  const direction =
    String(signal.signal || '')
      .trim()
      .toUpperCase();

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

/**
 * Nội dung riêng cho CDT.
 *
 * Phong cách:
 * - Thư ký báo kèo
 * - Gọn hơn FBT
 * - Không đưa Quantity, Notional
 * - Không nói trạng thái order/sàn
 */
function buildCdtSignalMessage(
  decision,
  snapshot
) {
  const signal = decision.signal;

  const direction =
    String(signal.signal || '')
      .trim()
      .toUpperCase();

  const isLong =
    direction === 'LONG';

  const directionIcon = isLong
    ? '🔵'
    : '🔴';

  const directionText = isLong
    ? 'ƯU TIÊN LONG'
    : 'ƯU TIÊN SHORT';

  const entry1 =
    signal.entry1 ??
    signal.entry;

  const entry2 =
    signal.entry2;

  const entry2Description = isLong
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
    `⚠️ <b>Lưu ý:</b> ${escapeHtml(signal.riskNote || 'Không FOMO, ưu tiên chia vốn tại hai vùng entry.')}`,
    '',
    '<b>Anh em chủ động quản lý vốn, không all-in và không đuổi giá.</b>',
    '',
    '<i>Nội dung mang tính tham khảo, không phải lời khuyên đầu tư.</i>'
  ].join('\n');
}

/**
 * Gửi một tin nhắn Telegram.
 */
async function postTelegramMessage({
  botToken,
  chatId,
  text,
  targetName
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

  const response =
    await axios.post(
      url,
      {
        chat_id:
          chatId,

        text,

        parse_mode:
          'HTML',

        disable_web_page_preview:
          true
      },
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
 * Gửi tín hiệu đồng thời vào:
 * - FBT hiện tại
 * - Group CDT
 *
 * Một nơi lỗi sẽ không làm nơi còn lại ngừng gửi.
 */
export async function sendCommunitySignalToTelegram(
  decision,
  snapshot
) {
  if (
    !decision?.approved ||
    !['LONG', 'SHORT'].includes(
      decision?.signal?.signal
    )
  ) {
    return {
      sent: false,
      reason:
        'Tín hiệu chưa đủ điều kiện gửi Telegram'
    };
  }

  const sendTasks = [];
  const taskNames = [];

  /**
   * FBT hiện tại.
   */
  if (CONFIG.telegramEnabled) {
    if (
      !CONFIG.telegramBotToken ||
      !CONFIG.telegramChatId
    ) {
      console.error(
        'FBT Telegram thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID'
      );
    } else {
      taskNames.push('FBT');

      sendTasks.push(
        postTelegramMessage({
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
        })
      );
    }
  }

  /**
   * Group CDT.
   */
  if (CONFIG.cdtTelegramEnabled) {
    if (
      !CONFIG.cdtTelegramBotToken ||
      !CONFIG.cdtTelegramChatId
    ) {
      console.error(
        'CDT Telegram thiếu CDT_TELEGRAM_BOT_TOKEN hoặc CDT_TELEGRAM_CHAT_ID'
      );
    } else {
      taskNames.push('CDT');

      sendTasks.push(
        postTelegramMessage({
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
        })
      );
    }
  }

  if (sendTasks.length === 0) {
    return {
      sent: false,
      reason:
        'Không có Telegram FBT hoặc CDT nào được bật/cấu hình'
    };
  }

  const settled =
    await Promise.allSettled(
      sendTasks
    );

  const results =
    settled.map(
      (item, index) => {
        const target =
          taskNames[index];

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
      item => item.ok === true
    );

  const failedResults =
    results.filter(
      item => item.ok !== true
    );

  console.log(
    'Kết quả gửi Telegram:',
    {
      success:
        successResults.length,

      failed:
        failedResults.length,

      results
    }
  );

  const firstSuccess =
    successResults[0];

  return {
    /**
     * Giữ tương thích với executor.js cũ.
     */
    sent:
      successResults.length > 0,

    messageId:
      firstSuccess?.messageId ||
      null,

    /**
     * Kết quả riêng từng group.
     */
    fbt:
      results.find(
        item => item.target === 'FBT'
      ) || null,

    cdt:
      results.find(
        item => item.target === 'CDT'
      ) || null,

    results
  };
}
