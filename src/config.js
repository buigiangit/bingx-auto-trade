import 'dotenv/config';

/**
 * Đọc biến môi trường dạng số.
 */
function num(name, defaultValue) {
  const value = Number(process.env[name]);

  return Number.isFinite(value)
    ? value
    : defaultValue;
}

/**
 * Đọc biến môi trường dạng boolean.
 *
 * Chỉ chuỗi "true" mới được xem là true.
 */
function bool(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }

  return String(value).trim().toLowerCase() === 'true';
}

/**
 * Chuyển chuỗi:
 * 15m,1h,4h
 *
 * thành:
 * ['15m', '1h', '4h']
 */
function parseIntervals(value) {
  return [
    ...new Set(
      String(value || '')
        .split(',')
        .map(interval => interval.trim())
        .filter(Boolean)
    )
  ];
}

/*
 * Danh sách khung được cấu hình trên Render.
 *
 * Ví dụ:
 * INTERVALS=15m,1h,4h
 */
const configuredIntervals = parseIntervals(
  process.env.INTERVALS ||
  process.env.INTERVAL ||
  '15m,1h,4h'
);

/*
 * Khung tìm điểm vào lệnh.
 */
const entryInterval =
  process.env.ENTRY_INTERVAL ||
  configuredIntervals[0] ||
  process.env.INTERVAL ||
  '15m';

/*
 * Khung xác nhận xu hướng trung gian.
 */
const confirmInterval =
  process.env.CONFIRM_INTERVAL ||
  configuredIntervals[1] ||
  '1h';

/*
 * Khung xác định xu hướng chính.
 */
const trendInterval =
  process.env.TREND_INTERVAL ||
  configuredIntervals[2] ||
  '4h';

/*
 * Đảm bảo ba khung quan trọng luôn nằm trong danh sách.
 */
const allIntervals = [
  ...new Set([
    entryInterval,
    confirmInterval,
    trendInterval,
    ...configuredIntervals
  ])
];

const multiTimeframeEnabled = bool(
  'MULTI_TIMEFRAME_ENABLED',
  true
);

export const CONFIG = {
  /*
   * =========================
   * OPENAI
   * =========================
   */
  openaiApiKey:
    process.env.OPENAI_API_KEY || '',

  openaiModel:
    process.env.OPENAI_MODEL ||
    'gpt-4.1-mini',

  /*
   * =========================
   * BINGX
   * =========================
   */
  bingxApiKey:
    process.env.BINGX_API_KEY || '',

  bingxSecretKey:
    process.env.BINGX_SECRET_KEY || '',

  bingxEnv:
    process.env.BINGX_ENV ||
    'prod-vst',

  symbol:
    process.env.SYMBOL ||
    'BTC-USDT',

  /*
   * =========================
   * MULTI TIMEFRAME
   * =========================
   */

  multiTimeframeEnabled,

  /*
   * Nếu multi timeframe bật:
   * ['15m', '1h', '4h']
   *
   * Nếu tắt:
   * chỉ dùng khung entry.
   */
  intervals: multiTimeframeEnabled
    ? allIntervals
    : [entryInterval],

  /*
   * Khung để tìm Entry.
   */
  entryInterval,

  /*
   * Khung để xác nhận tín hiệu.
   */
  confirmInterval,

  /*
   * Khung để xác định trend chính.
   */
  trendInterval,

  /*
   * Giữ tương thích với code cũ.
   *
   * Những file đang dùng CONFIG.interval
   * sẽ mặc định lấy khung entry.
   */
  interval: entryInterval,

  limit:
    num('LIMIT', 240),

  /*
   * =========================
   * LOOP
   * =========================
   */
  loopSeconds:
    num('LOOP_SECONDS', 300),

  checkIntervalSeconds:
    num('CHECK_INTERVAL_SECONDS', 300),

  /*
   * =========================
   * RISK
   * =========================
   */
  equity:
    num('ACCOUNT_EQUITY_USDT', 1000),

  riskPct:
    num('RISK_PER_TRADE_PCT', 0.3),

  maxLeverage:
    num('MAX_LEVERAGE', 2),

  minConfidence:
    num('MIN_CONFIDENCE', 75),

  maxSpreadPct:
    num('MAX_SPREAD_PCT', 0.08),

  maxAbsFundingRate:
    num('MAX_ABS_FUNDING_RATE', 0.0008),

  minRR:
    num('MIN_RR', 1.2),

  maxNotional:
    num('MAX_NOTIONAL_USDT', 30),

  orderMarginUsdt:
    num('ORDER_MARGIN_USDT', 10),

  /*
   * =========================
   * ENTRY / SL / TP FILTER
   * =========================
   *
   * Các biến này chỉ có tác dụng
   * sau khi risk.js hoặc ai.js sử dụng chúng.
   */

  atrPeriod:
    num('ATR_PERIOD', 14),

  slAtrMult:
    num('SL_ATR_MULT', 1.8),

  tp1AtrMult:
    num('TP1_ATR_MULT', 2.5),

  tp2AtrMult:
    num('TP2_ATR_MULT', 3.5),

  /*
   * Khoảng SL tối thiểu tính theo %.
   *
   * 0.6 nghĩa là 0.6%.
   */
  minSlPct:
    num('MIN_SL_PCT', 0.6),

  /*
   * Khoảng SL tối đa tính theo %.
   *
   * 1.5 nghĩa là 1.5%.
   */
  maxSlPct:
    num('MAX_SL_PCT', 1.5),

  /*
   * Entry AI được phép lệch giá hiện tại
   * tối đa bao nhiêu %.
   */
  maxEntryDistancePct:
    num('MAX_ENTRY_DISTANCE_PCT', 0.25),

  /*
   * Số nến dùng để tìm swing high/swing low.
   */
  structureLookback:
    num('STRUCTURE_LOOKBACK', 20),

  /*
   * =========================
   * EXECUTION
   * =========================
   */
  executionMode:
    process.env.EXECUTION_MODE ||
    'SIGNAL_ONLY',

  /*
   * =========================
   * POSITION GUARD
   * =========================
   */
  allowAddPosition:
    bool('ALLOW_ADD_POSITION', false),

  /*
   * =========================
   * DCA
   * =========================
   */
  allowDca:
    bool('ALLOW_DCA', false),

  dcaTriggerRoePct:
    num('DCA_TRIGGER_ROE_PCT', -20),

  maxDcaCount:
    num('MAX_DCA_COUNT', 1),

  dcaMarginUsdt:
    num('DCA_MARGIN_USDT', 100),

  minSecondsBetweenDca:
    num('MIN_SECONDS_BETWEEN_DCA', 1800),
    /*
   * =========================
   * H4 REPORT
   * =========================
   */
  h4ReportEnabled:
    process.env.H4_REPORT_ENABLED === 'true',

  h4ReportTimes:
    String(
      process.env.H4_REPORT_TIMES ||
      '03:05,07:05,11:05,15:05,19:05,23:05'
    )
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),

  h4ReportTimezone:
    process.env.H4_REPORT_TIMEZONE ||
    'Asia/Ho_Chi_Minh',

  h4ReportChannelId:
    process.env.H4_REPORT_CHANNEL_ID ||
    process.env.TELEGRAM_CHAT_ID ||
    '',

  /*
   * =========================
   * TELEGRAM
   * =========================
   */
  telegramEnabled:
    bool('TELEGRAM_ENABLED', false),

  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN || '',

  telegramChatId:
    process.env.TELEGRAM_CHAT_ID || '',

  telegramAlertCooldownSeconds:
    num(
      'TELEGRAM_ALERT_COOLDOWN_SECONDS',
      600
    )
};

/**
 * Kiểm tra môi trường chạy.
 */
export function assertSafeEnvironment() {
  if (CONFIG.bingxEnv === 'prod-live') {
    /*
     * Bật lại throw nếu muốn chặn prod-live.
     */

    // throw new Error(
    //   'Chặn an toàn: project này không cho chạy prod-live.'
    // );
  }
}
