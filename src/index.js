import {
  CONFIG,
  assertSafeEnvironment
} from './config.js';

import {
  buildMarketSnapshot,
  buildMultiTimeframeSnapshot
} from './market.js';

import {
  addIndicators
} from './indicators.js';

import {
  askAI
} from './ai.js';

import {
  validateAndSize
} from './risk.js';

import {
  executeDecision
} from './executor.js';

import {
  logJson
} from './logger.js';

import {
  startH4ReportScheduler
} from './h4Reporter.js';

import {
  initializeDatabase,
  closeDatabase,
  isDatabaseEnabled
} from './db.js';

import {
  startTradeMonitor,
  stopTradeMonitor,
  runTradeMonitorOnce
} from './tradeMonitor.js';

const args =
  new Set(
    process.argv.slice(2)
  );

const allowVstOrder =
  args.has('--allow-vst-order');

const runOnceMode =
  args.has('--once');

let isRunning = false;
let isShuttingDown = false;
let runCount = 0;
let loopTimer = null;

/**
 * Chuyển snapshot của một khung
 * thành dữ liệu log gọn.
 */
function summarizeTimeframe(snapshot) {
  const indicators =
    snapshot?.indicators || {};

  return {
    symbol:
      snapshot?.symbol ||
      CONFIG.symbol,

    interval:
      snapshot?.interval ||
      null,

    price:
      indicators.lastClose ??
      null,

    trend:
      indicators.trend ??
      null,

    ema34:
      indicators.ema34 ??
      null,

    ema89:
      indicators.ema89 ??
      null,

    ema200:
      indicators.ema200 ??
      null,

    rsi14:
      indicators.rsi14 ??
      null,

    macd:
      indicators.macd ??
      null,

    atr14:
      indicators.atr14 ??
      null,

    volume:
      indicators.volume ??
      null,

    support:
      indicators.support ??
      null,

    resistance:
      indicators.resistance ??
      null
  };
}

/**
 * Tạo snapshot đa khung đã tính indicator.
 */
async function buildAnalyzedMultiTimeframeSnapshot() {
  /*
   * Nếu tắt multi timeframe,
   * bot vẫn chạy theo một khung.
   */
  if (!CONFIG.multiTimeframeEnabled) {
    const raw =
      await buildMarketSnapshot(
        CONFIG.entryInterval ||
        CONFIG.interval
      );

    const entrySnapshot =
      addIndicators(raw);

    return {
      multiTimeframeEnabled:
        false,

      symbol:
        entrySnapshot.symbol,

      intervals: [
        entrySnapshot.interval
      ],

      entryInterval:
        entrySnapshot.interval,

      confirmInterval:
        entrySnapshot.interval,

      trendInterval:
        entrySnapshot.interval,

      timeframes: {
        [entrySnapshot.interval]:
          entrySnapshot
      },

      entrySnapshot,

      confirmSnapshot:
        entrySnapshot,

      trendSnapshot:
        entrySnapshot,

      /*
       * Tương thích code một khung cũ.
       */
      interval:
        entrySnapshot.interval,

      candles:
        entrySnapshot.candles,

      indicators:
        entrySnapshot.indicators,

      premium:
        entrySnapshot.premium,

      funding:
        entrySnapshot.funding,

      oi:
        entrySnapshot.oi,

      book:
        entrySnapshot.book,

      contract:
        entrySnapshot.contract
    };
  }

  /*
   * Lấy dữ liệu nến toàn bộ khung.
   */
  const rawMulti =
    await buildMultiTimeframeSnapshot();

  /*
   * Tính indicator riêng từng khung.
   */
  const analyzedTimeframeEntries =
    Object.entries(
      rawMulti.timeframes || {}
    ).map(
      ([
        interval,
        rawSnapshot
      ]) => {
        const analyzedSnapshot =
          addIndicators(
            rawSnapshot
          );

        return [
          interval,
          analyzedSnapshot
        ];
      }
    );

  const timeframes =
    Object.fromEntries(
      analyzedTimeframeEntries
    );

  const entryInterval =
    rawMulti.entryInterval ||
    CONFIG.entryInterval ||
    CONFIG.interval;

  const confirmInterval =
    rawMulti.confirmInterval ||
    CONFIG.confirmInterval ||
    entryInterval;

  const trendInterval =
    rawMulti.trendInterval ||
    CONFIG.trendInterval ||
    confirmInterval;

  const entrySnapshot =
    timeframes[
      entryInterval
    ];

  const confirmSnapshot =
    timeframes[
      confirmInterval
    ];

  const trendSnapshot =
    timeframes[
      trendInterval
    ];

  if (!entrySnapshot) {
    throw new Error(
      `Không có dữ liệu khung entry ${entryInterval}`
    );
  }

  if (!confirmSnapshot) {
    throw new Error(
      `Không có dữ liệu khung xác nhận ${confirmInterval}`
    );
  }

  if (!trendSnapshot) {
    throw new Error(
      `Không có dữ liệu khung xu hướng ${trendInterval}`
    );
  }

  /*
   * Snapshot đầy đủ gửi sang AI,
   * executor và lưu DB.
   */
  return {
    multiTimeframeEnabled:
      true,

    symbol:
      rawMulti.symbol ||
      CONFIG.symbol,

    intervals:
      rawMulti.intervals ||
      Object.keys(
        timeframes
      ),

    entryInterval,
    confirmInterval,
    trendInterval,

    timeframes,

    entrySnapshot,
    confirmSnapshot,
    trendSnapshot,

    /*
     * Tương thích code một khung cũ.
     */
    interval:
      entrySnapshot.interval,

    candles:
      entrySnapshot.candles,

    indicators:
      entrySnapshot.indicators,

    premium:
      rawMulti.premium ||
      entrySnapshot.premium,

    funding:
      rawMulti.funding ||
      entrySnapshot.funding,

    oi:
      rawMulti.oi ||
      entrySnapshot.oi,

    book:
      rawMulti.book ||
      entrySnapshot.book,

    contract:
      rawMulti.contract ||
      entrySnapshot.contract
  };
}

/**
 * In thông tin các khung thời gian
 * ra Render Logs.
 */
function logTimeframes(
  multiSnapshot
) {
  console.log('');

  console.log(
    '===== MULTI TIMEFRAME ANALYSIS ====='
  );

  console.log(
    `Entry: ${multiSnapshot.entryInterval}`
  );

  console.log(
    `Confirm: ${multiSnapshot.confirmInterval}`
  );

  console.log(
    `Trend: ${multiSnapshot.trendInterval}`
  );

  console.log('');

  for (
    const interval of
    multiSnapshot.intervals
  ) {
    const snapshot =
      multiSnapshot.timeframes?.[
        interval
      ];

    if (!snapshot) {
      console.log(
        `${interval}: Không có dữ liệu`
      );

      continue;
    }

    const summary =
      summarizeTimeframe(
        snapshot
      );

    console.log(
      `${interval}:`,
      {
        price:
          summary.price,

        trend:
          summary.trend,

        rsi14:
          summary.rsi14,

        ema34:
          summary.ema34,

        ema89:
          summary.ema89,

        ema200:
          summary.ema200,

        atr14:
          summary.atr14
      }
    );
  }

  console.log(
    '===================================='
  );

  console.log('');
}

/**
 * Chạy một vòng phân tích
 * và xử lý lệnh.
 */
async function runOne() {
  /*
   * 1. Lấy và phân tích dữ liệu đa khung.
   */
  const multiSnapshot =
    await buildAnalyzedMultiTimeframeSnapshot();

  const entrySnapshot =
    multiSnapshot.entrySnapshot;

  /*
   * 2. In dữ liệu từng khung.
   */
  logTimeframes(
    multiSnapshot
  );

  /*
   * 3. Gửi snapshot đa khung sang AI.
   */
  const aiSignal =
    await askAI(
      multiSnapshot
    );

  /*
   * 4. Risk và sizing sử dụng
   * snapshot khung Entry.
   */
  const decision =
    validateAndSize(
      aiSignal,
      entrySnapshot
    );

  /*
   * 5. Executor nhận toàn bộ
   * multiSnapshot.
   *
   * Mục đích:
   * - Lưu đầy đủ dữ liệu đa khung vào DB
   * - Lưu context để đánh giá AI
   * - Vẫn có contract, book, indicators
   *   của khung Entry ở top-level
   */
  const execution =
    await executeDecision(
      decision,
      multiSnapshot,
      allowVstOrder
    );

  /*
   * 6. Tóm tắt từng timeframe.
   */
  const timeframeReport =
    Object.fromEntries(
      multiSnapshot.intervals.map(
        interval => [
          interval,

          summarizeTimeframe(
            multiSnapshot
              .timeframes?.[
                interval
              ]
          )
        ]
      )
    );

  const funding =
    decision.funding ??
    multiSnapshot.premium
      ?.lastFundingRate ??
    multiSnapshot.funding
      ?.fundingRate ??
    null;

  const spreadPct =
    decision.spreadPct ??
    multiSnapshot.book
      ?.spreadPct ??
    null;

  const report = {
    createdAt:
      new Date()
        .toISOString(),

    symbol:
      entrySnapshot.symbol,

    multiTimeframeEnabled:
      multiSnapshot
        .multiTimeframeEnabled,

    intervals:
      multiSnapshot.intervals,

    entryInterval:
      multiSnapshot.entryInterval,

    confirmInterval:
      multiSnapshot.confirmInterval,

    trendInterval:
      multiSnapshot.trendInterval,

    /*
     * Giữ tương thích trường cũ.
     */
    interval:
      entrySnapshot.interval,

    price:
      entrySnapshot.indicators
        ?.lastClose,

    trend:
      entrySnapshot.indicators
        ?.trend,

    rsi14:
      entrySnapshot.indicators
        ?.rsi14,

    ema34:
      entrySnapshot.indicators
        ?.ema34,

    ema89:
      entrySnapshot.indicators
        ?.ema89,

    ema200:
      entrySnapshot.indicators
        ?.ema200,

    atr14:
      entrySnapshot.indicators
        ?.atr14,

    funding,

    openInterest:
      multiSnapshot.oi
        ?.openInterest,

    spreadPct,

    timeframes:
      timeframeReport,

    aiSignal,
    decision,
    execution
  };

  console.log('');

  console.log(
    '===== BINGX AI BOT ====='
  );

  console.log(
    `Mode: ${CONFIG.executionMode} | ` +
    `Env: ${CONFIG.bingxEnv}`
  );

  console.log(
    `Symbol: ${entrySnapshot.symbol}`
  );

  console.log(
    `Timeframes: ${
      multiSnapshot
        .intervals
        .join(', ')
    }`
  );

  console.log(
    `Entry interval: ${
      multiSnapshot.entryInterval
    }`
  );

  console.log(
    `Confirm interval: ${
      multiSnapshot.confirmInterval
    }`
  );

  console.log(
    `Trend interval: ${
      multiSnapshot.trendInterval
    }`
  );

  console.log(
    `Entry price: ${report.price}`
  );

  console.log(
    `Entry trend: ${report.trend}`
  );

  console.log(
    `Entry RSI: ${
      report.rsi14
        ?.toFixed?.(2) ??
      report.rsi14
    }`
  );

  console.log(
    `Entry ATR: ${
      report.atr14
        ?.toFixed?.(2) ??
      report.atr14
    }`
  );

  console.log(
    `Funding: ${report.funding}`
  );

  console.log(
    `OI: ${report.openInterest}`
  );

  console.log(
    `Spread: ${report.spreadPct}`
  );

  console.log(
    'AI:',
    aiSignal
  );

  console.log(
    'Decision:',
    {
      approved:
        decision.approved,

      reasons:
        decision.reasons,

      quantity:
        decision.quantity,

      notional:
        decision.notional,

      leverage:
        decision.leverage,

      rr:
        decision.rr
    }
  );

  console.log(
    'Execution:',
    execution
  );

  /*
   * Chỉ xuất hiện trong Render Logs.
   */
  if (
    execution?.executed ===
    true
  ) {
    console.log(
      execution.isDca
        ? 'Order type: DCA'
        : 'Order type: NEW ENTRY'
    );

    console.log(
      `Trade DB ID: ${
        execution.tradeId ||
        'N/A'
      }`
    );

    console.log(
      `Order ID: ${
        execution.orderId ||
        'N/A'
      }`
    );

    console.log(
      `Order status: ${
        execution.status ||
        'N/A'
      }`
    );

    console.log(
      `Telegram sent: ${
        execution.telegram
          ?.sent === true
      }`
    );

    console.log(
      `Telegram FBT message ID: ${
        execution.telegram
          ?.fbt
          ?.messageId ||
        execution.telegram
          ?.messageId ||
        'N/A'
      }`
    );

    console.log(
      `Telegram CDT message ID: ${
        execution.telegram
          ?.cdt
          ?.messageId ||
        'N/A'
      }`
    );
  }

  if (
    execution?.signalPublished ===
    true
  ) {
    console.log(
      `Signal trade DB ID: ${
        execution.tradeId ||
        'N/A'
      }`
    );

    console.log(
      'Signal Telegram: SENT'
    );
  }

  console.log(
    '========================\n'
  );

  logJson(
    report
  );

  return report;
}

/**
 * Không cho hai vòng AI chạy chồng nhau.
 */
async function runOnceSafe() {
  if (isRunning) {
    console.log(
      'Bot đang xử lý vòng trước, bỏ qua vòng này để tránh trùng lệnh...'
    );

    return null;
  }

  if (isShuttingDown) {
    console.log(
      'Bot đang tắt, không chạy vòng mới.'
    );

    return null;
  }

  isRunning = true;
  runCount += 1;

  try {
    console.log('');

    console.log(
      '=============================='
    );

    console.log(
      `RUN #${runCount}`
    );

    console.log(
      `Time: ${
        new Date()
          .toLocaleString(
            'vi-VN',
            {
              timeZone:
                CONFIG
                  .h4ReportTimezone ||
                'Asia/Ho_Chi_Minh'
            }
          )
      }`
    );

    console.log(
      '=============================='
    );

    return await runOne();
  } catch (error) {
    const errorMessage =
      error.response?.data?.msg ||
      error.response?.data?.message ||
      error.response?.data ||
      error.message ||
      String(error);

    console.error(
      'Bot lỗi:',
      errorMessage
    );

    logJson({
      createdAt:
        new Date()
          .toISOString(),

      error:
        errorMessage,

      stack:
        error.stack
    });

    return null;
  } finally {
    isRunning = false;
  }
}

/**
 * Khởi tạo cấu hình và PostgreSQL.
 */
async function initializeApplication() {
  /*
   * Kiểm tra config trước khi chạy.
   */
  assertSafeEnvironment();

  console.log('');

  console.log(
    '===== APPLICATION INITIALIZATION ====='
  );

  console.log(
    `Trade DB enabled: ${
      CONFIG.tradeDbEnabled
    }`
  );

  console.log(
    `Trade monitor enabled: ${
      CONFIG.tradeMonitorEnabled
    }`
  );

  console.log(
    `Database URL configured: ${
      Boolean(
        CONFIG.databaseUrl
      )
    }`
  );

  /*
   * Tự kết nối và tạo bảng.
   */
  const databaseResult =
    await initializeDatabase();

  console.log(
    'Database initialization:',
    databaseResult
  );

  /*
   * Trước vòng AI đầu tiên,
   * kiểm tra các trade cũ xem đã
   * TP1, TP2, SL hoặc hết hạn chưa.
   *
   * Việc này giúp Render restart xong
   * không call lệnh mới trước khi
   * cập nhật trade cũ.
   */
  if (
    CONFIG.tradeMonitorEnabled &&
    isDatabaseEnabled()
  ) {
    const monitorResult =
      await runTradeMonitorOnce();

    console.log(
      'Initial trade monitor:',
      {
        skipped:
          monitorResult?.skipped,

        activeTrades:
          monitorResult
            ?.activeTrades,

        reason:
          monitorResult?.reason
      }
    );
  }

  console.log(
    '======================================'
  );

  console.log('');

  return databaseResult;
}

/**
 * Chạy bot liên tục.
 */
async function startLoop() {
  await initializeApplication();

  const checkIntervalSeconds =
    Math.max(
      10,
      Number(
        CONFIG.checkIntervalSeconds ||
        CONFIG.loopSeconds ||
        300
      )
    );

  console.log('');

  console.log(
    '===== BINGX AI BOT LOOP STARTED ====='
  );

  console.log(
    `Symbol: ${CONFIG.symbol}`
  );

  console.log(
    `Multi timeframe: ${
      CONFIG.multiTimeframeEnabled
    }`
  );

  console.log(
    `Intervals: ${
      (
        CONFIG.intervals ||
        []
      ).join(', ')
    }`
  );

  console.log(
    `Entry interval: ${
      CONFIG.entryInterval
    }`
  );

  console.log(
    `Confirm interval: ${
      CONFIG.confirmInterval
    }`
  );

  console.log(
    `Trend interval: ${
      CONFIG.trendInterval
    }`
  );

  console.log(
    `Execution mode: ${
      CONFIG.executionMode
    }`
  );

  console.log(
    `Environment: ${
      CONFIG.bingxEnv
    }`
  );

  console.log(
    `Allow VST order: ${
      allowVstOrder
    }`
  );

  console.log(
    `Check every: ${
      checkIntervalSeconds
    } seconds`
  );

  console.log(
    `Telegram FBT enabled: ${
      CONFIG.telegramEnabled
    }`
  );

  console.log(
    `Telegram CDT enabled: ${
      CONFIG.cdtTelegramEnabled
    }`
  );

  console.log(
    `Trade DB enabled: ${
      CONFIG.tradeDbEnabled
    }`
  );

  console.log(
    `Trade monitor enabled: ${
      CONFIG.tradeMonitorEnabled
    }`
  );

  console.log(
    `Monitor every: ${
      CONFIG
        .tradeMonitorIntervalSeconds
    } seconds`
  );

  console.log(
    `Monitor candle: ${
      CONFIG
        .tradeMonitorCandleInterval
    }`
  );

  console.log(
    '====================================='
  );

  /*
   * Khởi động monitor định kỳ.
   */
  startTradeMonitor();

  /*
   * Khởi động lịch đăng bài H4.
   */
  startH4ReportScheduler();

  /*
   * Chạy ngay vòng AI đầu tiên.
   */
  await runOnceSafe();

  /*
   * Sau đó tiếp tục theo chu kỳ.
   */
  loopTimer =
    setInterval(
      async () => {
        await runOnceSafe();
      },
      checkIntervalSeconds *
      1000
    );
}

/**
 * Chạy một lần rồi đóng DB.
 */
async function startOnce() {
  try {
    await initializeApplication();

    await runOnceSafe();
  } finally {
    await closeDatabase();
  }
}

/**
 * Dừng bot an toàn khi Render restart,
 * stop worker hoặc nhận Ctrl+C.
 */
async function gracefulShutdown(
  signal
) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log('');

  console.log(
    `Nhận tín hiệu ${signal}. Đang dừng bot an toàn...`
  );

  if (loopTimer) {
    clearInterval(
      loopTimer
    );

    loopTimer = null;
  }

  stopTradeMonitor();

  /*
   * Chờ vòng AI hiện tại hoàn tất
   * tối đa khoảng 30 giây.
   */
  const shutdownStartedAt =
    Date.now();

  while (
    isRunning &&
    (
      Date.now() -
      shutdownStartedAt
    ) < 30000
  ) {
    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          500
        )
    );
  }

  try {
    await closeDatabase();
  } catch (error) {
    console.error(
      'Đóng PostgreSQL lỗi:',
      error.message ||
      String(error)
    );
  }

  console.log(
    'Bot đã dừng an toàn.'
  );

  process.exit(0);
}

/**
 * Render thường gửi SIGTERM
 * khi deploy hoặc restart.
 */
process.once(
  'SIGTERM',
  () => {
    void gracefulShutdown(
      'SIGTERM'
    );
  }
);

process.once(
  'SIGINT',
  () => {
    void gracefulShutdown(
      'SIGINT'
    );
  }
);

/**
 * Ghi log lỗi Promise chưa xử lý.
 */
process.on(
  'unhandledRejection',
  reason => {
    console.error(
      'Unhandled Promise Rejection:',
      reason
    );
  }
);

/**
 * Bắt đầu chương trình.
 */
try {
  if (runOnceMode) {
    await startOnce();
  } else {
    await startLoop();
  }
} catch (error) {
  const errorMessage =
    error.response?.data?.msg ||
    error.response?.data?.message ||
    error.response?.data ||
    error.message ||
    String(error);

  console.error(
    'Khởi động bot thất bại:',
    errorMessage
  );

  console.error(
    error.stack ||
    ''
  );

  try {
    stopTradeMonitor();

    await closeDatabase();
  } catch (closeError) {
    console.error(
      'Dọn dẹp tài nguyên lỗi:',
      closeError.message ||
      String(closeError)
    );
  }

  process.exitCode = 1;
}
