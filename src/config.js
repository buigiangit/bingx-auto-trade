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
 * Chỉ chuỗi "true" được xem là true.
 */
function bool(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }

  return (
    String(value)
      .trim()
      .toLowerCase() === 'true'
  );
}

/**
 * Đọc danh sách phân cách bằng dấu phẩy.
 */
function list(name, defaultValue = '') {
  return String(
    process.env[name] ??
    defaultValue
  )
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Chuẩn hóa lựa chọn từ biến môi trường.
 */
function choice(
  name,
  allowedValues,
  defaultValue
) {
  const value = String(
    process.env[name] ??
    defaultValue
  )
    .trim()
    .toUpperCase();

  return allowedValues.includes(value)
    ? value
    : defaultValue;
}

/**
 * Chuyển:
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
        .map(interval =>
          interval.trim()
        )
        .filter(Boolean)
    )
  ];
}

/*
 * Danh sách khung thời gian.
 */
const configuredIntervals =
  parseIntervals(
    process.env.INTERVALS ||
    process.env.INTERVAL ||
    '15m,1h,4h'
  );

/*
 * Khung tìm Entry.
 */
const entryInterval =
  process.env.ENTRY_INTERVAL ||
  configuredIntervals[0] ||
  process.env.INTERVAL ||
  '15m';

/*
 * Khung xác nhận.
 */
const confirmInterval =
  process.env.CONFIRM_INTERVAL ||
  configuredIntervals[1] ||
  '1h';

/*
 * Khung xu hướng chính.
 */
const trendInterval =
  process.env.TREND_INTERVAL ||
  configuredIntervals[2] ||
  '4h';

/*
 * Bảo đảm ba khung chính luôn tồn tại.
 */
const allIntervals = [
  ...new Set([
    entryInterval,
    confirmInterval,
    trendInterval,
    ...configuredIntervals
  ])
];

const multiTimeframeEnabled =
  bool(
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
    process.env.OPENAI_API_KEY ||
    '',

  openaiModel:
    process.env.OPENAI_MODEL ||
    'gpt-4.1-mini',

  /*
   * =========================
   * POSTGRESQL
   * =========================
   */
  databaseUrl:
    process.env.DATABASE_URL ||
    '',

  tradeDbEnabled:
    bool(
      'TRADE_DB_ENABLED',
      false
    ),

  databaseSsl:
    bool(
      'DATABASE_SSL',
      true
    ),

  databasePoolMax:
    num(
      'DATABASE_POOL_MAX',
      5
    ),

  databaseIdleTimeoutMs:
    num(
      'DATABASE_IDLE_TIMEOUT_MS',
      30000
    ),

  databaseConnectionTimeoutMs:
    num(
      'DATABASE_CONNECTION_TIMEOUT_MS',
      10000
    ),

  /*
   * =========================
   * TRADE MONITOR
   * Theo dõi TP1, TP2, SL
   * =========================
   */
  tradeMonitorEnabled:
    bool(
      'TRADE_MONITOR_ENABLED',
      true
    ),

  tradeMonitorIntervalSeconds:
    num(
      'TRADE_MONITOR_INTERVAL_SECONDS',
      30
    ),

  tradeMonitorCandleInterval:
    process.env
      .TRADE_MONITOR_CANDLE_INTERVAL ||
    '1m',

  tradeMonitorKlineLimit:
    num(
      'TRADE_MONITOR_KLINE_LIMIT',
      20
    ),

  tradeMonitorBatchSize:
    num(
      'TRADE_MONITOR_BATCH_SIZE',
      50
    ),

  /*
   * Thời gian tối đa một kèo còn hiệu lực.
   *
   * 86400 = 24 giờ.
   */
  tradeExpireSeconds:
    num(
      'TRADE_EXPIRE_SECONDS',
      86400
    ),

  /*
   * false:
   * Sau TP1 vẫn khóa call mới,
   * tiếp tục chờ TP2 hoặc SL.
   */
  unlockNewSignalAfterTp1:
    bool(
      'UNLOCK_NEW_SIGNAL_AFTER_TP1',
      false
    ),

  /*
   * Có lệnh OPEN hoặc TP1_HIT thì
   * không tạo lệnh mới.
   */
  blockNewSignalWhileActive:
    bool(
      'BLOCK_NEW_SIGNAL_WHILE_ACTIVE',
      true
    ),

  /*
   * Khi một cây nến vừa chạm TP vừa
   * chạm SL nhưng không xác định được
   * thứ tự:
   *
   * SL_FIRST: tính SL trước, bảo thủ.
   * TP_FIRST: tính TP trước.
   */
  ambiguousCandlePolicy:
    choice(
      'AMBIGUOUS_CANDLE_POLICY',
      [
        'SL_FIRST',
        'TP_FIRST'
      ],
      'SL_FIRST'
    ),

  /*
   * =========================
   * BINGX
   * =========================
   */
  bingxApiKey:
    process.env.BINGX_API_KEY ||
    '',

  bingxSecretKey:
    process.env
      .BINGX_SECRET_KEY ||
    '',

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

  intervals:
    multiTimeframeEnabled
      ? allIntervals
      : [entryInterval],

  entryInterval,

  confirmInterval,

  trendInterval,

  /*
   * Giữ tương thích với code cũ.
   */
  interval:
    entryInterval,

  limit:
    num(
      'LIMIT',
      240
    ),

  /*
   * =========================
   * LOOP
   * =========================
   */
  loopSeconds:
    num(
      'LOOP_SECONDS',
      300
    ),

  checkIntervalSeconds:
    num(
      'CHECK_INTERVAL_SECONDS',
      300
    ),

  /*
   * =========================
   * RISK
   * =========================
   */
  equity:
    num(
      'ACCOUNT_EQUITY_USDT',
      1000
    ),

  riskPct:
    num(
      'RISK_PER_TRADE_PCT',
      0.3
    ),

  maxLeverage:
    num(
      'MAX_LEVERAGE',
      2
    ),

  minConfidence:
    num(
      'MIN_CONFIDENCE',
      75
    ),

  /*
   * 0.08 nghĩa là spread 0.08%.
   */
  maxSpreadPct:
    num(
      'MAX_SPREAD_PCT',
      0.08
    ),

  maxAbsFundingRate:
    num(
      'MAX_ABS_FUNDING_RATE',
      0.0008
    ),

  minRR:
    num(
      'MIN_RR',
      1.2
    ),

  maxNotional:
    num(
      'MAX_NOTIONAL_USDT',
      30
    ),

  orderMarginUsdt:
    num(
      'ORDER_MARGIN_USDT',
      10
    ),

  /*
   * =========================
   * ENTRY / SL / TP
   * =========================
   */
  atrPeriod:
    num(
      'ATR_PERIOD',
      14
    ),

  slAtrMult:
    num(
      'SL_ATR_MULT',
      1.8
    ),

  tp1AtrMult:
    num(
      'TP1_ATR_MULT',
      2.5
    ),

  tp2AtrMult:
    num(
      'TP2_ATR_MULT',
      3.5
    ),

  /*
   * 0.6 nghĩa là 0.6%.
   */
  minSlPct:
    num(
      'MIN_SL_PCT',
      0.6
    ),

  /*
   * 1.5 nghĩa là 1.5%.
   */
  maxSlPct:
    num(
      'MAX_SL_PCT',
      1.5
    ),

  maxEntryDistancePct:
    num(
      'MAX_ENTRY_DISTANCE_PCT',
      0.25
    ),

  structureLookback:
    num(
      'STRUCTURE_LOOKBACK',
      20
    ),

  /*
   * =========================
   * ENTRY 2
   * =========================
   */
  entry2AtrMult:
    num(
      'ENTRY2_ATR_MULT',
      0.6
    ),

  entry2MaxDistancePct:
    num(
      'ENTRY2_MAX_DISTANCE_PCT',
      0.6
    ),

  entry2MinDistancePct:
    num(
      'ENTRY2_MIN_DISTANCE_PCT',
      0.15
    ),

  entry2MaxStopRatio:
    num(
      'ENTRY2_MAX_STOP_RATIO',
      0.65
    ),

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
    bool(
      'ALLOW_ADD_POSITION',
      false
    ),

  /*
   * =========================
   * DCA
   *
   * Có trade active:
   * - Không tạo trade mới
   * - Chỉ được DCA cùng trade đó
   * =========================
   */
  allowDca:
    bool(
      'ALLOW_DCA',
      false
    ),

  dcaTriggerRoePct:
    num(
      'DCA_TRIGGER_ROE_PCT',
      -20
    ),

  maxDcaCount:
    num(
      'MAX_DCA_COUNT',
      1
    ),

  dcaMarginUsdt:
    num(
      'DCA_MARGIN_USDT',
      100
    ),

  minSecondsBetweenDca:
    num(
      'MIN_SECONDS_BETWEEN_DCA',
      1800
    ),

  /*
   * Giá hiện tại phải nằm gần Entry 2
   * mới được phép DCA.
   *
   * 0.15 nghĩa là lệch tối đa 0.15%.
   */
  dcaEntry2TolerancePct:
    num(
      'DCA_ENTRY2_TOLERANCE_PCT',
      0.15
    ),

  /*
   * =========================
   * SIGNAL GUARD
   *
   * Đây là lớp chống spam tạm thời.
   * Sau khi DB hoàn thiện, DB sẽ là
   * nguồn khóa lệnh chính.
   * =========================
   */
  minSecondsBetweenSignals:
    num(
      'MIN_SECONDS_BETWEEN_SIGNALS',
      1800
    ),

  minSignalPriceMovePct:
    num(
      'MIN_SIGNAL_PRICE_MOVE_PCT',
      0.35
    ),

  signalExpireSeconds:
    num(
      'SIGNAL_EXPIRE_SECONDS',
      7200
    ),

  blockSameDirectionSignal:
    bool(
      'BLOCK_SAME_DIRECTION_SIGNAL',
      true
    ),

  onlySignalOnNewCandle:
    bool(
      'ONLY_SIGNAL_ON_NEW_CANDLE',
      true
    ),

  signalGuardBlockOrder:
    bool(
      'SIGNAL_GUARD_BLOCK_ORDER',
      true
    ),

  /*
   * =========================
   * TELEGRAM FBT
   * =========================
   */
  telegramEnabled:
    bool(
      'TELEGRAM_ENABLED',
      false
    ),

  telegramBotToken:
    process.env
      .TELEGRAM_BOT_TOKEN ||
    '',

  telegramChatId:
    process.env
      .TELEGRAM_CHAT_ID ||
    '',

  telegramAlertCooldownSeconds:
    num(
      'TELEGRAM_ALERT_COOLDOWN_SECONDS',
      600
    ),

  /*
   * =========================
   * TELEGRAM CDT
   * =========================
   */
  cdtTelegramEnabled:
    bool(
      'CDT_TELEGRAM_ENABLED',
      false
    ),

  cdtTelegramBotToken:
    process.env
      .CDT_TELEGRAM_BOT_TOKEN ||
    '',

  cdtTelegramChatId:
    process.env
      .CDT_TELEGRAM_CHAT_ID ||
    '',

  /*
   * =========================
   * WEEKLY TRADE REPORT
   *
   * Tổng kết lệnh trong tuần.
   * Mặc định gửi tối thứ Bảy lúc 20:00.
   * Dùng chung Telegram FBT/CDT Auto Trade.
   * =========================
   */
  weeklyReportEnabled:
    bool(
      'WEEKLY_REPORT_ENABLED',
      false
    ),

  weeklyReportDay:
    choice(
      'WEEKLY_REPORT_DAY',
      [
        'SUNDAY',
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY'
      ],
      'SATURDAY'
    ),

  weeklyReportTime:
    process.env
      .WEEKLY_REPORT_TIME ||
    '20:00',

  weeklyReportTimezone:
    process.env
      .WEEKLY_REPORT_TIMEZONE ||
    'Asia/Ho_Chi_Minh',

  /*
   * =========================
   * H4 REPORT
   *
   * Bộ token/chat ID này dùng riêng
   * cho đăng bài H4.
   * Không liên quan FBT/CDT Auto Trade.
   * =========================
   */
  h4ReportEnabled:
    bool(
      'H4_REPORT_ENABLED',
      false
    ),

  h4ReportTimes:
    list(
      'H4_REPORT_TIMES',
      '03:05,07:05,11:05,15:05,19:05,23:05'
    ),

  h4ReportTimezone:
    process.env
      .H4_REPORT_TIMEZONE ||
    'Asia/Ho_Chi_Minh',

  h4ReportBotTokens:
    list(
      'H4_REPORT_BOT_TOKENS'
    ),

  h4ReportChatIds:
    list(
      'H4_REPORT_CHAT_IDS'
    ),

  /*
   * Giữ tương thích với H4 Reporter cũ.
   */
  h4ReportChannelId:
    process.env
      .H4_REPORT_CHANNEL_ID ||
    process.env
      .TELEGRAM_CHAT_ID ||
    ''
};

/**
 * Kiểm tra môi trường chạy.
 */
export function assertSafeEnvironment() {
  if (
    CONFIG.tradeDbEnabled &&
    !CONFIG.databaseUrl
  ) {
    throw new Error(
      'TRADE_DB_ENABLED=true nhưng thiếu DATABASE_URL'
    );
  }

  if (
    CONFIG.tradeMonitorEnabled &&
    CONFIG.tradeMonitorIntervalSeconds < 10
  ) {
    throw new Error(
      'TRADE_MONITOR_INTERVAL_SECONDS không nên nhỏ hơn 10 giây'
    );
  }

  if (
    CONFIG.weeklyReportEnabled &&
    !CONFIG.tradeDbEnabled
  ) {
    throw new Error(
      'WEEKLY_REPORT_ENABLED=true nhưng TRADE_DB_ENABLED=false'
    );
  }

  if (
    CONFIG.weeklyReportEnabled &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(
      CONFIG.weeklyReportTime
    )
  ) {
    throw new Error(
      'WEEKLY_REPORT_TIME phải đúng định dạng HH:mm, ví dụ 20:00'
    );
  }

  if (
    CONFIG.bingxEnv === 'prod-live'
  ) {
    /*
     * Có thể bật lại để chặn giao dịch thật.
     */

    // throw new Error(
    //   'Chặn an toàn: project không cho chạy prod-live.'
    // );
  }
}
