import { EMA, RSI, MACD, ATR } from 'technicalindicators';

function last(arr) { return arr?.length ? arr[arr.length - 1] : null; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

export function addIndicators(snapshot) {
  const candles = snapshot.candles;
  const close = candles.map(c => c.close);
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const volume = candles.map(c => c.volume);

  const ema34 = EMA.calculate({ period: 34, values: close });
  const ema89 = EMA.calculate({ period: 89, values: close });
  const ema200 = EMA.calculate({ period: 200, values: close });
  const rsi14 = RSI.calculate({ period: 14, values: close });
  const atr14 = ATR.calculate({ period: 14, high, low, close });
  const macd = MACD.calculate({
    values: close,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const e34 = last(ema34), e89 = last(ema89), e200 = last(ema200);
  let trend = 'MIXED';
  if (e34 && e89 && e200 && e34 > e89 && e89 > e200) trend = 'BULL';
  if (e34 && e89 && e200 && e34 < e89 && e89 < e200) trend = 'BEAR';

  const recent = candles.slice(-50);
  const support = Math.min(...recent.map(c => c.low));
  const resistance = Math.max(...recent.map(c => c.high));

  return {
    ...snapshot,
    indicators: {
      lastClose: last(close),
      ema34: e34,
      ema89: e89,
      ema200: e200,
      rsi14: last(rsi14),
      atr14: last(atr14),
      macd: last(macd),
      volume: last(volume),
      avgVolume20: avg(volume.slice(-20)),
      trend,
      support50: support,
      resistance50: resistance
    }
  };
}
