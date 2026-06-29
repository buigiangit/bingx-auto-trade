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
 * Chạy một vòng phân tích và xử lý lệnh.
 *
 * Telegram đã được gửi đồng thời với request BingX
 * bên trong executor.js, nên index.js không gửi lại.
 */
async function runOne() {
  const raw = await buildMarketSnapshot();

  const snapshot = addIndicators(raw);

  const aiSignal = await askAI(snapshot);

  const decision = validateAndSize(
    aiSignal,
    snapshot
  );

  const execution = await executeDecision(
    decision,
    snapshot,
    allowVstOrder
  );

  const report = {
    createdAt: new Date().toISOString(),

    symbol: snapshot.symbol,
    interval: snapshot.interval,

    price:
      snapshot.indicators?.lastClose,

    trend:
      snapshot.indicators?.trend,

    rsi14:
      snapshot.indicators?.rsi14,

    ema34:
      snapshot.indicators?.ema34,

    ema89:
      snapshot.indicators?.ema89,

    ema200:
      snapshot.indicators?.ema200,

    funding:
      decision.funding,

    openInterest:
      snapshot.oi?.openInterest,

    spreadPct:
      decision.spreadPct,

    aiSignal,
    decision,
    execution
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

    console.log(
      `Telegram sent: ${
        execution.telegram?.sent === true
      }`
    );

    console.log(
      `Telegram message ID: ${
        execution.telegram?.messageId || 'N/A'
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
    console.log('==============================');
    console.log(`RUN #${runCount}`);

    console.log(
      `Time: ${new Date().toLocaleString('vi-VN')}`
    );

    console.log('==============================');

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
      createdAt: new Date().toISOString(),
      error: errorMessage,
      stack: error.stack
    });
  } finally {
    isRunning = false;
  }
}

/**
 * Chạy bot liên tục.
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

  // Chạy ngay vòng đầu tiên.
  await runOnceSafe();

  // Sau đó tiếp tục chạy theo chu kỳ.
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
