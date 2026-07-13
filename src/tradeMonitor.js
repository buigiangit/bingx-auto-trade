import { CONFIG } from './config.js';

import {
  getKlines
} from './market.js';

import {
  sendTradeEventToTelegram
} from './telegram.js';

import {
  isTradeRepositoryEnabled,
  getActiveTrades,
  markTradeEntry2Hit,
  markTradeTp1,
  markTradeTp2,
  markTradeStopLoss,
  markTradeExpired,
  updateTradeMonitoringState
} from './tradeRepository.js';

let monitorTimer = null;
let monitorRunning = false;

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
 * Chuyển thời gian sang mili giây.
 */
function normalizeTimestamp(value) {
  if (
    value instanceof Date
  ) {
    return value.getTime();
  }

  const numeric =
    Number(value);

  if (Number.isFinite(numeric)) {
    return numeric <
      1_000_000_000_000
      ? numeric * 1000
      : numeric;
  }

  const parsed =
    new Date(value).getTime();

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

/**
 * Chuyển interval thành mili giây.
 */
function intervalToMilliseconds(
  interval
) {
  const normalized =
    String(interval || '1m')
      .trim()
      .toLowerCase();

  const match =
    normalized.match(
      /^(\d+)(m|h|d|w)$/
    );

  if (!match) {
    return 60 * 1000;
  }

  const amount =
    Number(match[1]);

  const unit =
    match[2];

  const unitMilliseconds = {
    m:
      60 * 1000,

    h:
      60 * 60 * 1000,

    d:
      24 * 60 * 60 * 1000,

    w:
      7 * 24 * 60 * 60 * 1000
  };

  return (
    amount *
    unitMilliseconds[unit]
  );
}

/**
 * Chuẩn hóa một cây nến.
 */
function normalizeCandle(
  candle,
  intervalMilliseconds
) {
  const openTime =
    normalizeTimestamp(
      candle?.openTime ??
      candle?.time ??
      candle?.timestamp
    );

  const explicitCloseTime =
    normalizeTimestamp(
      candle?.closeTime
    );

  const closeTime =
    explicitCloseTime ||
    (
      openTime
        ? openTime +
          intervalMilliseconds -
          1
        : null
    );

  const open =
    toNumber(candle?.open);

  const high =
    toNumber(candle?.high);

  const low =
    toNumber(candle?.low);

  const close =
    toNumber(candle?.close);

  if (
    !openTime ||
    !closeTime ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    openTime,
    closeTime,
    open,
    high,
    low,
    close,

    volume:
      toNumber(
        candle?.volume,
        0
      )
  };
}

/**
 * Chuẩn hóa danh sách nến.
 */
function normalizeCandles(
  rawCandles,
  interval
) {
  const intervalMilliseconds =
    intervalToMilliseconds(
      interval
    );

  const candles =
    Array.isArray(rawCandles)
      ? rawCandles
      : Array.isArray(
          rawCandles?.candles
        )
        ? rawCandles.candles
        : [];

  return candles
    .map(candle =>
      normalizeCandle(
        candle,
        intervalMilliseconds
      )
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.openTime -
        b.openTime
    );
}

/**
 * Gửi thông báo event Telegram.
 *
 * Telegram lỗi không được phép
 * làm trade monitor dừng.
 */
async function notifyTradeEvent(
  trade,
  eventType,
  details = {}
) {
  if (!trade?.id) {
    return {
      sent: false,
      reason:
        'Thiếu trade để gửi Telegram event'
    };
  }

  try {
    const result =
      await sendTradeEventToTelegram(
        trade,
        eventType,
        details
      );

    console.log(
      `Telegram trade event ${eventType}:`,
      {
        tradeId:
          trade.id,

        symbol:
          trade.symbol,

        sent:
          result?.sent === true,

        fbt:
          result?.fbt?.sent === true,

        cdt:
          result?.cdt?.sent === true
      }
    );

    return result;
  } catch (error) {
    const errorMessage =
      error.response?.data
        ?.description ||
      error.response?.data ||
      error.message ||
      String(error);

    console.error(
      `Gửi Telegram event ${eventType} ` +
      `cho trade #${trade.id} lỗi:`,
      errorMessage
    );

    return {
      sent: false,
      error:
        errorMessage
    };
  }
}

/**
 * Lấy thời gian mở lệnh.
 */
function getTradeOpenedAt(trade) {
  return normalizeTimestamp(
    trade?.opened_at ??
    trade?.created_at
  );
}

/**
 * Lấy thời gian lệnh hết hạn.
 */
function getTradeExpireAt(trade) {
  const openedAt =
    getTradeOpenedAt(trade);

  if (!openedAt) {
    return null;
  }

  const expireSeconds =
    Math.max(
      0,
      Number(
        CONFIG.tradeExpireSeconds ||
        86400
      )
    );

  if (expireSeconds <= 0) {
    return null;
  }

  return (
    openedAt +
    expireSeconds * 1000
  );
}

/**
 * Kiểm tra trade đã đóng chưa.
 */
function isFinalTrade(trade) {
  return [
    'TP2_HIT',
    'SL_HIT',
    'EXPIRED',
    'CANCELLED'
  ].includes(
    String(
      trade?.status || ''
    ).toUpperCase()
  );
}

/**
 * Kiểm tra các mốc giá nến đã chạm.
 */
function getCandleTouches(
  trade,
  candle
) {
  const direction =
    String(
      trade.direction || ''
    )
      .trim()
      .toUpperCase();

  const entry2 =
    toNumber(
      trade.entry2
    );

  const stopLoss =
    toNumber(
      trade.stop_loss
    );

  const takeProfit1 =
    toNumber(
      trade.take_profit1
    );

  const takeProfit2 =
    toNumber(
      trade.take_profit2
    );

  if (direction === 'LONG') {
    return {
      entry2:
        entry2 > 0 &&
        candle.low <= entry2,

      stopLoss:
        stopLoss > 0 &&
        candle.low <= stopLoss,

      takeProfit1:
        takeProfit1 > 0 &&
        candle.high >= takeProfit1,

      takeProfit2:
        takeProfit2 > 0 &&
        candle.high >= takeProfit2
    };
  }

  if (direction === 'SHORT') {
    return {
      entry2:
        entry2 > 0 &&
        candle.high >= entry2,

      stopLoss:
        stopLoss > 0 &&
        candle.high >= stopLoss,

      takeProfit1:
        takeProfit1 > 0 &&
        candle.low <= takeProfit1,

      takeProfit2:
        takeProfit2 > 0 &&
        candle.low <= takeProfit2
    };
  }

  return {
    entry2: false,
    stopLoss: false,
    takeProfit1: false,
    takeProfit2: false
  };
}

/**
 * Metadata chung lưu cùng event.
 */
function buildCandleMetadata(
  candle,
  extra = {}
) {
  return {
    candleInterval:
      CONFIG.tradeMonitorCandleInterval,

    candleOpenTime:
      candle.openTime,

    candleCloseTime:
      candle.closeTime,

    candleOpen:
      candle.open,

    candleHigh:
      candle.high,

    candleLow:
      candle.low,

    candleClose:
      candle.close,

    ambiguousCandlePolicy:
      CONFIG.ambiguousCandlePolicy,

    ...extra
  };
}

/**
 * Chi tiết Telegram lấy từ nến.
 */
function buildTelegramDetails(
  candle,
  eventPrice,
  extra = {}
) {
  return {
    eventPrice,

    eventTime:
      candle?.closeTime
        ? new Date(
            candle.closeTime
          )
        : new Date(),

    candleInterval:
      CONFIG.tradeMonitorCandleInterval,

    candleOpenTime:
      candle?.openTime,

    candleCloseTime:
      candle?.closeTime,

    candleOpen:
      candle?.open,

    candleHigh:
      candle?.high,

    candleLow:
      candle?.low,

    candleClose:
      candle?.close,

    ...extra
  };
}

/**
 * Đánh dấu Entry 2 nếu giá đã chạm.
 */
async function processEntry2Touch(
  trade,
  candle,
  touches
) {
  if (
    !touches.entry2 ||
    trade.entry2_hit_at ||
    !toNumber(trade.entry2)
  ) {
    return trade;
  }

  const updatedTrade =
    await markTradeEntry2Hit(
      trade.id,
      trade.entry2,
      buildCandleMetadata(
        candle,
        {
          detectedBy:
            'TRADE_MONITOR'
        }
      )
    );

  const currentTrade =
    updatedTrade ||
    trade;

  console.log(
    `Trade #${trade.id} chạm Entry 2`,
    {
      symbol:
        trade.symbol,

      direction:
        trade.direction,

      entry2:
        trade.entry2
    }
  );

  await notifyTradeEvent(
    currentTrade,
    'ENTRY2_HIT',
    buildTelegramDetails(
      candle,
      trade.entry2,
      {
        detectedBy:
          'TRADE_MONITOR'
      }
    )
  );

  return currentTrade;
}

/**
 * Xử lý cùng một nến chạm TP và SL.
 */
async function processAmbiguousCandle(
  trade,
  candle,
  touches
) {
  const policy =
    String(
      CONFIG.ambiguousCandlePolicy ||
      'SL_FIRST'
    )
      .trim()
      .toUpperCase();

  const metadata =
    buildCandleMetadata(
      candle,
      {
        ambiguous:
          true,

        touchedStopLoss:
          touches.stopLoss,

        touchedTakeProfit1:
          touches.takeProfit1,

        touchedTakeProfit2:
          touches.takeProfit2
      }
    );

  /*
   * Chính sách bảo thủ:
   * tính SL trước.
   */
  if (policy === 'SL_FIRST') {
    const updatedTrade =
      await markTradeStopLoss(
        trade.id,
        trade.stop_loss,
        metadata
      );

    const currentTrade =
      updatedTrade ||
      trade;

    console.log(
      `Trade #${trade.id} chạm TP và SL cùng nến: tính SL trước`
    );

    await notifyTradeEvent(
      currentTrade,
      'SL_HIT',
      buildTelegramDetails(
        candle,
        trade.stop_loss,
        {
          ambiguous:
            true,

          policy:
            'SL_FIRST',

          touchedTakeProfit1:
            touches.takeProfit1,

          touchedTakeProfit2:
            touches.takeProfit2
        }
      )
    );

    return {
      trade:
        currentTrade,

      closed:
        true,

      event:
        'SL_HIT_AMBIGUOUS'
    };
  }

  /*
   * TP_FIRST và nến chạm TP2:
   * tính TP2 trước, đóng trade.
   */
  if (touches.takeProfit2) {
    const updatedTrade =
      await markTradeTp2(
        trade.id,
        trade.take_profit2,
        metadata
      );

    const currentTrade =
      updatedTrade ||
      trade;

    console.log(
      `Trade #${trade.id} chạm TP2 và SL cùng nến: tính TP2 trước`
    );

    await notifyTradeEvent(
      currentTrade,
      'TP2_HIT',
      buildTelegramDetails(
        candle,
        trade.take_profit2,
        {
          ambiguous:
            true,

          policy:
            'TP_FIRST',

          touchedStopLoss:
            true
        }
      )
    );

    return {
      trade:
        currentTrade,

      closed:
        true,

      event:
        'TP2_HIT_AMBIGUOUS'
    };
  }

  /*
   * TP_FIRST nhưng chỉ chạm TP1 và SL:
   * ghi TP1 trước, sau đó ghi SL.
   */
  let currentTrade =
    trade;

  if (
    !trade.tp1_hit_at &&
    touches.takeProfit1
  ) {
    const tp1Trade =
      await markTradeTp1(
        trade.id,
        trade.take_profit1,
        metadata
      );

    currentTrade =
      tp1Trade ||
      currentTrade;

    await notifyTradeEvent(
      currentTrade,
      'TP1_HIT',
      buildTelegramDetails(
        candle,
        trade.take_profit1,
        {
          ambiguous:
            true,

          policy:
            'TP_FIRST',

          touchedStopLoss:
            true
        }
      )
    );
  }

  const stoppedTrade =
    await markTradeStopLoss(
      trade.id,
      trade.stop_loss,
      metadata
    );

  currentTrade =
    stoppedTrade ||
    currentTrade;

  console.log(
    `Trade #${trade.id} chạm TP1 và SL cùng nến: tính TP1 trước`
  );

  await notifyTradeEvent(
    currentTrade,
    'SL_HIT',
    buildTelegramDetails(
      candle,
      trade.stop_loss,
      {
        ambiguous:
          true,

        policy:
          'TP_FIRST',

        reachedTp1BeforeStop:
          true
      }
    )
  );

  return {
    trade:
      currentTrade,

    closed:
      true,

    event:
      'TP1_THEN_SL_AMBIGUOUS'
  };
}

/**
 * Xử lý TP/SL của một cây nến.
 */
async function processTradeCandle(
  trade,
  candle
) {
  let currentTrade =
    trade;

  const touches =
    getCandleTouches(
      currentTrade,
      candle
    );

  currentTrade =
    await processEntry2Touch(
      currentTrade,
      candle,
      touches
    );

  const touchedAnyTp =
    touches.takeProfit1 ||
    touches.takeProfit2;

  /*
   * Cùng một nến chạm TP và SL.
   */
  if (
    touches.stopLoss &&
    touchedAnyTp
  ) {
    return processAmbiguousCandle(
      currentTrade,
      candle,
      touches
    );
  }

  /*
   * Chạm SL.
   */
  if (touches.stopLoss) {
    const updatedTrade =
      await markTradeStopLoss(
        currentTrade.id,
        currentTrade.stop_loss,
        buildCandleMetadata(
          candle,
          {
            detectedBy:
              'TRADE_MONITOR'
          }
        )
      );

    currentTrade =
      updatedTrade ||
      currentTrade;

    console.log(
      `Trade #${currentTrade.id} SL`,
      {
        symbol:
          currentTrade.symbol,

        stopLoss:
          currentTrade.stop_loss
      }
    );

    await notifyTradeEvent(
      currentTrade,
      'SL_HIT',
      buildTelegramDetails(
        candle,
        currentTrade.stop_loss,
        {
          detectedBy:
            'TRADE_MONITOR'
        }
      )
    );

    return {
      trade:
        currentTrade,

      closed:
        true,

      event:
        'SL_HIT'
    };
  }

  /*
   * Chạm TP2.
   *
   * Repository tự ghi TP1 nếu TP1
   * chưa được ghi trước đó.
   */
  if (touches.takeProfit2) {
    const updatedTrade =
      await markTradeTp2(
        currentTrade.id,
        currentTrade.take_profit2,
        buildCandleMetadata(
          candle,
          {
            detectedBy:
              'TRADE_MONITOR'
          }
        )
      );

    currentTrade =
      updatedTrade ||
      currentTrade;

    console.log(
      `Trade #${currentTrade.id} TP2`,
      {
        symbol:
          currentTrade.symbol,

        takeProfit2:
          currentTrade.take_profit2
      }
    );

    await notifyTradeEvent(
      currentTrade,
      'TP2_HIT',
      buildTelegramDetails(
        candle,
        currentTrade.take_profit2,
        {
          detectedBy:
            'TRADE_MONITOR'
        }
      )
    );

    return {
      trade:
        currentTrade,

      closed:
        true,

      event:
        'TP2_HIT'
    };
  }

  /*
   * Chạm TP1 nhưng chưa chạm TP2.
   */
  if (
    touches.takeProfit1 &&
    !currentTrade.tp1_hit_at
  ) {
    const updatedTrade =
      await markTradeTp1(
        currentTrade.id,
        currentTrade.take_profit1,
        buildCandleMetadata(
          candle,
          {
            detectedBy:
              'TRADE_MONITOR'
          }
        )
      );

    currentTrade =
      updatedTrade ||
      currentTrade;

    console.log(
      `Trade #${currentTrade.id} TP1`,
      {
        symbol:
          currentTrade.symbol,

        takeProfit1:
          currentTrade.take_profit1
      }
    );

    await notifyTradeEvent(
      currentTrade,
      'TP1_HIT',
      buildTelegramDetails(
        candle,
        currentTrade.take_profit1,
        {
          detectedBy:
            'TRADE_MONITOR'
        }
      )
    );

    return {
      trade:
        currentTrade,

      closed:
        false,

      event:
        'TP1_HIT'
    };
  }

  return {
    trade:
      currentTrade,

    closed:
      false,

    event:
      null
  };
}

/**
 * Lọc các nến được phép dùng để
 * đánh giá một trade.
 */
function getTradeCandles(
  trade,
  candles
) {
  const openedAt =
    getTradeOpenedAt(trade);

  const expireAt =
    getTradeExpireAt(trade);

  const lastCheckedTime =
    toNumber(
      trade.last_checked_candle_time,
      0
    );

  const now =
    Date.now();

  return candles.filter(
    candle => {
      /*
       * Chỉ dùng nến đã đóng.
       */
      if (
        candle.closeTime >
        now
      ) {
        return false;
      }

      /*
       * Không dùng lại nến đã kiểm tra.
       */
      if (
        lastCheckedTime > 0 &&
        candle.closeTime <=
          lastCheckedTime
      ) {
        return false;
      }

      /*
       * Chỉ dùng cây nến bắt đầu
       * sau khi tín hiệu được tạo.
       *
       * Tránh tính TP/SL đã xảy ra
       * trước thời điểm bot call.
       */
      if (
        openedAt &&
        candle.openTime <
          openedAt
      ) {
        return false;
      }

      /*
       * Không dùng nến đóng sau
       * thời điểm trade hết hạn.
       */
      if (
        expireAt &&
        candle.closeTime >
          expireAt
      ) {
        return false;
      }

      return true;
    }
  );
}

/**
 * Theo dõi một trade bằng danh sách nến.
 */
async function monitorSingleTrade(
  trade,
  allCandles
) {
  let currentTrade =
    trade;

  const tradeCandles =
    getTradeCandles(
      currentTrade,
      allCandles
    );

  let aggregateHigh =
    null;

  let aggregateLow =
    null;

  let lastProcessedCandleTime =
    toNumber(
      currentTrade
        .last_checked_candle_time
    );

  const events = [];

  for (
    const candle of tradeCandles
  ) {
    aggregateHigh =
      aggregateHigh === null
        ? candle.high
        : Math.max(
            aggregateHigh,
            candle.high
          );

    aggregateLow =
      aggregateLow === null
        ? candle.low
        : Math.min(
            aggregateLow,
            candle.low
          );

    lastProcessedCandleTime =
      candle.closeTime;

    const result =
      await processTradeCandle(
        currentTrade,
        candle
      );

    currentTrade =
      result.trade ||
      currentTrade;

    if (result.event) {
      events.push(
        result.event
      );
    }

    if (
      result.closed ||
      isFinalTrade(
        currentTrade
      )
    ) {
      break;
    }
  }

  /*
   * Lưu nến cuối đã kiểm tra và
   * MFE/MAE để đánh giá AI.
   */
  if (
    aggregateHigh !== null ||
    aggregateLow !== null ||
    lastProcessedCandleTime
  ) {
    currentTrade =
      await updateTradeMonitoringState(
        currentTrade.id,
        {
          highPrice:
            aggregateHigh,

          lowPrice:
            aggregateLow,

          currentPrice:
            tradeCandles.at(-1)
              ?.close,

          lastCheckedCandleTime:
            lastProcessedCandleTime
        }
      ) ||
      currentTrade;
  }

  /*
   * Trade chưa TP2/SL nhưng
   * đã quá thời gian hiệu lực.
   */
  const expireAt =
    getTradeExpireAt(
      currentTrade
    );

  if (
    !isFinalTrade(
      currentTrade
    ) &&
    expireAt &&
    Date.now() >= expireAt
  ) {
    const latestCandle =
      allCandles.at(-1);

    const currentPrice =
      latestCandle?.close;

    currentTrade =
      await markTradeExpired(
        currentTrade.id,
        {
          currentPrice,

          expireAt,

          detectedBy:
            'TRADE_MONITOR'
        }
      ) ||
      currentTrade;

    events.push(
      'EXPIRED'
    );

    console.log(
      `Trade #${currentTrade.id} đã hết hạn`
    );

    await notifyTradeEvent(
      currentTrade,
      'EXPIRED',
      {
        eventPrice:
          currentPrice,

        eventTime:
          new Date(),

        expireAt,

        detectedBy:
          'TRADE_MONITOR'
      }
    );
  }

  return {
    tradeId:
      currentTrade.id,

    symbol:
      currentTrade.symbol,

    status:
      currentTrade.status,

    candlesProcessed:
      tradeCandles.length,

    events
  };
}

/**
 * Lấy nến monitor từ market.js.
 */
async function fetchMonitorCandles(
  symbol
) {
  const interval =
    CONFIG.tradeMonitorCandleInterval ||
    '1m';

  const limit =
    Math.max(
      20,
      Math.min(
        1000,
        Number(
          CONFIG.tradeMonitorKlineLimit ||
          500
        )
      )
    );

  const rawCandles =
    await getKlines(
      symbol,
      interval,
      limit
    );

  const candles =
    normalizeCandles(
      rawCandles,
      interval
    );

  if (candles.length === 0) {
    throw new Error(
      `Không lấy được nến ${interval} cho ${symbol}`
    );
  }

  return candles;
}

/**
 * Chạy một vòng trade monitor.
 */
export async function runTradeMonitorOnce() {
  if (
    !CONFIG.tradeMonitorEnabled
  ) {
    return {
      skipped: true,

      reason:
        'TRADE_MONITOR_ENABLED=false'
    };
  }

  if (
    !isTradeRepositoryEnabled()
  ) {
    return {
      skipped: true,

      reason:
        'Trade database chưa được bật'
    };
  }

  if (monitorRunning) {
    return {
      skipped: true,

      reason:
        'Trade monitor đang chạy'
    };
  }

  monitorRunning = true;

  try {
    const activeTrades =
      await getActiveTrades(
        CONFIG.tradeMonitorBatchSize
      );

    if (
      activeTrades.length === 0
    ) {
      return {
        skipped: false,
        activeTrades: 0,
        results: []
      };
    }

    /*
     * Nhóm trade theo symbol để mỗi
     * symbol chỉ gọi API một lần.
     */
    const tradesBySymbol =
      new Map();

    for (
      const trade of
      activeTrades
    ) {
      if (
        !tradesBySymbol.has(
          trade.symbol
        )
      ) {
        tradesBySymbol.set(
          trade.symbol,
          []
        );
      }

      tradesBySymbol
        .get(trade.symbol)
        .push(trade);
    }

    const results = [];

    for (
      const [
        symbol,
        symbolTrades
      ] of
      tradesBySymbol.entries()
    ) {
      try {
        const candles =
          await fetchMonitorCandles(
            symbol
          );

        for (
          const trade of
          symbolTrades
        ) {
          try {
            const result =
              await monitorSingleTrade(
                trade,
                candles
              );

            results.push({
              ok: true,
              ...result
            });
          } catch (error) {
            const errorMessage =
              error.response?.data ||
              error.message ||
              String(error);

            console.error(
              `Monitor trade #${trade.id} lỗi:`,
              errorMessage
            );

            results.push({
              ok: false,

              tradeId:
                trade.id,

              symbol:
                trade.symbol,

              error:
                errorMessage
            });
          }
        }
      } catch (error) {
        const errorMessage =
          error.response?.data ||
          error.message ||
          String(error);

        console.error(
          `Lấy dữ liệu monitor ${symbol} lỗi:`,
          errorMessage
        );

        for (
          const trade of
          symbolTrades
        ) {
          results.push({
            ok: false,

            tradeId:
              trade.id,

            symbol,

            error:
              errorMessage
          });
        }
      }
    }

    const eventResults =
      results.filter(
        result =>
          Array.isArray(
            result.events
          ) &&
          result.events.length > 0
      );

    if (
      eventResults.length > 0
    ) {
      console.log(
        'Trade monitor events:',
        eventResults
      );
    }

    return {
      skipped: false,

      activeTrades:
        activeTrades.length,

      results
    };
  } finally {
    monitorRunning = false;
  }
}

/**
 * Khởi động monitor định kỳ.
 */
export function startTradeMonitor() {
  if (
    !CONFIG.tradeMonitorEnabled
  ) {
    console.log(
      'Trade monitor: OFF'
    );

    return {
      started: false,

      reason:
        'TRADE_MONITOR_ENABLED=false'
    };
  }

  if (
    !isTradeRepositoryEnabled()
  ) {
    console.log(
      'Trade monitor: OFF - database chưa bật'
    );

    return {
      started: false,

      reason:
        'Trade database chưa bật'
    };
  }

  if (monitorTimer) {
    return {
      started: false,

      reason:
        'Trade monitor đã chạy'
    };
  }

  const intervalSeconds =
    Math.max(
      10,
      Number(
        CONFIG
          .tradeMonitorIntervalSeconds ||
        30
      )
    );

  console.log(
    'Trade monitor: ON',
    {
      checkEverySeconds:
        intervalSeconds,

      candleInterval:
        CONFIG
          .tradeMonitorCandleInterval,

      ambiguousPolicy:
        CONFIG
          .ambiguousCandlePolicy,

      tradeExpireSeconds:
        CONFIG
          .tradeExpireSeconds
    }
  );

  /*
   * Chạy ngay khi bot khởi động.
   */
  runTradeMonitorOnce()
    .catch(error => {
      console.error(
        'Trade monitor startup lỗi:',
        error.response?.data ||
        error.message ||
        String(error)
      );
    });

  monitorTimer =
    setInterval(
      () => {
        runTradeMonitorOnce()
          .catch(error => {
            console.error(
              'Trade monitor loop lỗi:',
              error.response?.data ||
              error.message ||
              String(error)
            );
          });
      },
      intervalSeconds *
      1000
    );

  return {
    started: true,

    intervalSeconds
  };
}

/**
 * Dừng monitor.
 */
export function stopTradeMonitor() {
  if (!monitorTimer) {
    return {
      stopped: false,

      reason:
        'Trade monitor chưa chạy'
    };
  }

  clearInterval(
    monitorTimer
  );

  monitorTimer = null;

  console.log(
    'Trade monitor: STOPPED'
  );

  return {
    stopped: true
  };
}
