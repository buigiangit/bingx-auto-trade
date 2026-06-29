import 'dotenv/config';

function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

export const CONFIG = {
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  bingxApiKey: process.env.BINGX_API_KEY || '',
  bingxSecretKey: process.env.BINGX_SECRET_KEY || '',
  bingxEnv: process.env.BINGX_ENV || 'prod-vst',
  symbol: process.env.SYMBOL || 'BTC-USDT',
  interval: process.env.INTERVAL || '1h',
  limit: num('LIMIT', 240),
  loopSeconds: num('LOOP_SECONDS', 300),
  equity: num('ACCOUNT_EQUITY_USDT', 1000),
  riskPct: num('RISK_PER_TRADE_PCT', 0.3),
  maxLeverage: num('MAX_LEVERAGE', 2),
  minConfidence: num('MIN_CONFIDENCE', 75),
  maxSpreadPct: num('MAX_SPREAD_PCT', 0.08),
  maxAbsFundingRate: num('MAX_ABS_FUNDING_RATE', 0.0008),
  minRR: num('MIN_RR', 1.2),
  maxNotional: num('MAX_NOTIONAL_USDT', 30),
  executionMode: process.env.EXECUTION_MODE || 'SIGNAL_ONLY',
  checkIntervalSeconds: Number(process.env.CHECK_INTERVAL_SECONDS || 300),
  orderMarginUsdt: Number(process.env.ORDER_MARGIN_USDT || 10),
  allowAddPosition: process.env.ALLOW_ADD_POSITION === 'true',
allowDca: process.env.ALLOW_DCA === 'true',
dcaTriggerRoePct: Number(process.env.DCA_TRIGGER_ROE_PCT || -20),
maxDcaCount: Number(process.env.MAX_DCA_COUNT || 1),
dcaMarginUsdt: Number(process.env.DCA_MARGIN_USDT || 100),
minSecondsBetweenDca: Number(process.env.MIN_SECONDS_BETWEEN_DCA || 1800),
  telegramEnabled: process.env.TELEGRAM_ENABLED === 'true',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramAlertCooldownSeconds: Number(
    process.env.TELEGRAM_ALERT_COOLDOWN_SECONDS || 600
  )
};

export function assertSafeEnvironment() {
  if (CONFIG.bingxEnv === 'prod-live') {
    // throw new Error('Chặn an toàn: project này không cho chạy prod-live. Hãy dùng prod-vst hoặc SIGNAL_ONLY.');
  }
}
