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
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /*
     * Trường hợp model vẫn bọc thêm nội dung
     * bên ngoài object JSON.
     */
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
      `Không parse được JSON từ OpenAI: ${cleaned}`
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
 * Chuyển timestamp giây hoặc mili giây
 * về mili giây.
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

      /*
       * Không có closeTime thì vẫn giữ lại,
       * tránh làm mất toàn bộ dữ liệu.
       */
      if (!closeTime) {
        return true;
      }

      return closeTime <= now;
    }
  );

  /*
   * Nếu API không cung cấp closeTime chuẩn,
   * quay lại dùng toàn bộ candles.
   */
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
 * Tạo dữ liệu một khung thời gian
 * để gửi sang AI.
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
 *
 * Ưu tiên:
 * 1. Giá giữa Bid/Ask
 * 2. Mark Price
 * 3. Giá đóng cửa gần nhất
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
 * Tìm swing low hoặc swing high gần nhất
 * trong khung xác nhận.
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

  /*
   * Tìm pivot gần nhất trước.
   */
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

  /*
   * Không tìm thấy pivot rõ thì dùng
   * biên cao/thấp của vùng gần nhất.
   */
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
 * Tạo kết quả WAIT chuẩn.
 */
function createWaitSignal(
  reason,
  confidence = 0,
  riskNote = ''
) {
  return {
    signal: 'WAIT',

    confidence:
      clamp(
        toNumber(confidence, 0),
        0,
        100
      ),

    reason:
      String(
        reason ||
        'Chưa đủ điều kiện vào lệnh'
      ),

    entry: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,

    riskNote:
      String(riskNote || '')
  };
}

/**
 * Chuẩn hóa và bảo vệ SL/TP.
 *
 * AI đưa ra ý tưởng giao dịch,
 * nhưng khoảng cách SL/TP cuối cùng
 * được kiểm soát lại bằng code.
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

  /*
   * Vì executor gửi MARKET order,
   * entry cuối cùng phải gần giá hiện tại.
   */
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
        `Entry AI lệch ${aiEntryDistancePct.toFixed(2)}%, đã dùng giá thị trường`
      );
    }
  }

  const entry =
    currentPrice;

  const slAtrMult =
    Math.max(
      0,
      Number(
        CONFIG.slAtrMult || 1.8
      )
    );

  const tp1AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp1AtrMult || 2.5
      )
    );

  const tp2AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp2AtrMult || 3.5
      )
    );

  const minSlPct =
    Math.max(
      0,
      Number(
        CONFIG.minSlPct || 0.6
      )
    );

  const maxSlPct =
    Math.max(
      0,
      Number(
        CONFIG.maxSlPct || 1.5
      )
    );

  const minRR =
    Math.max(
      1,
      Number(
        CONFIG.minRR || 1.5
      )
    );

  /*
   * Khoảng SL tối thiểu:
   * - Theo ATR
   * - Theo % giá
   *
   * Chọn khoảng lớn hơn.
   */
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

  /*
   * Khoảng SL AI đề xuất.
   */
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

  /*
   * Khoảng SL dựa theo swing của
   * khung xác nhận, có thêm ATR buffer.
   */
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

  /*
   * Không lấy SL ngắn hơn:
   * - Mức tối thiểu
   * - SL AI
   * - Cấu trúc khung xác nhận
   */
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

  /*
   * Setup cần SL quá rộng thì WAIT,
   * không tự ép SL lại gần.
   */
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

  /*
   * TP1 tối thiểu phải đáp ứng:
   * - MIN_RR
   * - TP1_ATR_MULT
   */
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

  /*
   * TP2 phải xa hơn TP1.
   */
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

  /*
   * Kiểm tra lần cuối sau khi làm tròn.
   */
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

  return {
    signal:
      direction,

    confidence,

    reason:
      reason ||
      `Các khung ${multiSnapshot?.intervals?.join(', ') || entryInterval} đồng thuận`,

    entry:
      roundedEntry,

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
    'stopLoss',
    'takeProfit1',
    'takeProfit2',
    'riskNote'
  ]
};

/**
 * Kiểm tra lỗi Structured Outputs
 * không được model/package hỗ trợ.
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
      700
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
    /*
     * Fallback cho package/model cũ.
     */
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
          'Xác nhận động lượng và cấu trúc',
          50
        ),

      [trendInterval]:
        buildTimeframePayload(
          trendSnapshot,
          'Xác định xu hướng chính',
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
        CONFIG.structureLookback
    }
  };

  const prompt = `
Phân tích dữ liệu crypto futures đa khung thời gian dưới đây.

VAI TRÒ CÁC KHUNG:
- Khung xu hướng ${trendInterval}: xác định hướng chính.
- Khung xác nhận ${confirmInterval}: xác nhận động lượng, cấu trúc, hỗ trợ và kháng cự.
- Khung entry ${entryInterval}: tìm thời điểm vào lệnh.

QUY TẮC QUYẾT ĐỊNH:

1. Chỉ chọn đúng một tín hiệu: LONG, SHORT hoặc WAIT.

2. Không quyết định chỉ dựa trên khung ${entryInterval}.

3. LONG:
- Khung ${trendInterval} không được là BEAR hoặc SUPER_BEAR.
- Khung ${confirmInterval} phải xác nhận tăng, giữ cấu trúc tăng hoặc pullback chưa phá cấu trúc.
- Khung ${entryInterval} phải có điểm vào hợp lý.

4. SHORT:
- Khung ${trendInterval} không được là BULL hoặc SUPER_BULL.
- Khung ${confirmInterval} phải xác nhận giảm, giữ cấu trúc giảm hoặc hồi lên nhưng chưa phá cấu trúc.
- Khung ${entryInterval} phải có điểm vào hợp lý.

5. Chọn WAIT khi:
- Khung xu hướng và khung xác nhận xung đột mạnh.
- Khung cao đang MIXED hoặc NEUTRAL nhưng chưa có cấu trúc rõ.
- Funding, OI, spread hoặc volume không rõ ràng.
- Entry đã chạy quá xa.
- SL cần quá rộng.
- RR không đạt yêu cầu.
- Dữ liệu không đủ hoặc mâu thuẫn.

6. Không được bịa dữ liệu hoặc chỉ báo không có trong input.

7. Entry:
- Phải gần giá thị trường hiện tại.
- Executor sử dụng MARKET order.
- Không đưa entry quá xa rồi kỳ vọng giá hồi về.

8. Stop Loss:
- Không đặt sát râu nến khung ${entryInterval}.
- Ưu tiên nằm ngoài swing high/swing low của khung ${confirmInterval}.
- Khoảng SL tối thiểu phải xét ATR và phần trăm giá.
- Với LONG: stopLoss < entry.
- Với SHORT: stopLoss > entry.

9. Take Profit:
- TP1 tối thiểu phải đạt RR ${CONFIG.minRR}.
- TP1 ưu tiên vùng hỗ trợ/kháng cự của ${confirmInterval}.
- TP2 ưu tiên vùng hỗ trợ/kháng cự của ${trendInterval}.
- TP2 phải xa hơn TP1.
- LONG: TP2 > TP1 > entry.
- SHORT: TP2 < TP1 < entry.

10. Confidence:
- 0 đến 100.
- Chỉ trên ${CONFIG.minConfidence} khi cả ba khung thực sự hỗ trợ tín hiệu.
- Không tăng confidence chỉ vì một khung có RSI quá mua hoặc quá bán.

11. Reason phải ngắn gọn nhưng đề cập trạng thái của:
- ${trendInterval}
- ${confirmInterval}
- ${entryInterval}

12. Khi chọn WAIT:
- entry, stopLoss, takeProfit1 và takeProfit2 phải là null.

Chỉ trả JSON đúng cấu trúc:

{
  "signal": "LONG|SHORT|WAIT",
  "confidence": 0,
  "reason": "ngắn gọn",
  "entry": null,
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
      `OpenAI response incomplete: ${
        response?.incomplete_details
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
