import OpenAI from 'openai';
import { CONFIG } from './config.js';

let openaiClient = null;

/**

* Khởi tạo OpenAI client một lần và tái sử dụng.
  */
function getOpenAIClient() {
  if (!CONFIG.openaiApiKey) {
    throw new Error(
      'Thiếu OPENAI_API_KEY trong biến môi trường'
    );
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: CONFIG.openaiApiKey
    });
  }

  return openaiClient;
}

/**

* Chuyển giá trị sang số hợp lệ.
  */
function toNumber(value, fallback = null) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

/**

* Giới hạn số trong một khoảng.
  */
function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

/**

* Làm tròn giá theo precision hợp đồng.
  */
function roundPrice(value, precision = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const safePrecision = clamp(
    Number(precision) || 2,
    0,
    12
  );

  const multiplier =
    Math.pow(10, safePrecision);

  return (
    Math.round(number * multiplier) /
    multiplier
  );
}

/**

* Chuẩn hóa output text rồi parse JSON.
  */
function safeJson(text) {
  const raw = String(text || '').trim();

  if (!raw) {
    throw new Error(
      'OpenAI không trả về nội dung'
    );
  }

  const cleaned = raw
    .replace(/^`json\s*/i, '')
    .replace(/^`\s*/i, '')
    .replace(/\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace =
      cleaned.indexOf('{');

    
const lastBrace =
  cleaned.lastIndexOf('}');

if (
  firstBrace >= 0 &&
  lastBrace > firstBrace
) {
  return JSON.parse(
    cleaned.slice(
      firstBrace,
      lastBrace + 1
    )
  );
}

throw new Error(
  `Không parse được JSON từ OpenAI: ${ cleaned } `
);


  }
}

/**

* Lấy output text từ Responses API.
  */
function extractOutputText(response) {
  if (
    typeof response?.output_text === 'string' &&
    response.output_text.trim()
  ) {
    return response.output_text;
  }

  const output = Array.isArray(response?.output)
    ? response.output
    : [];

  const textParts = [];

  for (const item of output) {
    const contents = Array.isArray(item?.content)
      ? item.content
      : [];

    
for (const content of contents) {
  if (
    typeof content?.text === 'string'
  ) {
    textParts.push(content.text);
  }
}


  }

  return textParts.join('\n').trim();
}

/**

* Chuyển timestamp giây hoặc mili giây về mili giây.
  */
function normalizeTimestamp(value) {
  const time = Number(value);

  if (!Number.isFinite(time)) {
    return null;
  }

  return time < 1_000_000_000_000
    ? time * 1000
    : time;
}

/**

* Lọc ưu tiên các nến đã đóng.
  */
function getClosedCandles(snapshot) {
  const candles = Array.isArray(
    snapshot?.candles
  )
    ? snapshot.candles
    : [];

  if (candles.length === 0) {
    return [];
  }

  const now = Date.now();

  const closedCandles = candles.filter(
    candle => {
      const closeTime =
        normalizeTimestamp(
          candle?.closeTime
        );

      
  if (!closeTime) {
    return true;
  }

  return closeTime <= now;
}


);

  return closedCandles.length >= 20
    ? closedCandles
    : candles;
}

/**

* Rút gọn dữ liệu nến gửi sang AI.
  */
function compactCandles(
  snapshot,
  limit
) {
  return getClosedCandles(snapshot)
    .slice(-limit)
    .map(candle => ({
      time:
        candle.time,

      open:
        candle.open,

      high:
        candle.high,

      low:
        candle.low,

      close:
        candle.close,

      volume:
        candle.volume,

      closeTime:
        candle.closeTime
    }));
}

/**

* Lấy snapshot theo interval.
  */
function getTimeframeSnapshot(
  snapshot,
  interval,
  fallbackKey
) {
  return (
    snapshot?.timeframes?.[interval] ||
    snapshot?.[fallbackKey] ||
    snapshot
  );
}

/**

* Tạo dữ liệu một khung thời gian để gửi sang AI.
  */
function buildTimeframePayload(
  snapshot,
  role,
  candleLimit
) {
  return {
    role,

    symbol:
      snapshot?.symbol ||
      CONFIG.symbol,

    interval:
      snapshot?.interval ||
      null,

    recentClosedCandles:
      compactCandles(
        snapshot,
        candleLimit
      ),

    indicators:
      snapshot?.indicators || {}
  };
}

/**

* Lấy giá thị trường gần nhất.
  */
function getCurrentPrice(
  multiSnapshot,
  entrySnapshot
) {
  const bidPrice = toNumber(
    multiSnapshot?.book?.bidPrice ??
    entrySnapshot?.book?.bidPrice
  );

  const askPrice = toNumber(
    multiSnapshot?.book?.askPrice ??
    entrySnapshot?.book?.askPrice
  );

  if (
    bidPrice > 0 &&
    askPrice > 0
  ) {
    return (
      bidPrice + askPrice
    ) / 2;
  }

  const markPrice = toNumber(
    multiSnapshot?.premium?.markPrice ??
    entrySnapshot?.premium?.markPrice
  );

  if (markPrice > 0) {
    return markPrice;
  }

  const candles =
    getClosedCandles(entrySnapshot);

  const candleClose = toNumber(
    candles.at(-1)?.close
  );

  if (candleClose > 0) {
    return candleClose;
  }

  return toNumber(
    entrySnapshot?.indicators?.lastClose
  );
}

/**

* Lấy ATR từ khung entry.
  */
function getAtr(snapshot) {
  return toNumber(
    snapshot?.indicators?.atr14 ??
    snapshot?.indicators?.atr ??
    snapshot?.indicators?.ATR
  );
}

/**

* Tìm swing low hoặc swing high gần nhất trong khung xác nhận.
  */
function findRecentSwing(
  snapshot,
  direction,
  entry
) {
  const configuredLookback =
    Number(
      CONFIG.structureLookback || 20
    );

  const lookback = clamp(
    configuredLookback,
    5,
    50
  );

  const candles =
    getClosedCandles(snapshot)
      .slice(-lookback);

  if (candles.length < 3) {
    return null;
  }

  for (
    let index = candles.length - 2;
    index >= 1;
    index -= 1
  ) {
    const previous =
      candles[index - 1];

    
const current =
  candles[index];

const next =
  candles[index + 1];

if (direction === 'LONG') {
  const low =
    toNumber(current?.low);

  if (
    low > 0 &&
    low < entry &&
    low <= toNumber(
      previous?.low,
      Infinity
    ) &&
    low <= toNumber(
      next?.low,
      Infinity
    )
  ) {
    return low;
  }
}

if (direction === 'SHORT') {
  const high =
    toNumber(current?.high);

  if (
    high > entry &&
    high >= toNumber(
      previous?.high,
      -Infinity
    ) &&
    high >= toNumber(
      next?.high,
      -Infinity
    )
  ) {
    return high;
  }
}


  }

  if (direction === 'LONG') {
    const lows = candles
      .map(candle =>
        toNumber(candle?.low)
      )
      .filter(
        low =>
          Number.isFinite(low) &&
          low > 0 &&
          low < entry
      );

    
return lows.length > 0
  ? Math.min(...lows)
  : null;


  }

  const highs = candles
    .map(candle =>
      toNumber(candle?.high)
    )
    .filter(
      high =>
        Number.isFinite(high) &&
        high > entry
    );

  return highs.length > 0
    ? Math.max(...highs)
    : null;
}

/**

* Lấy tất cả số từ support/resistance.
  */
function extractLevelNumbers(value) {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? [value]
      : [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap(item =>
        extractLevelNumbers(item)
      )
      .filter(Number.isFinite);
  }

  if (typeof value === 'object') {
    return Object.values(value)
      .flatMap(item =>
        extractLevelNumbers(item)
      )
      .filter(Number.isFinite);
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? [number]
    : [];
}

/**

* Lấy high/low gần nhất từ nến khung lớn.
  */
function getRecentHighLowLevels(snapshot) {
  const lookback =
    Math.max(
      10,
      Number(
        CONFIG.structureLookback || 20
      )
    );

  const candles =
    getClosedCandles(snapshot)
      .slice(-lookback);

  if (candles.length === 0) {
    return {
      highs: [],
      lows: []
    };
  }

  return {
    highs:
      candles
        .map(candle =>
          toNumber(candle.high)
        )
        .filter(
          value =>
            Number.isFinite(value) &&
            value > 0
        ),


lows:
  candles
    .map(candle =>
      toNumber(candle.low)
    )
    .filter(
      value =>
        Number.isFinite(value) &&
        value > 0
    )


};
}

/**

* Gom hỗ trợ/kháng cự từ indicator và nến.
  */
function getSupportResistanceLevels(
  snapshot
) {
  const indicators =
    snapshot?.indicators || {};

  const candleLevels =
    getRecentHighLowLevels(snapshot);

  const supports = [
    ...extractLevelNumbers(
      indicators.support
    ),

    
...extractLevelNumbers(
  indicators.supports
),

...extractLevelNumbers(
  indicators.swingLow
),

...extractLevelNumbers(
  indicators.swingLows
),

...extractLevelNumbers(
  indicators.lowLiquidityZone
),

...candleLevels.lows


  ];

  const resistances = [
    ...extractLevelNumbers(
      indicators.resistance
    ),

    
...extractLevelNumbers(
  indicators.resistances
),

...extractLevelNumbers(
  indicators.swingHigh
),

...extractLevelNumbers(
  indicators.swingHighs
),

...extractLevelNumbers(
  indicators.highLiquidityZone
),

...candleLevels.highs


  ];

  return {
    supports: [
      ...new Set(
        supports.filter(Number.isFinite)
      )
    ],


resistances: [
  ...new Set(
    resistances.filter(Number.isFinite)
  )
]


};
}

/**

* Kiểm tra entry2 có hợp lệ không.
  */
function isValidEntry2({
  direction,
  entry1,
  entry2,
  stopLoss,
  minDistance,
  maxDistance
}) {
  if (
    !Number.isFinite(entry2) ||
    entry2 <= 0
  ) {
    return false;
  }

  if (direction === 'LONG') {
    const distance =
      entry1 - entry2;

    
return (
  entry2 < entry1 &&
  entry2 > stopLoss &&
  distance >= minDistance &&
  distance <= maxDistance
);


  }

  if (direction === 'SHORT') {
    const distance =
      entry2 - entry1;

    
return (
  entry2 > entry1 &&
  entry2 < stopLoss &&
  distance >= minDistance &&
  distance <= maxDistance
);


  }

  return false;
}

/**

* Entry 2:
* * LONG: nằm dưới Entry 1, gần hỗ trợ khung lớn, trên SL.
* * SHORT: nằm trên Entry 1, gần kháng cự khung lớn, dưới SL.
    */
function pickEntry2FromHigherTimeframes({
  rawSignal,
  direction,
  entry1,
  stopLoss,
  atr,
  pricePrecision,
  confirmSnapshot,
  trendSnapshot
}) {
  const stopDistance =
    Math.abs(entry1 - stopLoss);

  if (
    !Number.isFinite(stopDistance) ||
    stopDistance <= 0
  ) {
    return {
      entry2: null,
      source: 'NO_STOP_DISTANCE'
    };
  }

  const minDistancePct =
    Math.max(
      0,
      Number(
        CONFIG.entry2MinDistancePct ??
        process.env.ENTRY2_MIN_DISTANCE_PCT ??
        0.15
      )
    );

  const maxDistancePct =
    Math.max(
      0,
      Number(
        CONFIG.entry2MaxDistancePct ??
        process.env.ENTRY2_MAX_DISTANCE_PCT ??
        0.6
      )
    );

  const maxStopRatio =
    Math.max(
      0.1,
      Math.min(
        0.9,
        Number(
          CONFIG.entry2MaxStopRatio ??
          process.env.ENTRY2_MAX_STOP_RATIO ??
          0.65
        )
      )
    );

  const minDistance =
    entry1 * (
      minDistancePct / 100
    );

  const maxDistanceByPct =
    entry1 * (
      maxDistancePct / 100
    );

  const maxDistanceByStop =
    stopDistance * maxStopRatio;

  const maxDistance =
    Math.min(
      maxDistanceByPct,
      maxDistanceByStop
    );

  if (
    maxDistance <= 0 ||
    minDistance > maxDistance
  ) {
    return {
      entry2: null,
      source: 'ENTRY2_DISTANCE_CONFIG_INVALID'
    };
  }

  const confirmLevels =
    getSupportResistanceLevels(
      confirmSnapshot
    );

  const trendLevels =
    getSupportResistanceLevels(
      trendSnapshot
    );

  let candidateLevels = [];

  if (direction === 'LONG') {
    candidateLevels = [
      ...confirmLevels.supports.map(level => ({
        level,
        source: 'support_confirm'
      })),

      
  ...trendLevels.supports.map(level => ({
    level,
    source: 'support_trend'
  }))
]
  .filter(item =>
    isValidEntry2({
      direction,
      entry1,
      entry2: item.level,
      stopLoss,
      minDistance,
      maxDistance
    })
  )
  .sort(
    (a, b) =>
      Math.abs(entry1 - a.level) -
      Math.abs(entry1 - b.level)
  );


}

  if (direction === 'SHORT') {
    candidateLevels = [
      ...confirmLevels.resistances.map(level => ({
        level,
        source: 'resistance_confirm'
      })),

      
  ...trendLevels.resistances.map(level => ({
    level,
    source: 'resistance_trend'
  }))
]
  .filter(item =>
    isValidEntry2({
      direction,
      entry1,
      entry2: item.level,
      stopLoss,
      minDistance,
      maxDistance
    })
  )
  .sort(
    (a, b) =>
      Math.abs(entry1 - a.level) -
      Math.abs(entry1 - b.level)
  );


}

  const pickedLevel =
    candidateLevels[0];

  if (
    pickedLevel &&
    Number.isFinite(pickedLevel.level)
  ) {
    return {
      entry2:
        roundPrice(
          pickedLevel.level,
          pricePrecision
        ),


  source:
    pickedLevel.source
};


  }

  /*
  
  * Ưu tiên tiếp theo:
  * entry2 do AI đề xuất, miễn là hợp lệ.
    */
  const rawEntry2 =
    toNumber(rawSignal?.entry2);

  if (
    isValidEntry2({
      direction,
      entry1,
      entry2: rawEntry2,
      stopLoss,
      minDistance,
      maxDistance
    })
  ) {
    return {
      entry2:
        roundPrice(
          rawEntry2,
          pricePrecision
        ),


  source:
    'ai_entry2'
};


  }

  /*
  
  * Fallback cuối:
  * dùng ATR để tạo entry2.
    */
  const entry2AtrMult =
    Math.max(
      0.1,
      Number(
        CONFIG.entry2AtrMult ??
        process.env.ENTRY2_ATR_MULT ??
        0.6
      )
    );

  const atrDistance =
    atr * entry2AtrMult;

  const fallbackDistance =
    Math.min(
      atrDistance,
      maxDistance
    );

  if (
    !Number.isFinite(fallbackDistance) ||
    fallbackDistance < minDistance
  ) {
    return {
      entry2: null,
      source: 'NO_VALID_ENTRY2'
    };
  }

  if (direction === 'LONG') {
    const entry2 =
      entry1 - fallbackDistance;

    
if (
  isValidEntry2({
    direction,
    entry1,
    entry2,
    stopLoss,
    minDistance,
    maxDistance
  })
) {
  return {
    entry2:
      roundPrice(
        entry2,
        pricePrecision
      ),

    source:
      'atr_fallback'
  };
}


  }

  if (direction === 'SHORT') {
    const entry2 =
      entry1 + fallbackDistance;

    
if (
  isValidEntry2({
    direction,
    entry1,
    entry2,
    stopLoss,
    minDistance,
    maxDistance
  })
) {
  return {
    entry2:
      roundPrice(
        entry2,
        pricePrecision
      ),

    source:
      'atr_fallback'
  };
}


  }

  return {
    entry2: null,
    source: 'NO_VALID_ENTRY2'
  };
}

/**

* Nối thêm nội dung vào riskNote.
  */
function appendNote(
  currentNote,
  newNote
) {
  const parts = [
    String(currentNote || '').trim(),
    String(newNote || '').trim()
  ].filter(Boolean);

  return parts.join(' | ');
}

/**

* Không để WAIT mặc định confidence = 0
* trong trường hợp dữ liệu vẫn phân tích được.
  */
function normalizeWaitConfidence(
  confidence,
  reason,
  riskNote
) {
  const original =
    clamp(
      toNumber(confidence, 0),
      0,
      100
    );

  if (original > 0) {
    return original;
  }

  const text = `${reason || ''} ${riskNote || ''}`
    .toLowerCase();

  const hardInvalid =
    text.includes('không có atr') ||
    text.includes('không xác định được giá') ||
    text.includes('không lấy được') ||
    text.includes('dữ liệu không đủ') ||
    text.includes('không hợp lệ') ||
    text.includes('parse') ||
    text.includes('mâu thuẫn nghiêm trọng');

  if (hardInvalid) {
    return 0;
  }

  return 35;
}

/**

* Tạo kết quả WAIT chuẩn.
  */
function createWaitSignal(
  reason,
  confidence = 0,
  riskNote = ''
) {
  const normalizedConfidence =
    normalizeWaitConfidence(
      confidence,
      reason,
      riskNote
    );

  return {
    signal: 'WAIT',


confidence:
  normalizedConfidence,

reason:
  String(
    reason ||
    'Chưa đủ điều kiện vào lệnh'
  ),

entry: null,
entry1: null,
entry2: null,

stopLoss: null,
takeProfit1: null,
takeProfit2: null,

riskNote:
  String(riskNote || '')


};
}

/**

* Chuẩn hóa và bảo vệ SL/TP.
  */
function protectSignalGeometry(
  rawSignal,
  multiSnapshot
) {
  const direction = String(
    rawSignal?.signal || 'WAIT'
  )
    .trim()
    .toUpperCase();

  const confidence = clamp(
    toNumber(
      rawSignal?.confidence,
      0
    ),
    0,
    100
  );

  const reason = String(
    rawSignal?.reason || ''
  ).trim();

  let riskNote = String(
    rawSignal?.riskNote || ''
  ).trim();

  if (
    ![
      'LONG',
      'SHORT',
      'WAIT'
    ].includes(direction)
  ) {
    return createWaitSignal(
      `Signal AI không hợp lệ: ${direction}`,
      confidence,
      riskNote
    );
  }

  if (direction === 'WAIT') {
    return createWaitSignal(
      reason ||
      'Các khung thời gian chưa đồng thuận',
      confidence,
      riskNote
    );
  }

  const entryInterval =
    multiSnapshot?.entryInterval ||
    CONFIG.entryInterval ||
    CONFIG.interval;

  const confirmInterval =
    multiSnapshot?.confirmInterval ||
    CONFIG.confirmInterval ||
    entryInterval;

  const trendInterval =
    multiSnapshot?.trendInterval ||
    CONFIG.trendInterval ||
    confirmInterval;

  const entrySnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      entryInterval,
      'entrySnapshot'
    );

  const confirmSnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      confirmInterval,
      'confirmSnapshot'
    );

  const trendSnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      trendInterval,
      'trendSnapshot'
    );

  const currentPrice =
    getCurrentPrice(
      multiSnapshot,
      entrySnapshot
    );

  const atr =
    getAtr(entrySnapshot);

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return createWaitSignal(
      'Không xác định được giá thị trường hiện tại',
      confidence,
      riskNote
    );
  }

  if (
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return createWaitSignal(
      `Không có ATR hợp lệ trên khung ${entryInterval}`,
      confidence,
      riskNote
    );
  }

  const aiEntry =
    toNumber(rawSignal?.entry);

  const maxEntryDistancePct =
    Math.max(
      0,
      Number(
        CONFIG.maxEntryDistancePct ??
        0.25
      )
    );

  if (
    aiEntry > 0 &&
    maxEntryDistancePct > 0
  ) {
    const aiEntryDistancePct =
      (
        Math.abs(
          aiEntry - currentPrice
        ) /
        currentPrice
      ) * 100;

    
if (
  aiEntryDistancePct >
  maxEntryDistancePct
) {
  riskNote = appendNote(
    riskNote,
    `Entry AI lệch ${ aiEntryDistancePct.toFixed(2) }%, đã dùng giá thị trường`
  );
}


  }

  const entry =
    currentPrice;

  const slAtrMult =
    Math.max(
      0,
      Number(
        CONFIG.slAtrMult || 1.3
      )
    );

  const tp1AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp1AtrMult || 1.8
      )
    );

  const tp2AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp2AtrMult || 2.8
      )
    );

  const minSlPct =
    Math.max(
      0,
      Number(
        CONFIG.minSlPct || 0.35
      )
    );

  const maxSlPct =
    Math.max(
      0,
      Number(
        CONFIG.maxSlPct || 2.2
      )
    );

  const minRR =
    Math.max(
      1,
      Number(
        CONFIG.minRR || 1.2
      )
    );

  const atrStopDistance =
    atr * slAtrMult;

  const percentStopDistance =
    entry * (
      minSlPct / 100
    );

  const minimumStopDistance =
    Math.max(
      atrStopDistance,
      percentStopDistance
    );

  const maximumStopDistance =
    maxSlPct > 0
      ? entry * (
        maxSlPct / 100
      )
      : Infinity;

  if (
    minimumStopDistance >
    maximumStopDistance
  ) {
    return createWaitSignal(
      'Cấu hình MIN_SL_PCT, MAX_SL_PCT hoặc SL_ATR_MULT đang xung đột',
      confidence,
      riskNote
    );
  }

  const aiStopLoss =
    toNumber(rawSignal?.stopLoss);

  let aiStopDistance = 0;

  if (
    direction === 'LONG' &&
    aiStopLoss > 0 &&
    aiStopLoss < entry
  ) {
    aiStopDistance =
      entry - aiStopLoss;
  }

  if (
    direction === 'SHORT' &&
    aiStopLoss > entry
  ) {
    aiStopDistance =
      aiStopLoss - entry;
  }

  const swingPrice =
    findRecentSwing(
      confirmSnapshot,
      direction,
      entry
    );

  const structureBuffer =
    atr * 0.15;

  let structureStopDistance = 0;

  if (
    direction === 'LONG' &&
    swingPrice > 0 &&
    swingPrice < entry
  ) {
    structureStopDistance =
      entry -
      (
        swingPrice -
        structureBuffer
      );
  }

  if (
    direction === 'SHORT' &&
    swingPrice > entry
  ) {
    structureStopDistance =
      (
        swingPrice +
        structureBuffer
      ) - entry;
  }

  const stopDistance =
    Math.max(
      minimumStopDistance,
      aiStopDistance,
      structureStopDistance
    );

  const stopDistancePct =
    (
      stopDistance /
      entry
    ) * 100;

  if (
    stopDistance >
    maximumStopDistance
  ) {
    return createWaitSignal(
      `SL cần rộng ${stopDistancePct.toFixed(2)}%, vượt MAX_SL_PCT=${maxSlPct}%`,
      confidence,
      appendNote(
        riskNote,
        'Cấu trúc hiện tại chưa phù hợp để vào MARKET'
      )
    );
  }

  const minimumTp1Distance =
    Math.max(
      stopDistance * minRR,
      atr * tp1AtrMult
    );

  const aiTakeProfit1 =
    toNumber(
      rawSignal?.takeProfit1
    );

  let aiTp1Distance = 0;

  if (
    direction === 'LONG' &&
    aiTakeProfit1 > entry
  ) {
    aiTp1Distance =
      aiTakeProfit1 - entry;
  }

  if (
    direction === 'SHORT' &&
    aiTakeProfit1 > 0 &&
    aiTakeProfit1 < entry
  ) {
    aiTp1Distance =
      entry - aiTakeProfit1;
  }

  const tp1Distance =
    Math.max(
      minimumTp1Distance,
      aiTp1Distance
    );

  const minimumTp2Distance =
    Math.max(
      atr * tp2AtrMult,
      tp1Distance * 1.35
    );

  const aiTakeProfit2 =
    toNumber(
      rawSignal?.takeProfit2
    );

  let aiTp2Distance = 0;

  if (
    direction === 'LONG' &&
    aiTakeProfit2 > entry
  ) {
    aiTp2Distance =
      aiTakeProfit2 - entry;
  }

  if (
    direction === 'SHORT' &&
    aiTakeProfit2 > 0 &&
    aiTakeProfit2 < entry
  ) {
    aiTp2Distance =
      entry - aiTakeProfit2;
  }

  const tp2Distance =
    Math.max(
      minimumTp2Distance,
      aiTp2Distance
    );

  const pricePrecision =
    Number(
      multiSnapshot?.contract
        ?.pricePrecision ??
      entrySnapshot?.contract
        ?.pricePrecision ??
      2
    );

  let stopLoss;
  let takeProfit1;
  let takeProfit2;

  if (direction === 'LONG') {
    stopLoss = roundPrice(
      entry - stopDistance,
      pricePrecision
    );

    
takeProfit1 = roundPrice(
  entry + tp1Distance,
  pricePrecision
);

takeProfit2 = roundPrice(
  entry + tp2Distance,
  pricePrecision
);


  } else {
    stopLoss = roundPrice(
      entry + stopDistance,
      pricePrecision
    );

    
takeProfit1 = roundPrice(
  entry - tp1Distance,
  pricePrecision
);

takeProfit2 = roundPrice(
  entry - tp2Distance,
  pricePrecision
);


  }

  const roundedEntry =
    roundPrice(
      entry,
      pricePrecision
    );

  if (
    !roundedEntry ||
    !stopLoss ||
    !takeProfit1 ||
    !takeProfit2
  ) {
    return createWaitSignal(
      'Không tính được Entry, SL hoặc TP hợp lệ',
      confidence,
      riskNote
    );
  }

  const entry2Result =
    pickEntry2FromHigherTimeframes({
      rawSignal,
      direction,
      entry1: roundedEntry,
      stopLoss,
      atr,
      pricePrecision,
      confirmSnapshot,
      trendSnapshot
    });

  const entry2 =
    entry2Result.entry2;

  if (
    direction === 'LONG' &&
    !(
      stopLoss < roundedEntry &&
      takeProfit1 > roundedEntry &&
      takeProfit2 > takeProfit1
    )
  ) {
    return createWaitSignal(
      'Cấu trúc giá LONG không hợp lệ sau khi làm tròn',
      confidence,
      riskNote
    );
  }

  if (
    direction === 'SHORT' &&
    !(
      stopLoss > roundedEntry &&
      takeProfit1 < roundedEntry &&
      takeProfit2 < takeProfit1
    )
  ) {
    return createWaitSignal(
      'Cấu trúc giá SHORT không hợp lệ sau khi làm tròn',
      confidence,
      riskNote
    );
  }

  const actualRisk =
    Math.abs(
      roundedEntry - stopLoss
    );

  const actualReward =
    Math.abs(
      takeProfit1 - roundedEntry
    );

  const actualRR =
    actualRisk > 0
      ? actualReward / actualRisk
      : 0;

  if (
    actualRR < minRR
  ) {
    return createWaitSignal(
      `RR sau khi chuẩn hóa chỉ đạt ${actualRR.toFixed(2)}`,
      confidence,
      riskNote
    );
  }

  riskNote = appendNote(
    riskNote,
    `SL/TP đã chuẩn hóa theo ATR ${entryInterval} và cấu trúc ${confirmInterval}`
  );

  if (entry2) {
    riskNote = appendNote(
      riskNote,
      `Entry2 lấy theo ${entry2Result.source}`
    );
  } else {
    riskNote = appendNote(
      riskNote,
      'Không có Entry2 đủ đẹp theo khung lớn'
    );
  }

  return {
    signal:
      direction,


confidence,

reason:
  reason ||
  `Các khung ${ multiSnapshot?.intervals?.join(', ') || entryInterval } đồng thuận`,

entry:
  roundedEntry,

entry1:
  roundedEntry,

entry2,

stopLoss,

takeProfit1,

takeProfit2,

riskNote


};
}

/**

* Schema bắt buộc OpenAI trả về.
  */
const SIGNAL_JSON_SCHEMA = {
  type: 'object',

  additionalProperties: false,

  properties: {
    signal: {
      type: 'string',
      enum: [
        'LONG',
        'SHORT',
        'WAIT'
      ]
    },


confidence: {
  type: 'number'
},

reason: {
  type: 'string'
},

entry: {
  type: [
    'number',
    'null'
  ]
},

entry1: {
  type: [
    'number',
    'null'
  ]
},

entry2: {
  type: [
    'number',
    'null'
  ]
},

stopLoss: {
  type: [
    'number',
    'null'
  ]
},

takeProfit1: {
  type: [
    'number',
    'null'
  ]
},

takeProfit2: {
  type: [
    'number',
    'null'
  ]
},

riskNote: {
  type: 'string'
}


},

  required: [
    'signal',
    'confidence',
    'reason',
    'entry',
    'entry1',
    'entry2',
    'stopLoss',
    'takeProfit1',
    'takeProfit2',
    'riskNote'
  ]
};

/**

* Kiểm tra lỗi Structured Outputs không được model/package hỗ trợ.
  */
function isStructuredOutputError(error) {
  const message = String(
    error?.response?.data?.error
      ?.message ||
    error?.response?.data?.message ||
    error?.message ||
    ''
  ).toLowerCase();

  return (
    message.includes('json_schema') ||
    message.includes('text.format') ||
    message.includes('structured output') ||
    message.includes('unsupported parameter')
  );
}

/**

* Gọi Responses API.
  */
async function requestSignal(
  client,
  prompt
) {
  const baseRequest = {
    model:
      CONFIG.openaiModel,

    instructions:
      'Bạn là hệ thống phân tích crypto futures đa khung. Chỉ trả về JSON đúng cấu trúc được yêu cầu. Không thêm markdown hoặc nội dung ngoài JSON.',

    input:
      prompt,

    max_output_tokens:
      850
  };

  try {
    return await client.responses.create({
      ...baseRequest,


  text: {
    format: {
      type:
        'json_schema',

      name:
        'multi_timeframe_trade_signal',

      strict:
        true,

      schema:
        SIGNAL_JSON_SCHEMA
    }
  }
});


} catch (error) {
    if (
      !isStructuredOutputError(error)
    ) {
      throw error;
    }

    
console.warn(
  'Structured Outputs không dùng được, chuyển sang JSON text mode.'
);

return client.responses.create(
  baseRequest
);


  }
}

/**

* Hàm phân tích AI chính.
  */
export async function askAI(snapshot) {
  const client =
    getOpenAIClient();

  const entryInterval =
    snapshot?.entryInterval ||
    CONFIG.entryInterval ||
    CONFIG.interval ||
    '15m';

  const confirmInterval =
    snapshot?.confirmInterval ||
    CONFIG.confirmInterval ||
    entryInterval;

  const trendInterval =
    snapshot?.trendInterval ||
    CONFIG.trendInterval ||
    confirmInterval;

  const entrySnapshot =
    getTimeframeSnapshot(
      snapshot,
      entryInterval,
      'entrySnapshot'
    );

  const confirmSnapshot =
    getTimeframeSnapshot(
      snapshot,
      confirmInterval,
      'confirmSnapshot'
    );

  const trendSnapshot =
    getTimeframeSnapshot(
      snapshot,
      trendInterval,
      'trendSnapshot'
    );

  const intervals = [
    ...new Set(
      (
        Array.isArray(snapshot?.intervals)
          ? snapshot.intervals
          : [
            entryInterval,
            confirmInterval,
            trendInterval
          ]
      ).filter(Boolean)
    )
  ];

  const market = {
    symbol:
      snapshot?.symbol ||
      CONFIG.symbol,


strategy: {
  entryInterval,
  confirmInterval,
  trendInterval,
  intervals
},

timeframes: {
  [entryInterval]:
    buildTimeframePayload(
      entrySnapshot,
      'Tìm điểm vào lệnh',
      60
    ),

  [confirmInterval]:
    buildTimeframePayload(
      confirmSnapshot,
      'Xác nhận động lượng, cấu trúc, hỗ trợ và kháng cự',
      50
    ),

  [trendInterval]:
    buildTimeframePayload(
      trendSnapshot,
      'Xác định xu hướng chính và vùng hỗ trợ/kháng cự lớn',
      40
    )
},

derivatives: {
  funding:
    snapshot?.funding ||
    entrySnapshot?.funding ||
    null,

  premium:
    snapshot?.premium ||
    entrySnapshot?.premium ||
    null,

  openInterest:
    snapshot?.oi ||
    entrySnapshot?.oi ||
    null,

  orderBook:
    snapshot?.book ||
    entrySnapshot?.book ||
    null
},

contract:
  snapshot?.contract ||
  entrySnapshot?.contract ||
  null,

riskConfiguration: {
  minConfidence:
    CONFIG.minConfidence,

  minRR:
    CONFIG.minRR,

  maxSpreadPct:
    CONFIG.maxSpreadPct,

  maxAbsFundingRate:
    CONFIG.maxAbsFundingRate,

  slAtrMult:
    CONFIG.slAtrMult,

  tp1AtrMult:
    CONFIG.tp1AtrMult,

  tp2AtrMult:
    CONFIG.tp2AtrMult,

  minSlPct:
    CONFIG.minSlPct,

  maxSlPct:
    CONFIG.maxSlPct,

  maxEntryDistancePct:
    CONFIG.maxEntryDistancePct,

  structureLookback:
    CONFIG.structureLookback,

  entry2AtrMult:
    CONFIG.entry2AtrMult ??
    process.env.ENTRY2_ATR_MULT ??
    0.6,

  entry2MaxDistancePct:
    CONFIG.entry2MaxDistancePct ??
    process.env.ENTRY2_MAX_DISTANCE_PCT ??
    0.6,

  entry2MinDistancePct:
    CONFIG.entry2MinDistancePct ??
    process.env.ENTRY2_MIN_DISTANCE_PCT ??
    0.15
}


};

const prompt = `
Phân tích dữ liệu crypto futures đa khung thời gian dưới đây.

VAI TRÒ CÁC KHUNG:

* Khung xu hướng ${trendInterval}: xác định hướng chính nhưng không phải điều kiện chặn cứng tuyệt đối.
* Khung xác nhận ${confirmInterval}: xác nhận động lượng, cấu trúc, hỗ trợ và kháng cự.
* Khung entry ${entryInterval}: tìm thời điểm vào lệnh.

QUY TẮC QUYẾT ĐỊNH:

1. Chỉ chọn đúng một tín hiệu: LONG, SHORT hoặc WAIT.

2. Không quyết định chỉ dựa trên khung ${entryInterval}, nhưng cũng không được đợi cả ba khung đồng thuận hoàn hảo mới vào lệnh.

3. LONG:

* Ưu tiên khi khung ${trendInterval} là BULL, SUPER_BULL hoặc NEUTRAL nhưng chưa phá cấu trúc tăng.
* Nếu khung ${trendInterval} là MIXED hoặc BEAR nhẹ nhưng ${confirmInterval} và ${entryInterval} có tín hiệu đảo chiều rõ, vẫn có thể LONG với confidence thấp hơn.
* Không LONG khi ${trendInterval} là SUPER_BEAR rõ ràng và chưa có dấu hiệu đảo chiều.
* Khung ${confirmInterval} nên ủng hộ tăng, giữ cấu trúc tăng, hoặc pullback chưa phá cấu trúc.
* Khung ${entryInterval} phải có điểm vào hợp lý.
* Với LONG: stopLoss < entry1, entry2 < entry1, entry2 > stopLoss, takeProfit1 > entry1, takeProfit2 > takeProfit1.

4. SHORT:

* Ưu tiên khi khung ${trendInterval} là BEAR, SUPER_BEAR hoặc NEUTRAL nhưng chưa phá cấu trúc giảm.
* Nếu khung ${trendInterval} là MIXED hoặc BULL nhẹ nhưng ${confirmInterval} và ${entryInterval} có tín hiệu đảo chiều rõ, vẫn có thể SHORT với confidence thấp hơn.
* Không SHORT khi ${trendInterval} là SUPER_BULL rõ ràng và chưa có dấu hiệu đảo chiều.
* Khung ${confirmInterval} nên ủng hộ giảm, giữ cấu trúc giảm, hoặc hồi lên nhưng chưa phá cấu trúc.
* Khung ${entryInterval} phải có điểm vào hợp lý.
* Với SHORT: stopLoss > entry1, entry2 > entry1, entry2 < stopLoss, takeProfit1 < entry1, takeProfit2 < takeProfit1.

5. Chọn WAIT khi:

* Khung xu hướng và khung xác nhận xung đột rất mạnh.
* Entry đã chạy quá xa so với vùng hợp lý.
* SL cần quá rộng so với MAX_SL_PCT.
* RR không đạt yêu cầu.
* Spread vượt ngưỡng cấu hình.
* Funding quá cực đoan và đi ngược hướng lệnh.
* Dữ liệu giá nến không đủ hoặc mâu thuẫn nghiêm trọng.

Không được WAIT chỉ vì một dữ liệu phụ như Funding, OI hoặc volume chưa rõ.
Funding, OI và volume chỉ dùng để giảm confidence, không phải lý do chặn lệnh tuyệt đối.
Không được WAIT chỉ vì khung ${trendInterval} đang MIXED hoặc NEUTRAL. Nếu ${confirmInterval} và ${entryInterval} có tín hiệu rõ, vẫn có thể LONG hoặc SHORT nhưng giảm confidence.

6. Không được bịa dữ liệu hoặc chỉ báo không có trong input.

7. Entry:

* Executor sử dụng MARKET order nên entry1 phải gần giá thị trường hiện tại.
* entry chính là entry1 để tương thích hệ thống.
* entry1 là điểm vào hiện tại.
* entry2 là điểm vào phụ tốt hơn theo khung lớn.
* LONG: entry2 nên nằm dưới entry1, ưu tiên gần hỗ trợ của ${confirmInterval} hoặc ${trendInterval}, nhưng phải nằm trên stopLoss.
* SHORT: entry2 nên nằm trên entry1, ưu tiên gần kháng cự của ${confirmInterval} hoặc ${trendInterval}, nhưng phải nằm dưới stopLoss.
* Nếu không xác định được entry2 thì để null, hệ thống sẽ tự tính theo hỗ trợ/kháng cự hoặc ATR.
* Không đưa entry quá xa rồi kỳ vọng giá hồi về.

8. Stop Loss:

* Không đặt sát râu nến khung ${entryInterval}.
* Ưu tiên nằm ngoài swing high/swing low của khung ${confirmInterval}.
* Khoảng SL tối thiểu phải xét ATR và phần trăm giá.
* Với LONG: stopLoss < entry1 và stopLoss < entry2 nếu có entry2.
* Với SHORT: stopLoss > entry1 và stopLoss > entry2 nếu có entry2.

9. Take Profit:

* TP1 tối thiểu phải đạt RR ${CONFIG.minRR}.
* TP1 ưu tiên vùng hỗ trợ/kháng cự của ${confirmInterval}.
* TP2 ưu tiên vùng hỗ trợ/kháng cự của ${trendInterval}.
* TP2 phải xa hơn TP1.
* LONG: TP2 > TP1 > entry1.
* SHORT: TP2 < TP1 < entry1.

10. Confidence:

* 0 đến 100.
* Confidence là độ tự tin của nhận định hiện tại.
* Với LONG hoặc SHORT:
  + 80-95: ba khung đồng thuận rõ, entry tốt, RR tốt.
  + 70-79: xu hướng chính rõ, khung xác nhận ủng hộ, entry chấp nhận được.
  + 60-69: có tín hiệu nhưng chưa thật mạnh.

  * Dưới 60: không nên vào lệnh.
* Với WAIT:
  + 40-60: thị trường có xu hướng nhưng entry chưa đẹp hoặc khung còn lệch nhẹ.
  + 20-39: thị trường nhiễu, thiếu đồng thuận.
  + 0-19: dữ liệu thiếu, mâu thuẫn mạnh hoặc không thể phân tích.
* Không được mặc định confidence = 0 chỉ vì chọn WAIT.
* Chỉ trả confidence = 0 khi dữ liệu không hợp lệ hoặc không đủ dữ liệu phân tích.
* Không tăng confidence chỉ vì một khung có RSI quá mua hoặc quá bán.

11. Reason phải ngắn gọn nhưng đề cập trạng thái của:

* ${trendInterval}
* ${confirmInterval}
* ${entryInterval}

12. Khi chọn WAIT:

* entry, entry1, entry2, stopLoss, takeProfit1 và takeProfit2 phải là null.

Chỉ trả JSON đúng cấu trúc:

{
"signal": "LONG|SHORT|WAIT",
"confidence": 0,
"reason": "ngắn gọn",
"entry": null,
"entry1": null,
"entry2": null,
"stopLoss": null,
"takeProfit1": null,
"takeProfit2": null,
"riskNote": "ngắn gọn"
}

DỮ LIỆU THỊ TRƯỜNG:
${JSON.stringify(market)}
`;

const response =
  await requestSignal(
    client,
    prompt
  );

if (
  response?.status === 'incomplete'
) {
  throw new Error(
    `OpenAI response incomplete: ${response?.incomplete_details
      ?.reason ||
    'Không rõ nguyên nhân'
    }`
  );
}

const outputText =
  extractOutputText(response);

const rawSignal =
  safeJson(outputText);

if (
  !rawSignal ||
  typeof rawSignal !== 'object'
) {
  throw new Error(
    'OpenAI không trả về object tín hiệu hợp lệ'
  );
}

const protectedSignal =
  protectSignalGeometry(
    rawSignal,
    snapshot
  );

console.log(
  'AI raw signal:',
  rawSignal
);

console.log(
  'AI protected signal:',
  protectedSignal
);

return protectedSignal;
}
