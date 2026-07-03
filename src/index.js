import { CONFIG } from './config.js';
import {
  buildMarketSnapshot,
  buildMultiTimeframeSnapshot
} from './market.js';
import { addIndicators } from './indicators.js';
import { askAI } from './ai.js';
import { validateAndSize } from './risk.js';
import { executeDecision } from './executor.js';
import { logJson } from './logger.js';

const args = new Set(process.argv.slice(2));

const allowVstOrder =
  args.has('--allow-vst-order');

let isRunning = false;
let runCount = 0;

/**
 * Chuyển snapshot của một khung thành dữ liệu log gọn.
 */
function summarizeTimeframe(snapshot) {
  const indicators =
    snapshot?.indicators || {};

  return {
    symbol:
      snapshot?.symbol || CONFIG.symbol,

    interval:
      snapshot?.interval || null,

    price:
      indicators.lastClose ?? null,

    trend:
      indicators.trend ?? null,

    ema34:
      indicators.ema34 ?? null,

    ema89:
      indicators.ema89 ?? null,

    ema200:
      indicators.ema200 ?? null,

    rsi14:
      indicators.rsi14 ?? null,

    macd:
      indicators.macd ?? null,

    atr14:
      indicators.atr14 ?? null,

    volume:
      indicators.volume ?? null,

    support:
      indicators.support ?? null,

    resistance:
      indicators.resistance ?? null
  };
}

/**
 * Tạo snapshot đa khung đã tính indicator.
 */
async function buildAnalyzedMultiTimeframeSnapshot() {
  /*
   * Nếu tắt multi timeframe,
   * bot vẫn chạy theo cơ chế một khung cũ.
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
      multiTimeframeEnabled: false,

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
       * Các trường bên dưới giúp tương thích
       * với ai.js cũ đang đọc snapshot.indicators.
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
   * Lấy dữ liệu nến của toàn bộ khung.
   */
  const rawMulti =
    await buildMultiTimeframeSnapshot();

  /*
   * Tính indicator riêng cho từng khung.
   */
  const analyzedTimeframeEntries =
    Object.entries(
      rawMulti.timeframes || {}
    ).map(([interval, rawSnapshot]) => {
      const analyzedSnapshot =
        addIndicators(rawSnapshot);

      return [
        interval,
        analyzedSnapshot
      ];
    });

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
    timeframes[entryInterval];

  const confirmSnapshot =
    timeframes[confirmInterval];

  const trendSnapshot =
    timeframes[trendInterval];

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
   * Snapshot gửi sang AI.
   *
   * Có cả:
   * - timeframes: dữ liệu đa khung
   * - indicators: indicator khung entry
   *
   * Nhờ vậy ai.js cũ không bị lỗi ngay,
   * nhưng để AI thực sự phân tích đa khung,
   * ai.js vẫn cần đọc snapshot.timeframes.
   */
  return {
    multiTimeframeEnabled: true,

    symbol:
      rawMulti.symbol ||
      CONFIG.symbol,

    intervals:
      rawMulti.intervals ||
      Object.keys(timeframes),

    entryInterval,
    confirmInterval,
    trendInterval,

    timeframes,

    entrySnapshot,
    confirmSnapshot,
    trendSnapshot,

    /*
     * Tương thích với code một khung cũ.
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
 * In thông tin các khung thời gian ra Render Logs.
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
      summarizeTimeframe(snapshot);

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
 * Chạy một vòng phân tích và xử lý lệnh.
 *
 * Telegram được gửi trong executor.js,
 * index.js không gửi Telegram lần thứ hai.
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
  logTimeframes(multiSnapshot);

  /*
   * 3. Gửi toàn bộ dữ liệu đa khung sang AI.
   *
   * ai.js phải đọc:
   * snapshot.timeframes
   * snapshot.entryInterval
   * snapshot.confirmInterval
   * snapshot.trendInterval
   */
  const aiSignal =
    await askAI(multiSnapshot);

  /*
   * 4. Risk và sizing sử dụng khung entry.
   *
   * Ví dụ:
   * Entry interval = 15m
   */
  const decision =
    validateAndSize(
      aiSignal,
      entrySnapshot
    );

  /*
   * 5. Executor cũng dùng snapshot khung entry
   * để lấy precision, spread và dữ liệu order.
   */
  const execution =
    await executeDecision(
      decision,
      entrySnapshot,
      allowVstOrder
    );

  /*
   * 6. Tóm tắt từng timeframe để lưu log.
   */
  const timeframeReport =
    Object.fromEntries(
      multiSnapshot.intervals.map(
        interval => [
          interval,
          summarizeTimeframe(
            multiSnapshot.timeframes?.[
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
      new Date().toISOString(),

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
     * Giữ trường interval cũ.
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
    `Mode: ${CONFIG.executionMode} | Env: ${CONFIG.bingxEnv}`
  );

  console.log(
    `Symbol: ${entrySnapshot.symbol}`
  );

  console.log(
    `Timeframes: ${multiSnapshot.intervals.join(', ')}`
  );

  console.log(
    `Entry interval: ${multiSnapshot.entryInterval}`
  );

  console.log(
    `Confirm interval: ${multiSnapshot.confirmInterval}`
  );

  console.log(
    `Trend interval: ${multiSnapshot.trendInterval}`
  );

  console.log(
    `Entry price: ${report.price}`
  );

  console.log(
    `Entry trend: ${report.trend}`
  );

  console.log(
    `Entry RSI: ${
      report.rsi14?.toFixed?.(2) ??
      report.rsi14
    }`
  );

  console.log(
    `Entry ATR: ${
      report.atr14?.toFixed?.(2) ??
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
   * Các thông tin này chỉ xuất hiện
   * trong Render Logs, không gửi lên Telegram.
   */
  if (
    execution?.executed === true
  ) {
    console.log(
      execution.isDca
        ? 'Order type: DCA'
        : 'Order type: NEW ENTRY'
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
      `Telegram message ID: ${
        execution.telegram
          ?.messageId ||
        'N/A'
      }`
    );
  }

  console.log(
    '========================\n'
  );

  logJson(report);

  return report;
}

/**
 * Không cho hai vòng chạy chồng lên nhau.
 */
async function runOnceSafe() {
  if (isRunning) {
    console.log(
      'Bot đang xử lý vòng trước, bỏ qua vòng này để tránh trùng lệnh...'
    );

    return;
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
      `Time: ${new Date().toLocaleString('vi-VN')}`
    );

    console.log(
      '=============================='
    );

    await runOne();
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
        new Date().toISOString(),

      error:
        errorMessage,

      stack:
        error.stack
    });
  } finally {
    isRunning = false;
  }
}

/**
 * Chạy bot liên tục.
 */
async function startLoop() {
  const checkIntervalSeconds =
    Number(
      CONFIG.checkIntervalSeconds ||
      CONFIG.loopSeconds ||
      300
    );

  console.log('');
  console.log(
    '===== BINGX AI BOT LOOP STARTED ====='
  );

  console.log(
    `Symbol: ${CONFIG.symbol}`
  );

  console.log(
    `Multi timeframe: ${CONFIG.multiTimeframeEnabled}`
  );

  console.log(
    `Intervals: ${(CONFIG.intervals || []).join(', ')}`
  );

  console.log(
    `Entry interval: ${CONFIG.entryInterval}`
  );

  console.log(
    `Confirm interval: ${CONFIG.confirmInterval}`
  );

  console.log(
    `Trend interval: ${CONFIG.trendInterval}`
  );

  console.log(
    `Execution mode: ${CONFIG.executionMode}`
  );

  console.log(
    `Environment: ${CONFIG.bingxEnv}`
  );

  console.log(
    `Allow VST order: ${allowVstOrder}`
  );

  console.log(
    `Check every: ${checkIntervalSeconds} seconds`
  );

  console.log(
    `Telegram enabled: ${CONFIG.telegramEnabled}`
  );

  console.log(
    '====================================='
  );

  /*
   * Chạy ngay vòng đầu tiên.
   */
  await runOnceSafe();

  /*
   * Sau đó tiếp tục theo chu kỳ.
   */
  setInterval(
    async () => {
      await runOnceSafe();
    },
    checkIntervalSeconds * 1000
  );
}

if (args.has('--once')) {
  await runOnceSafe();
} else {
  await startLoop();
}
