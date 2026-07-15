import { CONFIG } from './config.js';

import {
  getWeeklyTrades,
  isTradeRepositoryEnabled
} from './tradeRepository.js';

import {
  sendWeeklyTradeReportToTelegram
} from './telegram.js';

let weeklyReportTimer = null;
let weeklyReportRunning = false;
let lastWeeklyReportKey = null;

/**
 * Chuyển dữ liệu thành số hợp lệ.
 */
function toNumber(value, fallback = null) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

/**
 * Chuyển biến môi trường thành boolean.
 */
function parseBoolean(value, fallback = false) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return fallback;
  }

  return [
    'true',
    '1',
    'yes',
    'on'
  ].includes(
    String(value)
      .trim()
      .toLowerCase()
  );
}

/**
 * Escape HTML trước khi gửi Telegram.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Lấy cấu hình report tuần.
 */
function getWeeklyReportConfig() {
  return {
    enabled:
      CONFIG.weeklyReportEnabled ??
      parseBoolean(
        process.env.WEEKLY_REPORT_ENABLED,
        false
      ),

    day:
      CONFIG.weeklyReportDay ||
      process.env.WEEKLY_REPORT_DAY ||
      'SATURDAY',

    time:
      CONFIG.weeklyReportTime ||
      process.env.WEEKLY_REPORT_TIME ||
      '20:00',

    timezone:
      CONFIG.weeklyReportTimezone ||
      process.env.WEEKLY_REPORT_TIMEZONE ||
      'Asia/Ho_Chi_Minh'
  };
}

const REPORT_DAY_MAP = {
  SUNDAY: 0,
  SUN: 0,
  CHUNHAT: 0,

  MONDAY: 1,
  MON: 1,
  THUHAI: 1,

  TUESDAY: 2,
  TUE: 2,
  THUBA: 2,

  WEDNESDAY: 3,
  WED: 3,
  THUTU: 3,

  THURSDAY: 4,
  THU: 4,
  THUNAM: 4,

  FRIDAY: 5,
  FRI: 5,
  THUSAU: 5,

  SATURDAY: 6,
  SAT: 6,
  THUBAY: 6
};

/**
 * Chuẩn hóa ngày chạy báo cáo.
 *
 * 0 = Chủ nhật
 * 1 = Thứ hai
 * ...
 * 6 = Thứ bảy
 */
function normalizeReportDay(value) {
  const normalized =
    String(value || '')
      .trim()
      .toUpperCase();

  if (
    Object.prototype.hasOwnProperty.call(
      REPORT_DAY_MAP,
      normalized
    )
  ) {
    return REPORT_DAY_MAP[normalized];
  }

  const numeric = Number(value);

  if (
    Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric <= 6
  ) {
    return numeric;
  }

  return 6;
}

/**
 * Đọc giờ chạy dạng HH:mm.
 */
function parseReportTime(value) {
  const match =
    String(value || '20:00')
      .trim()
      .match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return {
      hour: 20,
      minute: 0
    };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  return {
    hour:
      hour >= 0 && hour <= 23
        ? hour
        : 20,

    minute:
      minute >= 0 && minute <= 59
        ? minute
        : 0
  };
}

/**
 * Lấy các thành phần thời gian
 * theo timezone được chỉ định.
 */
function getZonedParts(date, timezone) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }
    );

  const result = {};

  for (
    const part of formatter.formatToParts(date)
  ) {
    if (part.type !== 'literal') {
      result[part.type] =
        Number(part.value);
    }
  }

  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: result.hour,
    minute: result.minute,
    second: result.second
  };
}

/**
 * Chuyển một thời điểm trong timezone
 * thành Date UTC.
 */
function zonedDateTimeToUtc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  timezone
}) {
  const desiredAsUtc =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      0
    );

  let estimate = desiredAsUtc;

  for (
    let index = 0;
    index < 3;
    index += 1
  ) {
    const actual =
      getZonedParts(
        new Date(estimate),
        timezone
      );

    const actualAsUtc =
      Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
        0
      );

    const difference =
      desiredAsUtc - actualAsUtc;

    estimate += difference;

    if (difference === 0) {
      break;
    }
  }

  return new Date(estimate);
}

/**
 * Khoảng báo cáo:
 * Thứ Hai 00:00 đến thời điểm chạy report.
 */
function getWeekRange(
  now = new Date(),
  timezone = 'Asia/Ho_Chi_Minh'
) {
  const localNow =
    getZonedParts(
      now,
      timezone
    );

  const localDateAsUtc =
    new Date(
      Date.UTC(
        localNow.year,
        localNow.month - 1,
        localNow.day
      )
    );

  const localDayOfWeek =
    localDateAsUtc.getUTCDay();

  const daysSinceMonday =
    (localDayOfWeek + 6) % 7;

  localDateAsUtc.setUTCDate(
    localDateAsUtc.getUTCDate() -
    daysSinceMonday
  );

  const startTime =
    zonedDateTimeToUtc({
      year:
        localDateAsUtc.getUTCFullYear(),

      month:
        localDateAsUtc.getUTCMonth() + 1,

      day:
        localDateAsUtc.getUTCDate(),

      hour: 0,
      minute: 0,
      second: 0,
      timezone
    });

  return {
    startTime,
    endTime: new Date(now)
  };
}

/**
 * Hiển thị ngày theo timezone.
 */
function formatDate(value, timezone) {
  return new Intl.DateTimeFormat(
    'vi-VN',
    {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }
  ).format(
    new Date(value)
  );
}

/**
 * Format phần trăm có dấu cộng/trừ.
 */
function formatPercent(
  value,
  digits = 2,
  showPlus = true
) {
  const number =
    toNumber(value, 0);

  const sign =
    showPlus && number > 0
      ? '+'
      : '';

  return (
    `${sign}` +
    `${number.toFixed(digits)}%`
  );
}

/**
 * Telegram không hỗ trợ đổi màu chữ thật.
 *
 * Dùng biểu tượng màu thay thế:
 * - Dương: 🟢
 * - Âm: 🔴
 * - Bằng 0: ⚪
 */
function formatPercentWithIndicator(
  value,
  {
    digits = 2,
    showPlus = true
  } = {}
) {
  const number =
    toNumber(value, 0);

  const icon =
    number > 0
      ? '🟢'
      : number < 0
        ? '🔴'
        : '⚪';

  const text =
    formatPercent(
      number,
      digits,
      showPlus
    );

  return (
    `${icon} ` +
    `<b>${escapeHtml(text)}</b>`
  );
}

/**
 * Format leverage.
 */
function formatLeverage(value) {
  const leverage =
    Math.max(
      1,
      Math.round(
        toNumber(
          value,
          CONFIG.maxLeverage || 1
        )
      )
    );

  return `x${leverage}`;
}

/**
 * BTC-USDT thành #BTC.
 */
function formatSymbol(value) {
  const raw =
    String(value || '')
      .trim()
      .toUpperCase();

  const coin =
    raw
      .replace(
        /[-_/]?(USDT|USD|USDC|BUSD)$/i,
        ''
      )
      .replace(
        /[^A-Z0-9]/g,
        ''
      );

  return `#${coin || 'COIN'}`;
}

/**
 * Tính ROE lý thuyết theo tín hiệu.
 *
 * LONG:
 * (Giá kết quả - Entry) / Entry
 *
 * SHORT:
 * (Entry - Giá kết quả) / Entry
 *
 * Sau đó nhân leverage và 100.
 */
function calculateRoe({
  direction,
  entryPrice,
  resultPrice,
  leverage
}) {
  const entry =
    toNumber(entryPrice);

  const result =
    toNumber(resultPrice);

  const safeLeverage =
    Math.max(
      1,
      toNumber(leverage, 1)
    );

  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(result) ||
    result <= 0
  ) {
    return null;
  }

  const normalizedDirection =
    String(direction || '')
      .trim()
      .toUpperCase();

  if (
    normalizedDirection === 'LONG'
  ) {
    return (
      (
        result - entry
      ) /
      entry *
      safeLeverage *
      100
    );
  }

  if (
    normalizedDirection === 'SHORT'
  ) {
    return (
      (
        entry - result
      ) /
      entry *
      safeLeverage *
      100
    );
  }

  return null;
}

/**
 * Phân loại kết quả một lệnh.
 *
 * Có TP2:
 * WIN TP1, TP2 và tính ROE tại TP2.
 *
 * Có TP1:
 * WIN TP1, kể cả sau đó quay về SL.
 *
 * Chưa có TP nhưng chạm SL:
 * LOST SL.
 */
function classifyWeeklyTrade(trade) {
  const direction =
    String(
      trade?.direction || ''
    )
      .trim()
      .toUpperCase();

  const entryPrice =
    toNumber(
      trade?.average_entry,
      toNumber(trade?.entry1)
    );

  const leverage =
    Math.max(
      1,
      toNumber(
        trade?.leverage,
        CONFIG.maxLeverage || 1
      )
    );

  const status =
    String(
      trade?.status || ''
    )
      .trim()
      .toUpperCase();

  const outcome =
    String(
      trade?.outcome || ''
    )
      .trim()
      .toUpperCase();

  const hasTp2 =
    Boolean(trade?.tp2_hit_at) ||
    status === 'TP2_HIT' ||
    outcome === 'WIN_TP2';

  const hasTp1 =
    hasTp2 ||
    Boolean(trade?.tp1_hit_at) ||
    status === 'TP1_HIT' ||
    [
      'WIN_TP1',
      'TP1_THEN_SL'
    ].includes(outcome);

  const hasStopLoss =
    Boolean(trade?.sl_hit_at) ||
    status === 'SL_HIT' ||
    outcome === 'LOSS_SL';

  if (hasTp2) {
    const resultPrice =
      toNumber(
        trade?.tp2_hit_price,
        toNumber(
          trade?.take_profit2
        )
      );

    return {
      category: 'WIN',
      label: 'WIN TP1, TP2',
      icon: '🎯',
      resultPrice,

      roe:
        calculateRoe({
          direction,
          entryPrice,
          resultPrice,
          leverage
        })
    };
  }

  if (hasTp1) {
    const resultPrice =
      toNumber(
        trade?.tp1_hit_price,
        toNumber(
          trade?.take_profit1
        )
      );

    return {
      category: 'WIN',
      label: 'WIN TP1',
      icon: '✅',
      resultPrice,

      roe:
        calculateRoe({
          direction,
          entryPrice,
          resultPrice,
          leverage
        })
    };
  }

  if (hasStopLoss) {
    const resultPrice =
      toNumber(
        trade?.sl_hit_price,
        toNumber(
          trade?.stop_loss
        )
      );

    return {
      category: 'LOSS',
      label: 'LOST SL',
      icon: '❌',
      resultPrice,

      roe:
        calculateRoe({
          direction,
          entryPrice,
          resultPrice,
          leverage
        })
    };
  }

  if (status === 'EXPIRED') {
    return {
      category: 'EXPIRED',
      label: 'HẾT HẠN',
      icon: '⌛',
      resultPrice: null,
      roe: null
    };
  }

  return {
    category: 'OPEN',
    label: 'ĐANG THEO DÕI',
    icon: '⏳',
    resultPrice: null,
    roe: null
  };
}

/**
 * Tạo nội dung report tuần.
 */
export function buildWeeklyTradeReport({
  trades,
  startTime,
  endTime,
  timezone = 'Asia/Ho_Chi_Minh'
}) {
  const safeTrades =
    Array.isArray(trades)
      ? trades
      : [];

  const analyzedTrades =
    safeTrades.map(
      trade => ({
        trade,
        result:
          classifyWeeklyTrade(trade)
      })
    );

  const resultTrades =
    analyzedTrades.filter(
      item =>
        item.result.category === 'WIN' ||
        item.result.category === 'LOSS'
    );

  const winTrades =
    resultTrades.filter(
      item =>
        item.result.category === 'WIN'
    );

  const lossTrades =
    resultTrades.filter(
      item =>
        item.result.category === 'LOSS'
    );

  const openTrades =
    analyzedTrades.filter(
      item =>
        item.result.category === 'OPEN'
    );

  const expiredTrades =
    analyzedTrades.filter(
      item =>
        item.result.category === 'EXPIRED'
    );

  /**
   * Tổng ROE là tổng ROE của
   * các lệnh đã có kết quả.
   */
  const totalRoe =
    resultTrades.reduce(
      (total, item) =>
        total +
        toNumber(
          item.result.roe,
          0
        ),
      0
    );

  const winRate =
    resultTrades.length > 0
      ? (
          winTrades.length /
          resultTrades.length
        ) * 100
      : 0;

  const lines = [
    '📊 <b>TỔNG KẾT AI AUTO TRADE TUẦN</b>',
    '',

    `🗓 <b>Thời gian:</b> ` +
    `${escapeHtml(
      formatDate(
        startTime,
        timezone
      )
    )} - ` +
    `${escapeHtml(
      formatDate(
        endTime,
        timezone
      )
    )}`,

    ''
  ];

  if (
    resultTrades.length === 0
  ) {
    lines.push(
      'Chưa có lệnh nào đạt TP hoặc SL trong tuần.'
    );
  } else {
    resultTrades.forEach(
      (item, index) => {
        const trade = item.trade;
        const result = item.result;

        const direction =
          String(
            trade.direction || ''
          )
            .trim()
            .toUpperCase();

        const directionIcon =
          direction === 'LONG'
            ? '🔵'
            : '🔴';

        lines.push(
          `${index + 1}. ` +
          `${directionIcon} ` +
          `<b>` +
          `${escapeHtml(direction)} ` +
          `${escapeHtml(
            formatSymbol(
              trade.symbol
            )
          )} ` +
          `${escapeHtml(
            formatLeverage(
              trade.leverage
            )
          )}` +
          `</b>`,

          `${result.icon} ` +
          `<b>${escapeHtml(
            result.label
          )}</b> | ` +
          `ROE ${formatPercentWithIndicator(
            result.roe
          )}`
        );

        if (
          index <
          resultTrades.length - 1
        ) {
          lines.push('');
        }
      }
    );
  }

  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━',
    '',

    `📌 <b>Tổng lệnh có kết quả:</b> ` +
    `${resultTrades.length}`,

    `✅ <b>Lệnh WIN:</b> ` +
    `${winTrades.length}`,

    `❌ <b>Lệnh LOST:</b> ` +
    `${lossTrades.length}`,

    `🎯 <b>Tỷ lệ WIN:</b> ` +
    `${formatPercentWithIndicator(
      winRate,
      {
        digits: 2,
        showPlus: false
      }
    )}`,

    '',

    `💰 <b>Tổng ROE tuần:</b> ` +
    `${formatPercentWithIndicator(
      totalRoe
    )}`
  );

  if (openTrades.length > 0) {
    lines.push(
      '',
      `⏳ <b>Lệnh đang theo dõi:</b> ` +
      `${openTrades.length}`
    );

    for (
      const item of openTrades
    ) {
      const trade = item.trade;

      lines.push(
        `• ` +
        `${escapeHtml(
          String(
            trade.direction || ''
          ).toUpperCase()
        )} ` +
        `${escapeHtml(
          formatSymbol(
            trade.symbol
          )
        )} ` +
        `${escapeHtml(
          formatLeverage(
            trade.leverage
          )
        )}`
      );
    }
  }

  if (
    expiredTrades.length > 0
  ) {
    lines.push(
      '',
      `⌛ <b>Lệnh hết hạn chưa TP/SL:</b> ` +
      `${expiredTrades.length}`
    );
  }

  lines.push(
    '',
    '<i>ROE được tính theo Entry trung bình, mức TP/SL cao nhất đã đạt và đòn bẩy của từng lệnh; chưa bao gồm phí giao dịch và Funding.</i>'
  );

  return {
    startTime:
      new Date(startTime),

    endTime:
      new Date(endTime),

    timezone,

    trades:
      analyzedTrades,

    totals: {
      allTrades:
        analyzedTrades.length,

      resultTrades:
        resultTrades.length,

      wins:
        winTrades.length,

      losses:
        lossTrades.length,

      open:
        openTrades.length,

      expired:
        expiredTrades.length,

      winRate,
      totalRoe
    },

    html:
      lines.join('\n')
  };
}

/**
 * Chạy report tuần thủ công
 * hoặc từ bộ lập lịch.
 */
export async function runWeeklyReportOnce({
  now = new Date(),
  force = false
} = {}) {
  const reportConfig =
    getWeeklyReportConfig();

  if (
    !reportConfig.enabled &&
    !force
  ) {
    return {
      sent: false,
      skipped: true,
      reason:
        'WEEKLY_REPORT_ENABLED=false'
    };
  }

  if (
    !isTradeRepositoryEnabled()
  ) {
    return {
      sent: false,
      skipped: true,
      reason:
        'Trade database chưa được bật'
    };
  }

  if (weeklyReportRunning) {
    return {
      sent: false,
      skipped: true,
      reason:
        'Weekly report đang chạy'
    };
  }

  weeklyReportRunning = true;

  try {
    const range =
      getWeekRange(
        now,
        reportConfig.timezone
      );

    const trades =
      await getWeeklyTrades({
        startTime:
          range.startTime,

        endTime:
          range.endTime
      });

    const report =
      buildWeeklyTradeReport({
        trades,

        startTime:
          range.startTime,

        endTime:
          range.endTime,

        timezone:
          reportConfig.timezone
      });

    const telegramResult =
      await sendWeeklyTradeReportToTelegram(
        report
      );

    return {
      sent:
        telegramResult?.sent === true,

      skipped: false,
      report,
      telegram:
        telegramResult
    };
  } finally {
    weeklyReportRunning = false;
  }
}

/**
 * Khóa chống gửi trùng trong cùng một phút.
 */
function getCurrentScheduleKey(
  now,
  timezone
) {
  const parts =
    getZonedParts(
      now,
      timezone
    );

  return [
    parts.year,

    String(parts.month)
      .padStart(2, '0'),

    String(parts.day)
      .padStart(2, '0'),

    String(parts.hour)
      .padStart(2, '0'),

    String(parts.minute)
      .padStart(2, '0')
  ].join('-');
}

/**
 * Kiểm tra đã tới ngày và giờ report chưa.
 */
function shouldRunWeeklyReport(
  now,
  reportConfig
) {
  const local =
    getZonedParts(
      now,
      reportConfig.timezone
    );

  const localDay =
    new Date(
      Date.UTC(
        local.year,
        local.month - 1,
        local.day
      )
    ).getUTCDay();

  const expectedDay =
    normalizeReportDay(
      reportConfig.day
    );

  const expectedTime =
    parseReportTime(
      reportConfig.time
    );

  return (
    localDay === expectedDay &&
    local.hour === expectedTime.hour &&
    local.minute === expectedTime.minute
  );
}

/**
 * Khởi động lịch báo cáo tuần.
 */
export function startWeeklyReportScheduler() {
  const reportConfig =
    getWeeklyReportConfig();

  if (!reportConfig.enabled) {
    console.log(
      'Weekly report: OFF'
    );

    return {
      started: false,
      reason:
        'WEEKLY_REPORT_ENABLED=false'
    };
  }

  if (
    !isTradeRepositoryEnabled()
  ) {
    console.log(
      'Weekly report: OFF - database chưa bật'
    );

    return {
      started: false,
      reason:
        'Trade database chưa bật'
    };
  }

  if (weeklyReportTimer) {
    return {
      started: false,
      reason:
        'Weekly report scheduler đã chạy'
    };
  }

  console.log(
    'Weekly report: ON',
    {
      day:
        reportConfig.day,

      time:
        reportConfig.time,

      timezone:
        reportConfig.timezone
    }
  );

  const checkSchedule =
    async () => {
      const now =
        new Date();

      if (
        !shouldRunWeeklyReport(
          now,
          reportConfig
        )
      ) {
        return;
      }

      const scheduleKey =
        getCurrentScheduleKey(
          now,
          reportConfig.timezone
        );

      if (
        lastWeeklyReportKey ===
        scheduleKey
      ) {
        return;
      }

      lastWeeklyReportKey =
        scheduleKey;

      try {
        const result =
          await runWeeklyReportOnce({
            now,
            force: true
          });

        console.log(
          'Weekly report result:',
          {
            sent:
              result?.sent === true,

            totalTrades:
              result?.report
                ?.totals
                ?.allTrades,

            resultTrades:
              result?.report
                ?.totals
                ?.resultTrades,

            totalRoe:
              result?.report
                ?.totals
                ?.totalRoe
          }
        );
      } catch (error) {
        console.error(
          'Weekly report lỗi:',
          error.response?.data ||
          error.message ||
          String(error)
        );
      }
    };

  weeklyReportTimer =
    setInterval(
      () => {
        void checkSchedule();
      },
      30 * 1000
    );

  setTimeout(
    () => {
      void checkSchedule();
    },
    2000
  );

  return {
    started: true,
    day:
      reportConfig.day,

    time:
      reportConfig.time,

    timezone:
      reportConfig.timezone
  };
}

/**
 * Dừng lịch report tuần.
 */
export function stopWeeklyReportScheduler() {
  if (!weeklyReportTimer) {
    return {
      stopped: false,
      reason:
        'Weekly report scheduler chưa chạy'
    };
  }

  clearInterval(
    weeklyReportTimer
  );

  weeklyReportTimer = null;

  console.log(
    'Weekly report: STOPPED'
  );

  return {
    stopped: true
  };
}
