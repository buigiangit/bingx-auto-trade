import { CONFIG } from './config.js';
import { buildMarketSnapshot } from './market.js';
import { addIndicators } from './indicators.js';
import { askAI } from './ai.js';
import { validateAndSize } from './risk.js';
import { executeDecision } from './executor.js';
import { logJson } from './logger.js';

const args = new Set(process.argv.slice(2));
const once = args.has('--once') || !args.has('--loop');
const allowVstOrder = args.has('--allow-vst-order');

async function runOne() {
  const raw = await buildMarketSnapshot();
  const snapshot = addIndicators(raw);
  const aiSignal = await askAI(snapshot);
  const decision = validateAndSize(aiSignal, snapshot);
  const execution = await executeDecision(decision, snapshot, allowVstOrder);

  const report = {
    symbol: snapshot.symbol,
    interval: snapshot.interval,
    price: snapshot.indicators.lastClose,
    trend: snapshot.indicators.trend,
    rsi14: snapshot.indicators.rsi14,
    ema34: snapshot.indicators.ema34,
    ema89: snapshot.indicators.ema89,
    ema200: snapshot.indicators.ema200,
    funding: decision.funding,
    openInterest: snapshot.oi.openInterest,
    spreadPct: decision.spreadPct,
    aiSignal,
    decision,
    execution
  };

  console.log('\n===== BINGX AI VST BOT =====');
  console.log(`Mode: ${CONFIG.executionMode} | Env: ${CONFIG.bingxEnv}`);
  console.log(`Symbol: ${snapshot.symbol} ${snapshot.interval}`);
  console.log(`Price: ${report.price}`);
  console.log(`Trend: ${report.trend}`);
  console.log(`RSI: ${report.rsi14?.toFixed?.(2) ?? report.rsi14}`);
  console.log(`Funding: ${report.funding}`);
  console.log(`OI: ${report.openInterest}`);
  console.log(`Spread: ${report.spreadPct}`);
  console.log('AI:', aiSignal);
  console.log('Decision:', {
    approved: decision.approved,
    reasons: decision.reasons,
    quantity: decision.quantity,
    notional: decision.notional,
    rr: decision.rr
  });
  console.log('Execution:', execution);
  console.log('============================\n');

  logJson(report);
}

async function main() {
  do {
    try {
      await runOne();
    } catch (e) {
      console.error('Bot lỗi:', e.message);
      logJson({ error: e.message, stack: e.stack });
    }

    if (once) break;
    await new Promise(r => setTimeout(r, CONFIG.loopSeconds * 1000));
  } while (true);
}

let isRunning = false;
let runCount = 0;

async function runOnceSafe() {
  if (isRunning) {
    console.log('Bot đang xử lý vòng trước, bỏ qua vòng này để tránh trùng lệnh...');
    return;
  }

  isRunning = true;
  runCount += 1;

  const startedAt = new Date();

  try {
    console.log('');
    console.log('==============================');
    console.log(`RUN #${runCount}`);
    console.log(`Time: ${startedAt.toLocaleString('vi-VN')}`);
    console.log('==============================');

    await main();
  } catch (err) {
    console.error('Bot lỗi:', err.message);
  } finally {
    isRunning = false;
  }
}

async function startLoop() {
  console.log('');
  console.log('===== BINGX AI BOT LOOP STARTED =====');
  console.log(`Symbol: ${CONFIG.symbol}`);
  console.log(`Interval: ${CONFIG.interval}`);
  console.log(`Execution mode: ${CONFIG.executionMode}`);
  console.log(`Check every: ${CONFIG.checkIntervalSeconds} seconds`);
  console.log('=====================================');

  await runOnceSafe();

  setInterval(async () => {
    await runOnceSafe();
  }, CONFIG.checkIntervalSeconds * 1000);
}

if (process.argv.includes('--once')) {
  await runOnceSafe();
} else {
  await startLoop();
}