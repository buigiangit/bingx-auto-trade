import OpenAI from "openai";
import { CONFIG } from "./config.js";

let openaiClient = null;

function getOpenAIClient() {
  if (!CONFIG.openaiApiKey) {
    throw new Error("Thiếu OPENAI_API_KEY trong biến môi trường");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: CONFIG.openaiApiKey,
    });
  }

  return openaiClient;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundPrice(value, precision = 2) {
  const number = Number(value);
  const parsedPrecision = Number(precision);

  if (!Number.isFinite(number)) {
    return null;
  }

  const safePrecision = clamp(
    Number.isFinite(parsedPrecision) ? parsedPrecision : 2,
    0,
    12,
  );

  const multiplier = Math.pow(10, safePrecision);

  return Math.round(number * multiplier) / multiplier;
}

function safeJson(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    throw new Error("OpenAI không trả về nội dung");
  }

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(
        cleaned.slice(
          firstBrace,
          lastBrace + 1,
        ),
      );
    }

    throw new Error(
      `Không parse được JSON từ OpenAI: ${cleaned}`,
    );
  }
}

function extractOutputText(response) {
  if (
    typeof response?.output_text === "string" &&
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
      if (typeof content?.text === "string") {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

function normalizeTimestamp(value) {
  const time = Number(value);

  if (!Number.isFinite(time)) {
    return null;
  }

  return time < 1_000_000_000_000
    ? time * 1000
    : time;
}

function getClosedCandles(snapshot) {
  const candles = Array.isArray(
    snapshot?.candles,
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
          candle?.closeTime,
        );

      if (!closeTime) {
        return true;
      }

      return closeTime <= now;
    },
  );

  return closedCandles.length >= 20
    ? closedCandles
    : candles;
}

function compactCandles(
  snapshot,
  limit,
) {
  return getClosedCandles(snapshot)
    .slice(-limit)
    .map(candle => ({
      time:
        candle.openTime ??
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
        candle.closeTime,
    }));
}

function getTimeframeSnapshot(
  snapshot,
  interval,
  fallbackKey,
) {
  return (
    snapshot?.timeframes?.[interval] ||
    snapshot?.[fallbackKey] ||
    snapshot
  );
}

function buildTimeframePayload(
  snapshot,
  role,
  candleLimit,
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
        candleLimit,
      ),

    indicators:
      snapshot?.indicators || {},
  };
}

function getCurrentPrice(
  multiSnapshot,
  entrySnapshot,
) {
  const bidPrice = toNumber(
    multiSnapshot?.book?.bidPrice ??
    entrySnapshot?.book?.bidPrice,
  );

  const askPrice = toNumber(
    multiSnapshot?.book?.askPrice ??
    entrySnapshot?.book?.askPrice,
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
    entrySnapshot?.premium?.markPrice,
  );

  if (markPrice > 0) {
    return markPrice;
  }

  const candles =
    getClosedCandles(
      entrySnapshot,
    );

  const candleClose = toNumber(
    candles.at(-1)?.close,
  );

  if (candleClose > 0) {
    return candleClose;
  }

  return toNumber(
    entrySnapshot?.indicators
      ?.lastClose,
  );
}

function getAtr(snapshot) {
  return toNumber(
    snapshot?.indicators?.atr14 ??
    snapshot?.indicators?.atr ??
    snapshot?.indicators?.ATR,
  );
}

function findRecentSwing(
  snapshot,
  direction,
  entry,
) {
  const lookback = clamp(
    Number(
      CONFIG.structureLookback ||
      20,
    ),
    5,
    50,
  );

  const candles =
    getClosedCandles(snapshot)
      .slice(-lookback);

  if (candles.length < 3) {
    return null;
  }

  for (
    let index =
      candles.length - 2;
    index >= 1;
    index -= 1
  ) {
    const previous =
      candles[index - 1];

    const current =
      candles[index];

    const next =
      candles[index + 1];

    if (direction === "LONG") {
      const low =
        toNumber(current?.low);

      if (
        low > 0 &&
        low < entry &&
        low <= toNumber(
          previous?.low,
          Infinity,
        ) &&
        low <= toNumber(
          next?.low,
          Infinity,
        )
      ) {
        return low;
      }
    }

    if (direction === "SHORT") {
      const high =
        toNumber(current?.high);

      if (
        high > entry &&
        high >= toNumber(
          previous?.high,
          -Infinity,
        ) &&
        high >= toNumber(
          next?.high,
          -Infinity,
        )
      ) {
        return high;
      }
    }
  }

  if (direction === "LONG") {
    const lows = candles
      .map(candle =>
        toNumber(candle?.low),
      )
      .filter(
        low =>
          Number.isFinite(low) &&
          low > 0 &&
          low < entry,
      );

    return lows.length > 0
      ? Math.min(...lows)
      : null;
  }

  const highs = candles
    .map(candle =>
      toNumber(candle?.high),
    )
    .filter(
      high =>
        Number.isFinite(high) &&
        high > entry,
    );

  return highs.length > 0
    ? Math.max(...highs)
    : null;
}

function extractLevelNumbers(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return [];
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? [value]
      : [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap(item =>
        extractLevelNumbers(item),
      )
      .filter(Number.isFinite);
  }

  if (typeof value === "object") {
    return Object.values(value)
      .flatMap(item =>
        extractLevelNumbers(item),
      )
      .filter(Number.isFinite);
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? [number]
    : [];
}

function getRecentHighLowLevels(
  snapshot,
) {
  const lookback = Math.max(
    10,
    Number(
      CONFIG.structureLookback ||
      20,
    ),
  );

  const candles =
    getClosedCandles(snapshot)
      .slice(-lookback);

  if (candles.length === 0) {
    return {
      highs: [],
      lows: [],
    };
  }

  return {
    highs:
      candles
        .map(candle =>
          toNumber(candle.high),
        )
        .filter(
          value =>
            Number.isFinite(value) &&
            value > 0,
        ),

    lows:
      candles
        .map(candle =>
          toNumber(candle.low),
        )
        .filter(
          value =>
            Number.isFinite(value) &&
            value > 0,
        ),
  };
}

function getSupportResistanceLevels(
  snapshot,
) {
  const indicators =
    snapshot?.indicators || {};

  const candleLevels =
    getRecentHighLowLevels(
      snapshot,
    );

  const supports = [
    ...extractLevelNumbers(
      indicators.support,
    ),

    ...extractLevelNumbers(
      indicators.supports,
    ),

    ...extractLevelNumbers(
      indicators.swingLow,
    ),

    ...extractLevelNumbers(
      indicators.swingLows,
    ),

    ...extractLevelNumbers(
      indicators.lowLiquidityZone,
    ),

    ...candleLevels.lows,
  ];

  const resistances = [
    ...extractLevelNumbers(
      indicators.resistance,
    ),

    ...extractLevelNumbers(
      indicators.resistances,
    ),

    ...extractLevelNumbers(
      indicators.swingHigh,
    ),

    ...extractLevelNumbers(
      indicators.swingHighs,
    ),

    ...extractLevelNumbers(
      indicators.highLiquidityZone,
    ),

    ...candleLevels.highs,
  ];

  return {
    supports: [
      ...new Set(
        supports.filter(
          Number.isFinite,
        ),
      ),
    ],

    resistances: [
      ...new Set(
        resistances.filter(
          Number.isFinite,
        ),
      ),
    ],
  };
}

function isValidEntry2({
  direction,
  entry1,
  entry2,
  stopLoss,
  minDistance,
  maxDistance,
}) {
  if (
    !Number.isFinite(entry2) ||
    entry2 <= 0
  ) {
    return false;
  }

  if (direction === "LONG") {
    const distance =
      entry1 - entry2;

    return (
      entry2 < entry1 &&
      entry2 > stopLoss &&
      distance >= minDistance &&
      distance <= maxDistance
    );
  }

  if (direction === "SHORT") {
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

function buildFallbackEntry2({
  direction,
  entry1,
  stopLoss,
  atr,
  minDistance,
  maxDistance,
  pricePrecision,
}) {
  const tickSize =
    Math.pow(
      10,
      -Math.max(
        0,
        Number(pricePrecision) ||
        0,
      ),
    );

  if (
    maxDistance < minDistance ||
    maxDistance < tickSize
  ) {
    return null;
  }

  const atrMultiplier =
    Math.max(
      0.1,
      Number(
        CONFIG.entry2AtrMult ??
        0.6,
      ),
    );

  const preferredDistance =
    clamp(
      Math.max(
        atr * atrMultiplier,
        minDistance,
        tickSize,
      ),
      minDistance,
      maxDistance,
    );

  const distances = [
    preferredDistance,
    (
      minDistance +
      maxDistance
    ) / 2,
    minDistance,
    maxDistance,
  ];

  for (
    const distance of distances
  ) {
    const rawEntry2 =
      direction === "LONG"
        ? entry1 - distance
        : entry1 + distance;

    const roundedEntry2 =
      roundPrice(
        rawEntry2,
        pricePrecision,
      );

    if (
      isValidEntry2({
        direction,
        entry1,
        entry2:
          roundedEntry2,
        stopLoss,
        minDistance,
        maxDistance,
      })
    ) {
      return roundedEntry2;
    }
  }

  return null;
}

function pickEntry2FromHigherTimeframes({
  rawSignal,
  direction,
  entry1,
  stopLoss,
  atr,
  pricePrecision,
  confirmSnapshot,
  trendSnapshot,
}) {
  const stopDistance =
    Math.abs(
      entry1 - stopLoss,
    );

  if (
    !Number.isFinite(
      stopDistance,
    ) ||
    stopDistance <= 0
  ) {
    return {
      entry2: null,
      source:
        "NO_STOP_DISTANCE",
    };
  }

  const minDistancePct =
    Math.max(
      0,
      Number(
        CONFIG
          .entry2MinDistancePct ??
        0.15,
      ),
    );

  const maxDistancePct =
    Math.max(
      minDistancePct,
      Number(
        CONFIG
          .entry2MaxDistancePct ??
        0.6,
      ),
    );

  const maxStopRatio =
    clamp(
      Number(
        CONFIG.entry2MaxStopRatio ??
        0.65,
      ),
      0.1,
      0.9,
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
    stopDistance *
    maxStopRatio;

  const maxDistance =
    Math.min(
      maxDistanceByPct,
      maxDistanceByStop,
    );

  if (
    maxDistance <= 0 ||
    minDistance > maxDistance
  ) {
    return {
      entry2: null,

      source:
        "ENTRY2_DISTANCE_CONFIG_INVALID",
    };
  }

  const confirmLevels =
    getSupportResistanceLevels(
      confirmSnapshot,
    );

  const trendLevels =
    getSupportResistanceLevels(
      trendSnapshot,
    );

  let candidateLevels = [];

  if (direction === "LONG") {
    candidateLevels = [
      ...confirmLevels.supports.map(
        level => ({
          level,
          source:
            "support_confirm",
        }),
      ),

      ...trendLevels.supports.map(
        level => ({
          level,
          source:
            "support_trend",
        }),
      ),
    ];
  }

  if (direction === "SHORT") {
    candidateLevels = [
      ...confirmLevels
        .resistances
        .map(
          level => ({
            level,
            source:
              "resistance_confirm",
          }),
        ),

      ...trendLevels
        .resistances
        .map(
          level => ({
            level,
            source:
              "resistance_trend",
          }),
        ),
    ];
  }

  candidateLevels =
    candidateLevels
      .map(item => ({
        ...item,

        level:
          roundPrice(
            item.level,
            pricePrecision,
          ),
      }))
      .filter(item =>
        isValidEntry2({
          direction,
          entry1,

          entry2:
            item.level,

          stopLoss,
          minDistance,
          maxDistance,
        }),
      )
      .sort(
        (a, b) =>
          Math.abs(
            entry1 - a.level,
          ) -
          Math.abs(
            entry1 - b.level,
          ),
      );

  const pickedLevel =
    candidateLevels[0];

  if (pickedLevel) {
    return {
      entry2:
        pickedLevel.level,

      source:
        pickedLevel.source,
    };
  }

  const rawEntry2 =
    roundPrice(
      toNumber(
        rawSignal?.entry2,
      ),
      pricePrecision,
    );

  if (
    isValidEntry2({
      direction,
      entry1,

      entry2:
        rawEntry2,

      stopLoss,
      minDistance,
      maxDistance,
    })
  ) {
    return {
      entry2:
        rawEntry2,

      source:
        "ai_entry2",
    };
  }

  const fallbackEntry2 =
    buildFallbackEntry2({
      direction,
      entry1,
      stopLoss,
      atr,
      minDistance,
      maxDistance,
      pricePrecision,
    });

  if (fallbackEntry2) {
    return {
      entry2:
        fallbackEntry2,

      source:
        "atr_fallback",
    };
  }

  return {
    entry2: null,

    source:
      "NO_VALID_ENTRY2",
  };
}

function appendNote(
  currentNote,
  newNote,
) {
  return [
    String(
      currentNote || "",
    ).trim(),

    String(
      newNote || "",
    ).trim(),
  ]
    .filter(Boolean)
    .join(" | ");
}

function normalizeWaitConfidence(
  confidence,
  reason,
  riskNote,
) {
  const original = clamp(
    toNumber(
      confidence,
      0,
    ),
    0,
    100,
  );

  if (original > 0) {
    return original;
  }

  const text =
    `${reason || ""} ` +
    `${riskNote || ""}`;

  const normalizedText =
    text.toLowerCase();

  const hardInvalid =
    normalizedText.includes(
      "không có atr",
    ) ||
    normalizedText.includes(
      "không xác định được giá",
    ) ||
    normalizedText.includes(
      "không lấy được",
    ) ||
    normalizedText.includes(
      "dữ liệu không đủ",
    ) ||
    normalizedText.includes(
      "không hợp lệ",
    ) ||
    normalizedText.includes(
      "parse",
    ) ||
    normalizedText.includes(
      "mâu thuẫn nghiêm trọng",
    );

  return hardInvalid
    ? 0
    : 35;
}

function createWaitSignal(
  reason,
  confidence = 0,
  riskNote = "",
) {
  return {
    signal:
      "WAIT",

    confidence:
      normalizeWaitConfidence(
        confidence,
        reason,
        riskNote,
      ),

    reason:
      String(
        reason ||
        "Chưa đủ điều kiện vào lệnh",
      ),

    entry: null,
    entry1: null,
    entry2: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,

    riskNote:
      String(
        riskNote || "",
      ),
  };
}

function protectSignalGeometry(
  rawSignal,
  multiSnapshot,
) {
  const direction = String(
    rawSignal?.signal ||
    "WAIT",
  )
    .trim()
    .toUpperCase();

  const confidence = clamp(
    toNumber(
      rawSignal?.confidence,
      0,
    ),
    0,
    100,
  );

  const reason = String(
    rawSignal?.reason || "",
  ).trim();

  let riskNote = String(
    rawSignal?.riskNote || "",
  ).trim();

  if (
    ![
      "LONG",
      "SHORT",
      "WAIT",
    ].includes(direction)
  ) {
    return createWaitSignal(
      `Signal AI không hợp lệ: ${direction}`,
      confidence,
      riskNote,
    );
  }

  if (direction === "WAIT") {
    return createWaitSignal(
      reason ||
      "Các khung thời gian chưa đồng thuận",
      confidence,
      riskNote,
    );
  }

  const entryInterval =
    multiSnapshot
      ?.entryInterval ||
    CONFIG.entryInterval ||
    CONFIG.interval;

  const confirmInterval =
    multiSnapshot
      ?.confirmInterval ||
    CONFIG.confirmInterval ||
    entryInterval;

  const trendInterval =
    multiSnapshot
      ?.trendInterval ||
    CONFIG.trendInterval ||
    confirmInterval;

  const entrySnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      entryInterval,
      "entrySnapshot",
    );

  const confirmSnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      confirmInterval,
      "confirmSnapshot",
    );

  const trendSnapshot =
    getTimeframeSnapshot(
      multiSnapshot,
      trendInterval,
      "trendSnapshot",
    );

  const currentPrice =
    getCurrentPrice(
      multiSnapshot,
      entrySnapshot,
    );

  const atr =
    getAtr(
      entrySnapshot,
    );

  if (
    !Number.isFinite(
      currentPrice,
    ) ||
    currentPrice <= 0
  ) {
    return createWaitSignal(
      "Không xác định được giá thị trường hiện tại",
      confidence,
      riskNote,
    );
  }

  if (
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return createWaitSignal(
      `Không có ATR hợp lệ trên khung ${entryInterval}`,
      confidence,
      riskNote,
    );
  }

  const aiEntry =
    toNumber(
      rawSignal?.entry1 ??
      rawSignal?.entry,
    );

  const maxEntryDistancePct =
    Math.max(
      0,
      Number(
        CONFIG
          .maxEntryDistancePct ??
        0.25,
      ),
    );

  if (
    aiEntry > 0 &&
    maxEntryDistancePct > 0
  ) {
    const aiEntryDistancePct =
      (
        Math.abs(
          aiEntry -
          currentPrice,
        ) /
        currentPrice
      ) * 100;

    if (
      aiEntryDistancePct >
      maxEntryDistancePct
    ) {
      riskNote = appendNote(
        riskNote,

        `Entry AI lệch ` +
        `${aiEntryDistancePct.toFixed(2)}%, ` +
        `đã dùng giá thị trường`,
      );
    }
  }

  const pricePrecision =
    Number(
      multiSnapshot
        ?.contract
        ?.pricePrecision ??
      entrySnapshot
        ?.contract
        ?.pricePrecision ??
      2,
    );

  const entry1 =
    roundPrice(
      currentPrice,
      pricePrecision,
    );

  if (
    !entry1 ||
    entry1 <= 0
  ) {
    return createWaitSignal(
      "Không làm tròn được Entry 1 hợp lệ",
      confidence,
      riskNote,
    );
  }

  const slAtrMult =
    Math.max(
      0,
      Number(
        CONFIG.slAtrMult ||
        1.8,
      ),
    );

  const tp1AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp1AtrMult ||
        2.5,
      ),
    );

  const tp2AtrMult =
    Math.max(
      0,
      Number(
        CONFIG.tp2AtrMult ||
        3.5,
      ),
    );

  const minSlPct =
    Math.max(
      0,
      Number(
        CONFIG.minSlPct ||
        0.6,
      ),
    );

  const maxSlPct =
    Math.max(
      minSlPct,
      Number(
        CONFIG.maxSlPct ||
        1.5,
      ),
    );

  const minRR =
    Math.max(
      1,
      Number(
        CONFIG.minRR ||
        1.2,
      ),
    );

  const atrStopDistance =
    atr *
    slAtrMult;

  const percentStopDistance =
    entry1 * (
      minSlPct / 100
    );

  const minimumStopDistance =
    Math.max(
      atrStopDistance,
      percentStopDistance,
    );

  const maximumStopDistance =
    entry1 * (
      maxSlPct / 100
    );

  if (
    minimumStopDistance >
    maximumStopDistance
  ) {
    return createWaitSignal(
      "Cấu hình MIN_SL_PCT, MAX_SL_PCT hoặc SL_ATR_MULT đang xung đột",
      confidence,
      riskNote,
    );
  }

  const aiStopLoss =
    toNumber(
      rawSignal?.stopLoss,
    );

  let aiStopDistance = 0;

  if (
    direction === "LONG" &&
    aiStopLoss > 0 &&
    aiStopLoss < entry1
  ) {
    aiStopDistance =
      entry1 - aiStopLoss;
  }

  if (
    direction === "SHORT" &&
    aiStopLoss > entry1
  ) {
    aiStopDistance =
      aiStopLoss - entry1;
  }

  const swingPrice =
    findRecentSwing(
      confirmSnapshot,
      direction,
      entry1,
    );

  const structureBuffer =
    atr * 0.15;

  let structureStopDistance = 0;

  if (
    direction === "LONG" &&
    swingPrice > 0 &&
    swingPrice < entry1
  ) {
    structureStopDistance =
      entry1 -
      (
        swingPrice -
        structureBuffer
      );
  }

  if (
    direction === "SHORT" &&
    swingPrice > entry1
  ) {
    structureStopDistance =
      (
        swingPrice +
        structureBuffer
      ) -
      entry1;
  }

  const stopDistance =
    Math.max(
      minimumStopDistance,
      aiStopDistance,
      structureStopDistance,
    );

  const stopDistancePct =
    (
      stopDistance /
      entry1
    ) * 100;

  if (
    stopDistance >
    maximumStopDistance
  ) {
    return createWaitSignal(
      `SL cần rộng ` +
      `${stopDistancePct.toFixed(2)}%, ` +
      `vượt MAX_SL_PCT=${maxSlPct}%`,

      confidence,

      appendNote(
        riskNote,
        "Cấu trúc hiện tại chưa phù hợp để vào MARKET",
      ),
    );
  }

  const minimumTp1Distance =
    Math.max(
      stopDistance * minRR,
      atr * tp1AtrMult,
    );

  const aiTakeProfit1 =
    toNumber(
      rawSignal?.takeProfit1,
    );

  let aiTp1Distance = 0;

  if (
    direction === "LONG" &&
    aiTakeProfit1 > entry1
  ) {
    aiTp1Distance =
      aiTakeProfit1 - entry1;
  }

  if (
    direction === "SHORT" &&
    aiTakeProfit1 > 0 &&
    aiTakeProfit1 < entry1
  ) {
    aiTp1Distance =
      entry1 - aiTakeProfit1;
  }

  const tp1Distance =
    Math.max(
      minimumTp1Distance,
      aiTp1Distance,
    );

  const minimumTp2Distance =
    Math.max(
      atr * tp2AtrMult,
      tp1Distance * 1.35,
    );

  const aiTakeProfit2 =
    toNumber(
      rawSignal?.takeProfit2,
    );

  let aiTp2Distance = 0;

  if (
    direction === "LONG" &&
    aiTakeProfit2 > entry1
  ) {
    aiTp2Distance =
      aiTakeProfit2 - entry1;
  }

  if (
    direction === "SHORT" &&
    aiTakeProfit2 > 0 &&
    aiTakeProfit2 < entry1
  ) {
    aiTp2Distance =
      entry1 - aiTakeProfit2;
  }

  const tp2Distance =
    Math.max(
      minimumTp2Distance,
      aiTp2Distance,
    );

  let stopLoss;
  let takeProfit1;
  let takeProfit2;

  if (direction === "LONG") {
    stopLoss =
      roundPrice(
        entry1 -
        stopDistance,

        pricePrecision,
      );

    takeProfit1 =
      roundPrice(
        entry1 +
        tp1Distance,

        pricePrecision,
      );

    takeProfit2 =
      roundPrice(
        entry1 +
        tp2Distance,

        pricePrecision,
      );
  } else {
    stopLoss =
      roundPrice(
        entry1 +
        stopDistance,

        pricePrecision,
      );

    takeProfit1 =
      roundPrice(
        entry1 -
        tp1Distance,

        pricePrecision,
      );

    takeProfit2 =
      roundPrice(
        entry1 -
        tp2Distance,

        pricePrecision,
      );
  }

  if (
    !stopLoss ||
    !takeProfit1 ||
    !takeProfit2
  ) {
    return createWaitSignal(
      "Không tính được SL hoặc TP hợp lệ",
      confidence,
      riskNote,
    );
  }

  const entry2Result =
    pickEntry2FromHigherTimeframes({
      rawSignal,
      direction,
      entry1,
      stopLoss,
      atr,
      pricePrecision,
      confirmSnapshot,
      trendSnapshot,
    });

  const entry2 =
    entry2Result.entry2;

  if (!entry2) {
    return createWaitSignal(
      "Không tạo được Entry 2 hợp lệ giữa Entry 1 và Stop Loss",
      confidence,

      appendNote(
        riskNote,
        `Nguồn Entry2: ${entry2Result.source}`,
      ),
    );
  }

  if (
    direction === "LONG" &&
    !(
      stopLoss < entry2 &&
      entry2 < entry1 &&
      entry1 < takeProfit1 &&
      takeProfit1 < takeProfit2
    )
  ) {
    return createWaitSignal(
      "Cấu trúc LONG không hợp lệ sau khi làm tròn",
      confidence,
      riskNote,
    );
  }

  if (
    direction === "SHORT" &&
    !(
      takeProfit2 < takeProfit1 &&
      takeProfit1 < entry1 &&
      entry1 < entry2 &&
      entry2 < stopLoss
    )
  ) {
    return createWaitSignal(
      "Cấu trúc SHORT không hợp lệ sau khi làm tròn",
      confidence,
      riskNote,
    );
  }

  const actualRisk =
    Math.abs(
      entry1 -
      stopLoss,
    );

  const actualReward =
    Math.abs(
      takeProfit1 -
      entry1,
    );

  const actualRR =
    actualRisk > 0
      ? actualReward /
        actualRisk
      : 0;

  if (actualRR < minRR) {
    return createWaitSignal(
      `RR sau khi chuẩn hóa chỉ đạt ${actualRR.toFixed(2)}`,
      confidence,
      riskNote,
    );
  }

  riskNote = appendNote(
    riskNote,

    `SL/TP đã chuẩn hóa theo ATR ` +
    `${entryInterval} và cấu trúc ` +
    `${confirmInterval}`,
  );

  riskNote = appendNote(
    riskNote,

    `Entry2 lấy theo ` +
    `${entry2Result.source}`,
  );

  return {
    signal:
      direction,

    confidence,

    reason:
      reason ||
      `Các khung ${
        multiSnapshot?.intervals
          ?.join(", ") ||
        entryInterval
      } đồng thuận`,

    entry:
      entry1,

    entry1,
    entry2,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskNote,
  };
}

const SIGNAL_JSON_SCHEMA = {
  type:
    "object",

  additionalProperties:
    false,

  properties: {
    signal: {
      type:
        "string",

      enum: [
        "LONG",
        "SHORT",
        "WAIT",
      ],
    },

    confidence: {
      type:
        "number",
    },

    reason: {
      type:
        "string",
    },

    entry: {
      type: [
        "number",
        "null",
      ],
    },

    entry1: {
      type: [
        "number",
        "null",
      ],
    },

    entry2: {
      type: [
        "number",
        "null",
      ],
    },

    stopLoss: {
      type: [
        "number",
        "null",
      ],
    },

    takeProfit1: {
      type: [
        "number",
        "null",
      ],
    },

    takeProfit2: {
      type: [
        "number",
        "null",
      ],
    },

    riskNote: {
      type:
        "string",
    },
  },

  required: [
    "signal",
    "confidence",
    "reason",
    "entry",
    "entry1",
    "entry2",
    "stopLoss",
    "takeProfit1",
    "takeProfit2",
    "riskNote",
  ],
};

function isStructuredOutputError(
  error,
) {
  const message = String(
    error?.response?.data
      ?.error?.message ||
    error?.response?.data
      ?.message ||
    error?.message ||
    "",
  ).toLowerCase();

  return (
    message.includes(
      "json_schema",
    ) ||
    message.includes(
      "text.format",
    ) ||
    message.includes(
      "structured output",
    ) ||
    message.includes(
      "unsupported parameter",
    )
  );
}

async function requestSignal(
  client,
  prompt,
) {
  const baseRequest = {
    model:
      CONFIG.openaiModel,

    instructions:
      "Bạn là hệ thống phân tích crypto futures đa khung. Chỉ trả về JSON đúng cấu trúc yêu cầu, không thêm markdown hoặc nội dung ngoài JSON.",

    input:
      prompt,

    max_output_tokens:
      850,

    store:
      false,
  };

  try {
    return await client
      .responses
      .create({
        ...baseRequest,

        text: {
          format: {
            type:
              "json_schema",

            name:
              "multi_timeframe_trade_signal",

            strict:
              true,

            schema:
              SIGNAL_JSON_SCHEMA,
          },
        },
      });
  } catch (error) {
    if (
      !isStructuredOutputError(
        error,
      )
    ) {
      throw error;
    }

    console.warn(
      "Structured Outputs không dùng được, chuyển sang JSON text mode.",
    );

    return client
      .responses
      .create(
        baseRequest,
      );
  }
}

export async function askAI(
  snapshot,
) {
  const client =
    getOpenAIClient();

  const entryInterval =
    snapshot?.entryInterval ||
    CONFIG.entryInterval ||
    CONFIG.interval ||
    "15m";

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
      "entrySnapshot",
    );

  const confirmSnapshot =
    getTimeframeSnapshot(
      snapshot,
      confirmInterval,
      "confirmSnapshot",
    );

  const trendSnapshot =
    getTimeframeSnapshot(
      snapshot,
      trendInterval,
      "trendSnapshot",
    );

  const intervals = [
    ...new Set(
      (
        Array.isArray(
          snapshot?.intervals,
        )
          ? snapshot.intervals
          : [
              entryInterval,
              confirmInterval,
              trendInterval,
            ]
      ).filter(Boolean),
    ),
  ];

  const market = {
    symbol:
      snapshot?.symbol ||
      CONFIG.symbol,

    strategy: {
      entryInterval,
      confirmInterval,
      trendInterval,
      intervals,
    },

    timeframes: {
      [entryInterval]:
        buildTimeframePayload(
          entrySnapshot,
          "Tìm điểm vào lệnh",
          60,
        ),

      [confirmInterval]:
        buildTimeframePayload(
          confirmSnapshot,
          "Xác nhận động lượng, cấu trúc, hỗ trợ và kháng cự",
          50,
        ),

      [trendInterval]:
        buildTimeframePayload(
          trendSnapshot,
          "Xác định xu hướng chính và vùng hỗ trợ/kháng cự lớn",
          40,
        ),
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
        null,
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
        CONFIG.entry2AtrMult,

      entry2MaxDistancePct:
        CONFIG.entry2MaxDistancePct,

      entry2MinDistancePct:
        CONFIG.entry2MinDistancePct,

      entry2MaxStopRatio:
        CONFIG.entry2MaxStopRatio,
    },
  };

  const prompt = `
Phân tích dữ liệu crypto futures đa khung thời gian dưới đây.

VAI TRÒ CÁC KHUNG:
- Khung xu hướng ${trendInterval}: xác định hướng chính nhưng không chặn cứng tuyệt đối.
- Khung xác nhận ${confirmInterval}: xác nhận động lượng, cấu trúc, hỗ trợ và kháng cự.
- Khung Entry ${entryInterval}: tìm thời điểm vào lệnh.

QUY TẮC:
1. Chỉ chọn đúng một tín hiệu: LONG, SHORT hoặc WAIT.
2. Không quyết định chỉ dựa trên ${entryInterval}; cũng không cần chờ cả ba khung đồng thuận hoàn hảo.
3. LONG ưu tiên khi xu hướng lớn tăng hoặc trung tính nhưng chưa phá cấu trúc tăng. Không LONG khi ${trendInterval} SUPER_BEAR rõ và chưa có đảo chiều.
4. SHORT ưu tiên khi xu hướng lớn giảm hoặc trung tính nhưng chưa phá cấu trúc giảm. Không SHORT khi ${trendInterval} SUPER_BULL rõ và chưa có đảo chiều.
5. WAIT khi khung lớn xung đột mạnh, Entry đã chạy xa, SL vượt MAX_SL_PCT, RR không đạt, dữ liệu không đủ hoặc mâu thuẫn nghiêm trọng.
6. Không bịa dữ liệu hoặc chỉ báo không có trong input.
7. Executor dùng MARKET order nên entry1 phải gần giá hiện tại; entry phải bằng entry1.
8. Entry2 là vùng vào phụ tốt hơn:
   - LONG: stopLoss < entry2 < entry1.
   - SHORT: entry1 < entry2 < stopLoss.
   - Ưu tiên hỗ trợ/kháng cự của ${confirmInterval} hoặc ${trendInterval}.
9. Stop Loss ưu tiên nằm ngoài swing của ${confirmInterval}, không đặt sát râu nến ${entryInterval}.
10. TP1 tối thiểu đạt RR ${CONFIG.minRR}; TP2 phải xa hơn TP1.
11. Cấu trúc bắt buộc:
   - LONG: stopLoss < entry2 < entry1 < takeProfit1 < takeProfit2.
   - SHORT: takeProfit2 < takeProfit1 < entry1 < entry2 < stopLoss.
12. Confidence từ 0 đến 100. LONG/SHORT dưới 60 không nên vào. WAIT không mặc định bằng 0 nếu dữ liệu vẫn phân tích được.
13. Funding, OI và volume chỉ là dữ liệu hỗ trợ để điều chỉnh confidence; lớp risk của hệ thống sẽ kiểm tra ngưỡng cứng riêng.
14. Reason phải ngắn gọn và đề cập trạng thái ${trendInterval}, ${confirmInterval}, ${entryInterval}.
15. Khi WAIT: entry, entry1, entry2, stopLoss, takeProfit1, takeProfit2 đều phải là null.

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
      prompt,
    );

  if (
    response?.status ===
    "incomplete"
  ) {
    throw new Error(
      `OpenAI response incomplete: ${
        response
          ?.incomplete_details
          ?.reason ||
        "Không rõ nguyên nhân"
      }`,
    );
  }

  const outputText =
    extractOutputText(
      response,
    );

  const rawSignal =
    safeJson(
      outputText,
    );

  if (
    !rawSignal ||
    typeof rawSignal !==
      "object" ||
    Array.isArray(rawSignal)
  ) {
    throw new Error(
      "OpenAI không trả về object tín hiệu hợp lệ",
    );
  }

  const protectedSignal =
    protectSignalGeometry(
      rawSignal,
      snapshot,
    );

  console.log(
    "AI raw signal:",
    rawSignal,
  );

  console.log(
    "AI protected signal:",
    protectedSignal,
  );

  return protectedSignal;
}
