import { CONFIG } from './config.js';

/**
 * Chuyển giá trị sang số hợp lệ.
 */
function toNumber(
  value,
  fallback = null
) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return fallback;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

/**
 * Làm tròn xuống theo precision.
 *
 * Dùng cho quantity để tránh vượt
 * precision hợp đồng BingX.
 */
function roundDown(
  value,
  precision = 4
) {
  const safePrecision =
    Math.max(
      0,
      Math.min(
        12,
        Number(precision) || 0
      )
    );

  const factor =
    10 ** safePrecision;

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return (
    Math.floor(
      number * factor
    ) /
    factor
  );
}

/**
 * Tính phần trăm khoảng cách giá.
 */
function priceDistancePct(
  priceA,
  priceB
) {
  const first =
    Number(priceA);

  const second =
    Number(priceB);

  if (
    !Number.isFinite(first) ||
    !Number.isFinite(second) ||
    first <= 0 ||
    second <= 0
  ) {
    return null;
  }

  return (
    Math.abs(
      first - second
    ) /
    first
  ) * 100;
}

/**
 * Tính Risk/Reward theo Entry 1.
 */
function calculateRR(signal) {
  const entry1 =
    toNumber(
      signal?.entry1 ??
      signal?.entry
    );

  const stopLoss =
    toNumber(
      signal?.stopLoss
    );

  const takeProfit1 =
    toNumber(
      signal?.takeProfit1
    );

  if (
    !Number.isFinite(entry1) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(takeProfit1)
  ) {
    return 0;
  }

  const risk =
    Math.abs(
      entry1 - stopLoss
    );

  const reward =
    Math.abs(
      takeProfit1 - entry1
    );

  if (risk <= 0) {
    return 0;
  }

  return reward / risk;
}

/**
 * Chuẩn hóa tín hiệu AI.
 */
function normalizeSignal(signal) {
  const direction =
    String(
      signal?.signal || ''
    )
      .trim()
      .toUpperCase();

  /*
   * Entry 1 ưu tiên:
   * entry1 → entry.
   */
  const entry1 =
    toNumber(
      signal?.entry1 ??
      signal?.entry
    );

  /*
   * Giữ entry tương thích code cũ.
   */
  const entry =
    entry1;

  return {
    signal:
      [
        'LONG',
        'SHORT',
        'WAIT'
      ].includes(direction)
        ? direction
        : 'WAIT',

    confidence:
      toNumber(
        signal?.confidence,
        0
      ),

    reason:
      String(
        signal?.reason || ''
      ),

    entry,

    entry1,

    entry2:
      toNumber(
        signal?.entry2
      ),

    stopLoss:
      toNumber(
        signal?.stopLoss
      ),

    takeProfit1:
      toNumber(
        signal?.takeProfit1
      ),

    takeProfit2:
      toNumber(
        signal?.takeProfit2
      ),

    riskNote:
      String(
        signal?.riskNote || ''
      )
  };
}

/**
 * Kiểm tra cấu trúc giá LONG/SHORT.
 */
function validatePriceStructure(
  normalized,
  reasons
) {
  const {
    signal,
    entry1,
    entry2,
    stopLoss,
    takeProfit1,
    takeProfit2
  } = normalized;

  const priceFields = [
    'entry1',
    'entry2',
    'stopLoss',
    'takeProfit1',
    'takeProfit2'
  ];

  for (
    const field of priceFields
  ) {
    if (
      !Number.isFinite(
        normalized[field]
      ) ||
      normalized[field] <= 0
    ) {
      reasons.push(
        `${field} không hợp lệ`
      );
    }
  }

  /*
   * Không kiểm tra cấu trúc tiếp nếu
   * một trong các mức giá chưa hợp lệ.
   */
  if (
    priceFields.some(
      field =>
        !Number.isFinite(
          normalized[field]
        ) ||
        normalized[field] <= 0
    )
  ) {
    return;
  }

  /*
   * LONG:
   *
   * SL < Entry 2 < Entry 1 < TP1 < TP2
   */
  if (signal === 'LONG') {
    if (
      !(
        stopLoss <
        entry2 &&

        entry2 <
        entry1 &&

        entry1 <
        takeProfit1 &&

        takeProfit1 <
        takeProfit2
      )
    ) {
      reasons.push(
        'Cấu trúc LONG sai: cần SL < Entry2 < Entry1 < TP1 < TP2'
      );
    }
  }

  /*
   * SHORT:
   *
   * TP2 < TP1 < Entry 1 < Entry 2 < SL
   */
  if (signal === 'SHORT') {
    if (
      !(
        takeProfit2 <
        takeProfit1 &&

        takeProfit1 <
        entry1 &&

        entry1 <
        entry2 &&

        entry2 <
        stopLoss
      )
    ) {
      reasons.push(
        'Cấu trúc SHORT sai: cần TP2 < TP1 < Entry1 < Entry2 < SL'
      );
    }
  }
}

/**
 * Kiểm tra Entry 1 có quá xa
 * giá thị trường hiện tại không.
 */
function validateEntryDistance(
  normalized,
  marketPrice,
  reasons
) {
  const entryDistancePct =
    priceDistancePct(
      marketPrice,
      normalized.entry1
    );

  const maxEntryDistancePct =
    Math.max(
      0,
      Number(
        CONFIG.maxEntryDistancePct ??
        0.25
      )
    );

  if (
    entryDistancePct !== null &&
    entryDistancePct >
    maxEntryDistancePct
  ) {
    reasons.push(
      `Entry 1 cách giá hiện tại ` +
      `${entryDistancePct.toFixed(3)}% ` +
      `> ${maxEntryDistancePct}%`
    );
  }
}

/**
 * Kiểm tra khoảng cách Entry 2.
 */
function validateEntry2Distance(
  normalized,
  reasons
) {
  const entry1 =
    normalized.entry1;

  const entry2 =
    normalized.entry2;

  const stopLoss =
    normalized.stopLoss;

  if (
    !Number.isFinite(entry1) ||
    !Number.isFinite(entry2) ||
    !Number.isFinite(stopLoss) ||
    entry1 <= 0 ||
    entry2 <= 0 ||
    stopLoss <= 0
  ) {
    return;
  }

  const distancePct =
    priceDistancePct(
      entry1,
      entry2
    );

  const minDistancePct =
    Math.max(
      0,
      Number(
        CONFIG.entry2MinDistancePct ??
        0.15
      )
    );

  const maxDistancePct =
    Math.max(
      minDistancePct,
      Number(
        CONFIG.entry2MaxDistancePct ??
        0.6
      )
    );

  if (
    distancePct !== null &&
    distancePct <
    minDistancePct
  ) {
    reasons.push(
      `Entry 2 quá gần Entry 1: ` +
      `${distancePct.toFixed(3)}% ` +
      `< ${minDistancePct}%`
    );
  }

  if (
    distancePct !== null &&
    distancePct >
    maxDistancePct
  ) {
    reasons.push(
      `Entry 2 quá xa Entry 1: ` +
      `${distancePct.toFixed(3)}% ` +
      `> ${maxDistancePct}%`
    );
  }

  /*
   * Entry 2 không được nằm quá sâu
   * về phía Stop Loss.
   *
   * Ví dụ:
   * ENTRY2_MAX_STOP_RATIO=0.65
   *
   * nghĩa là khoảng cách Entry1 → Entry2
   * không vượt quá 65% khoảng cách
   * Entry1 → Stop Loss.
   */
  const distanceEntryToStop =
    Math.abs(
      entry1 -
      stopLoss
    );

  const distanceEntryToEntry2 =
    Math.abs(
      entry1 -
      entry2
    );

  const maxStopRatio =
    Math.max(
      0,
      Math.min(
        1,
        Number(
          CONFIG.entry2MaxStopRatio ??
          0.65
        )
      )
    );

  if (
    distanceEntryToStop > 0
  ) {
    const stopRatio =
      distanceEntryToEntry2 /
      distanceEntryToStop;

    if (
      stopRatio >
      maxStopRatio
    ) {
      reasons.push(
        `Entry 2 nằm quá gần Stop Loss: ` +
        `tỷ lệ ${(stopRatio * 100).toFixed(1)}% ` +
        `> ${(maxStopRatio * 100).toFixed(1)}%`
      );
    }
  }
}

/**
 * Kiểm tra khoảng Stop Loss.
 */
function validateStopDistance(
  normalized,
  reasons
) {
  const stopDistancePct =
    priceDistancePct(
      normalized.entry1,
      normalized.stopLoss
    );

  if (stopDistancePct === null) {
    return;
  }

  const minSlPct =
    Math.max(
      0,
      Number(
        CONFIG.minSlPct ??
        0.6
      )
    );

  const maxSlPct =
    Math.max(
      minSlPct,
      Number(
        CONFIG.maxSlPct ??
        1.5
      )
    );

  if (
    stopDistancePct <
    minSlPct
  ) {
    reasons.push(
      `Stop Loss quá gần: ` +
      `${stopDistancePct.toFixed(3)}% ` +
      `< ${minSlPct}%`
    );
  }

  if (
    stopDistancePct >
    maxSlPct
  ) {
    reasons.push(
      `Stop Loss quá xa: ` +
      `${stopDistancePct.toFixed(3)}% ` +
      `> ${maxSlPct}%`
    );
  }
}

/**
 * Kiểm tra xu hướng khung Entry.
 */
function validateTrend(
  normalized,
  snapshot,
  reasons
) {
  const trend =
    String(
      snapshot?.indicators?.trend ||
      ''
    )
      .trim()
      .toUpperCase();

  if (
    normalized.signal === 'LONG' &&
    trend === 'BEAR'
  ) {
    reasons.push(
      'Trend khung Entry đang BEAR, không ưu tiên LONG'
    );
  }

  if (
    normalized.signal === 'SHORT' &&
    trend === 'BULL'
  ) {
    reasons.push(
      'Trend khung Entry đang BULL, không ưu tiên SHORT'
    );
  }
}

/**
 * Risk validation và tính khối lượng.
 */
export function validateAndSize(
  signal,
  snapshot
) {
  const reasons = [];

  const normalized =
    normalizeSignal(
      signal
    );

  const price =
    toNumber(
      snapshot?.indicators
        ?.lastClose
    );

  const spreadPct =
    toNumber(
      snapshot?.book
        ?.spreadPct
    );

  const funding =
    toNumber(
      snapshot?.premium
        ?.lastFundingRate ??
      snapshot?.funding
        ?.fundingRate,
      0
    );

  const precision =
    Math.max(
      0,
      Number(
        snapshot?.contract
          ?.quantityPrecision ??
        4
      )
    );

  const minQty =
    Math.max(
      0,
      Number(
        snapshot?.contract
          ?.tradeMinQuantity ??
        0
      )
    );

  const minUsdt =
    Math.max(
      0,
      Number(
        snapshot?.contract
          ?.tradeMinUSDT ??
        0
      )
    );

  /*
   * AI chọn WAIT.
   */
  if (
    normalized.signal ===
    'WAIT'
  ) {
    reasons.push(
      'AI chọn WAIT'
    );
  }

  /*
   * Confidence.
   */
  if (
    normalized.confidence <
    CONFIG.minConfidence
  ) {
    reasons.push(
      `Confidence ` +
      `${normalized.confidence} ` +
      `< ${CONFIG.minConfidence}`
    );
  }

  /*
   * Spread.
   */
  if (
    spreadPct === null
  ) {
    reasons.push(
      'Không lấy được spread bid/ask'
    );
  } else if (
    spreadPct >
    CONFIG.maxSpreadPct
  ) {
    reasons.push(
      `Spread ` +
      `${spreadPct.toFixed(4)}% ` +
      `> ${CONFIG.maxSpreadPct}%`
    );
  }

  /*
   * Funding.
   */
  if (
    Math.abs(funding) >
    CONFIG.maxAbsFundingRate
  ) {
    reasons.push(
      `Funding ${funding} ` +
      `vượt ngưỡng ` +
      `${CONFIG.maxAbsFundingRate}`
    );
  }

  /*
   * Giá hiện tại.
   */
  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    reasons.push(
      'Giá hiện tại không hợp lệ'
    );
  }

  if (
    normalized.signal !==
    'WAIT'
  ) {
    validatePriceStructure(
      normalized,
      reasons
    );

    validateEntryDistance(
      normalized,
      price,
      reasons
    );

    validateEntry2Distance(
      normalized,
      reasons
    );

    validateStopDistance(
      normalized,
      reasons
    );

    validateTrend(
      normalized,
      snapshot,
      reasons
    );

    const riskReward =
      calculateRR(
        normalized
      );

    if (
      riskReward <
      CONFIG.minRR
    ) {
      reasons.push(
        `RR ` +
        `${riskReward.toFixed(2)} ` +
        `< ${CONFIG.minRR}`
      );
    }
  }

  let quantity = 0;
  let notional = 0;
  let marginUsed = 0;

  const leverage =
    Math.max(
      1,
      Number(
        CONFIG.maxLeverage ||
        1
      )
    );

  const orderMarginUsdt =
    Math.max(
      0,
      Number(
        CONFIG.orderMarginUsdt ||
        10
      )
    );

  const maxNotional =
    Math.max(
      0,
      Number(
        CONFIG.maxNotional ||
        30
      )
    );

  /*
   * Chỉ tính quantity khi toàn bộ
   * điều kiện risk đã hợp lệ.
   */
  if (
    reasons.length === 0 &&
    normalized.signal !==
    'WAIT'
  ) {
    marginUsed =
      orderMarginUsdt;

    notional =
      orderMarginUsdt *
      leverage;

    if (
      maxNotional > 0 &&
      notional >
      maxNotional
    ) {
      notional =
        maxNotional;

      marginUsed =
        notional /
        leverage;
    }

    quantity =
      notional /
      normalized.entry1;

    quantity =
      roundDown(
        quantity,
        precision
      );

    notional =
      quantity *
      normalized.entry1;

    marginUsed =
      leverage > 0
        ? notional /
          leverage
        : 0;

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      reasons.push(
        'Quantity tính ra <= 0'
      );
    }

    if (
      minQty > 0 &&
      quantity <
      minQty
    ) {
      reasons.push(
        `Quantity ${quantity} ` +
        `< minQty ${minQty}`
      );
    }

    if (
      minUsdt > 0 &&
      notional <
      minUsdt
    ) {
      reasons.push(
        `Notional ` +
        `${notional.toFixed(4)} ` +
        `< minUSDT ${minUsdt}`
      );
    }

    if (
      maxNotional > 0 &&
      notional >
      maxNotional
    ) {
      reasons.push(
        `Notional ` +
        `${notional.toFixed(4)} ` +
        `> maxNotional ${maxNotional}`
      );
    }
  }

  const riskReward =
    calculateRR(
      normalized
    );

  return {
    approved:
      reasons.length === 0 &&
      normalized.signal !==
      'WAIT',

    reasons,

    /*
     * Quan trọng:
     * Giữ đầy đủ entry, entry1, entry2
     * để executor, DB và DCA sử dụng.
     */
    signal:
      normalized,

    quantity,

    notional,

    marginUsed,

    leverage,

    spreadPct,

    funding,

    rr:
      riskReward
  };
}
