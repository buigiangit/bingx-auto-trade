import { CONFIG } from './config.js';
import { buildMarketSnapshot } from './market.js';
import { addIndicators } from './indicators.js';
import { askAI } from './ai.js';
import { validateAndSize } from './risk.js';
import { executeDecision } from './executor.js';
import { logJson } from './logger.js';

const args = new Set(process.argv.slice(2));

const allowVstOrder = args.has('--allow-vst-order');

let isRunning = false;
let runCount = 0;

/**
 * Chạy một vòng:
 * 1. Lấy dữ liệu BingX
 * 2. Tính chỉ báo
 * 3. Gọi AI
 * 4. Risk filter
 * 5. Gửi order BingX
 * 6. Chỉ khi BingX gửi order thành công mới gửi Telegram
 */
async function runOne() {
  const raw = await buildMarketSnapshot();

  const snapshot = addIndicators(raw);

  const aiSignal = await askAI(snapshot);

  const decision = validateAndSize(
    aiSignal,
    snapshot
  );

  /*
   * executeDecision chỉ trả executed:true
   * khi BingX đã xác nhận order thành công.
   *
   * Bao gồm:
   * - Lệnh vào mới
   * - Lệnh DCA
   */
  const execution = await executeDecision(
    decision,
    snapshot,
    allowVstOrder
  );

  /*
   * Chỉ gửi Telegram khi:
   * execution.executed === true
   *
   * Nếu AI WAIT, risk filter chặn, chưa đủ DCA,
   * BingX lỗi hoặc chưa gửi order thì không gửi Telegram.
   */
  let telegramResult = {
    sent: false,
    reason: 'Order chưa được gửi thành công lên BingX'
  };
  }

  const report = {
    createdAt: new Date().toISOString(),

    symbol: snapshot.symbol,
    interval: snapshot.interval,

    price:
      snapshot.indicators.lastClose,

    trend:
      snapshot.indicators.trend,

    rsi14:
      snapshot.indicators.rsi14,

    ema34:
      snapshot.indicators.ema34,

    ema89:
      snapshot.indicators.ema89,

    ema200:
      snapshot.indicators.ema200,

    funding:
      decision.funding,

    openInterest:
      snapshot.oi?.openInterest,

    spreadPct:
      decision.spreadPct,

    aiSignal,
    decision,
    execution,
    telegram: telegramResult
  };

  console.log('');
  console.log('===== BINGX AI BOT =====');

  console.log(
    `Mode: ${CONFIG.executionMode} | Env: ${CONFIG.bingxEnv}`
  );

  console.log(
    `Symbol: ${snapshot.symbol} ${snapshot.interval}`
  );

  console.log(
    `Price: ${report.price}`
  );

  console.log(
    `Trend: ${report.trend}`
  );

  console.log(
    `RSI: ${
      report.rsi14?.toFixed?.(2) ??
      report.rsi14
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

  if (execution?.executed === true) {
    console.log(
      execution.isDca
        ? 'Order type: DCA'
        : 'Order type: NEW ENTRY'
    );

    console.log(
      `Order ID: ${execution.orderId || 'N/A'}`
    );

    console.log(
      `Order status: ${execution.status || 'N/A'}`
    );
  }

  console.log(
    'Telegram:',
    telegramResult
  );

  console.log(
    '========================\n'
  );

  logJson(report);

  return report;
}

/**
 * Chặn chạy chồng vòng.
 *
 * Nếu vòng trước chưa xử lý xong thì vòng mới bỏ qua,
 * tránh gửi trùng order.
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

  const startedAt = new Date();

  try {
    console.log('');
    console.log('==============================');
    console.log(`RUN #${runCount}`);

    console.log(
      `Time: ${startedAt.toLocaleString('vi-VN')}`
    );

    console.log('==============================');

    await runOne();
  } catch (error) {
    console.error(
      'Bot lỗi:',
      error.response?.data ||
      error.message
    );

    logJson({
      createdAt: new Date().toISOString(),
      error:
        error.response?.data ||
        error.message,

      stack:
        error.stack
    });
  } finally {
    isRunning = false;
  }
}

/**
 * Chạy bot liên tục theo CHECK_INTERVAL_SECONDS.
 */
async function startLoop() {
  const checkIntervalSeconds = Number(
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
    `Interval: ${CONFIG.interval}`
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
   * Chạy ngay vòng đầu, không cần đợi interval.
   */
  await runOnceSafe();

  /*
   * Sau đó tự chạy lại theo chu kỳ.
   */
  setInterval(
    async () => {
      await runOnceSafe();
    },
    checkIntervalSeconds * 1000
  );
}

/**
 * npm run once hoặc:
 * node src/index.js --once
 */
if (args.has('--once')) {
  await runOnceSafe();
} else {
  await startLoop();
}
