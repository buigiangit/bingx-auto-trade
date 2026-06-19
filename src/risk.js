import { CONFIG } from './config.js';

function round(value, precision = 4) {
  const f = 10 ** precision;
  return Math.floor(Number(value) * f) / f;
}

function rr(signal) {
  if (
    !Number.isFinite(signal.entry) ||
    !Number.isFinite(signal.stopLoss) ||
    !Number.isFinite(signal.takeProfit1)
  ) {
    return 0;
  }

  const risk = Math.abs(signal.entry - signal.stopLoss);
  const reward = Math.abs(signal.takeProfit1 - signal.entry);

  if (risk <= 0) return 0;

  return reward / risk;
}
export function validateAndSize(signal, snapshot) {
  const reasons = [];

  const price = Number(snapshot.indicators.lastClose);
  const spreadPct = snapshot.book.spreadPct;

  const funding =
    Number(
      snapshot.premium?.lastFundingRate ??
      snapshot.funding?.fundingRate ??
      0
    ) || 0;

  const precision = Number(snapshot.contract?.quantityPrecision ?? 4);
  const minQty = Number(snapshot.contract?.tradeMinQuantity ?? 0);
  const minUsdt = Number(snapshot.contract?.tradeMinUSDT ?? 0);

  const normalized = {
    signal: ['LONG', 'SHORT', 'WAIT'].includes(signal.signal)
      ? signal.signal
      : 'WAIT',

    confidence: Number(signal.confidence) || 0,
    reason: String(signal.reason || ''),

    entry:
      signal.entry === null || signal.entry === undefined
        ? null
        : Number(signal.entry),

    stopLoss:
      signal.stopLoss === null || signal.stopLoss === undefined
        ? null
        : Number(signal.stopLoss),

    takeProfit1:
      signal.takeProfit1 === null || signal.takeProfit1 === undefined
        ? null
        : Number(signal.takeProfit1),

    takeProfit2:
      signal.takeProfit2 === null || signal.takeProfit2 === undefined
        ? null
        : Number(signal.takeProfit2),

    riskNote: String(signal.riskNote || '')
  };

  if (normalized.signal === 'WAIT') {
    reasons.push('AI chọn WAIT');
  }

  if (normalized.confidence < CONFIG.minConfidence) {
    reasons.push(`Confidence ${normalized.confidence} < ${CONFIG.minConfidence}`);
  }

  if (spreadPct === null || spreadPct === undefined) {
    reasons.push('Không lấy được spread bid/ask');
  } else if (spreadPct > CONFIG.maxSpreadPct) {
    reasons.push(`Spread ${spreadPct.toFixed(4)}% > ${CONFIG.maxSpreadPct}%`);
  }

  if (Math.abs(funding) > CONFIG.maxAbsFundingRate) {
    reasons.push(`Funding ${funding} vượt ngưỡng ${CONFIG.maxAbsFundingRate}`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    reasons.push('Giá hiện tại không hợp lệ');
  }

  if (normalized.signal !== 'WAIT') {
    for (const k of ['entry', 'stopLoss', 'takeProfit1', 'takeProfit2']) {
      if (!Number.isFinite(normalized[k]) || normalized[k] <= 0) {
        reasons.push(`${k} không hợp lệ`);
      }
    }

    const maxEntryDistance = price * 0.015;

    if (
      Number.isFinite(normalized.entry) &&
      Math.abs(normalized.entry - price) > maxEntryDistance
    ) {
      reasons.push('Entry cách giá hiện tại quá xa');
    }

    if (normalized.signal === 'LONG') {
      if (
        !(
          normalized.stopLoss < normalized.entry &&
          normalized.takeProfit1 > normalized.entry &&
          normalized.takeProfit2 > normalized.entry
        )
      ) {
        reasons.push('Cấu trúc LONG sai');
      }

      if (snapshot.indicators.trend === 'BEAR') {
        reasons.push('Trend BEAR không ưu tiên LONG');
      }
    }

    if (normalized.signal === 'SHORT') {
      if (
        !(
          normalized.stopLoss > normalized.entry &&
          normalized.takeProfit1 < normalized.entry &&
          normalized.takeProfit2 < normalized.entry
        )
      ) {
        reasons.push('Cấu trúc SHORT sai');
      }

      if (snapshot.indicators.trend === 'BULL') {
        reasons.push('Trend BULL không ưu tiên SHORT');
      }
    }

    const riskReward = rr(normalized);

    if (riskReward < CONFIG.minRR) {
      reasons.push(`RR ${riskReward.toFixed(2)} < ${CONFIG.minRR}`);
    }
  }

  let quantity = 0;
  let notional = 0;
  let marginUsed = 0;

  if (reasons.length === 0 && normalized.signal !== 'WAIT') {
    const leverage = Number(CONFIG.maxLeverage || 1);
    const orderMarginUsdt = Number(CONFIG.orderMarginUsdt || 10);
    const maxNotional = Number(CONFIG.maxNotional || CONFIG.maxNotionalUsdt || 30);

    marginUsed = orderMarginUsdt;
    notional = orderMarginUsdt * leverage;

    if (notional > maxNotional) {
      notional = maxNotional;
      marginUsed = notional / leverage;
    }

    quantity = notional / normalized.entry;

    quantity = round(quantity, precision);
    notional = quantity * normalized.entry;
    marginUsed = notional / leverage;

    if (quantity <= 0) {
      reasons.push('Quantity tính ra <= 0');
    }

    if (minQty > 0 && quantity < minQty) {
      reasons.push(`Quantity ${quantity} < minQty ${minQty}`);
    }

    if (minUsdt > 0 && notional < minUsdt) {
      reasons.push(`Notional ${notional.toFixed(4)} < minUSDT ${minUsdt}`);
    }

    if (notional > maxNotional) {
      reasons.push(`Notional ${notional.toFixed(4)} > maxNotional ${maxNotional}`);
    }
  }

  return {
    approved: reasons.length === 0 && normalized.signal !== 'WAIT',
    reasons,
    signal: normalized,
    quantity,
    notional,
    marginUsed,
    leverage: CONFIG.maxLeverage,
    spreadPct,
    funding,
    rr: rr(normalized)
  };
}
