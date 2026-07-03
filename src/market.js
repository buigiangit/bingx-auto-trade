import { fetchPublic } from './bingxClient.js';
import { CONFIG } from './config.js';

/**
 * Chuyển dữ liệu sang Number.
 */
function n(value, fallback = null) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

/**
 * Làm sạch tên interval.
 */
function normalizeInterval(
  interval,
  fallback = '15m'
) {
  const value = String(
    interval || fallback
  ).trim();

  return value || fallback;
}

/**
 * Loại bỏ interval trùng nhau.
 */
function uniqueIntervals(intervals) {
  return [
    ...new Set(
      (Array.isArray(intervals)
        ? intervals
        : []
      )
        .map(interval =>
          normalizeInterval(interval, '')
        )
        .filter(Boolean)
    )
  ];
}

/**
 * Lấy danh sách khung thời gian cần phân tích.
 */
function getConfiguredIntervals() {
  const entryInterval =
    CONFIG.entryInterval ||
    CONFIG.interval ||
    '15m';

  if (!CONFIG.multiTimeframeEnabled) {
    return [entryInterval];
  }

  const intervals = uniqueIntervals([
    entryInterval,
    CONFIG.confirmInterval,
    CONFIG.trendInterval,
    ...(CONFIG.intervals || [])
  ]);

  return intervals.length > 0
    ? intervals
    : [entryInterval];
}

/**
 * Lấy dữ liệu nến của một khung thời gian.
 *
 * Ví dụ:
 * getKlines('BTC-USDT', '15m', 240)
 * getKlines('BTC-USDT', '1h', 240)
 * getKlines('BTC-USDT', '4h', 240)
 */
export async function getKlines(
  symbol = CONFIG.symbol,
  interval =
    CONFIG.entryInterval ||
    CONFIG.interval,
  limit = CONFIG.limit
) {
  const normalizedInterval =
    normalizeInterval(
      interval,
      CONFIG.interval || '15m'
    );

  const normalizedLimit = Math.max(
    1,
    Number(limit) || 240
  );

  const data = await fetchPublic(
    '/openApi/swap/v3/quote/klines',
    {
      symbol,
      interval: normalizedInterval,
      limit: normalizedLimit
    }
  );

  if (!Array.isArray(data)) {
    throw new Error(
      `Kline response ${normalizedInterval} không phải array`
    );
  }

  const candles = data
    .map(kline => ({
      time: n(
        kline?.[0] ??
        kline?.time
      ),

      open: n(
        kline?.[1] ??
        kline?.open
      ),

      high: n(
        kline?.[2] ??
        kline?.high
      ),

      low: n(
        kline?.[3] ??
        kline?.low
      ),

      close: n(
        kline?.[4] ??
        kline?.close
      ),

      volume: n(
        kline?.[5] ??
        kline?.volume
      ),

      closeTime: n(
        kline?.[6] ??
        kline?.closeTime
      ),

      quoteVolume: n(
        kline?.[7] ??
        kline?.quoteVolume
      )
    }))
    .filter(candle => {
      return (
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close)
      );
    })
    .sort(
      (a, b) => a.time - b.time
    );

  if (candles.length === 0) {
    throw new Error(
      `Không lấy được nến hợp lệ cho ${symbol} ${normalizedInterval}`
    );
  }

  return candles;
}

/**
 * Lấy Mark Price, Index Price và Funding hiện tại.
 */
export async function getPremiumIndex(
  symbol = CONFIG.symbol
) {
  const data = await fetchPublic(
    '/openApi/swap/v2/quote/premiumIndex',
    { symbol }
  );

  const item = Array.isArray(data)
    ? data[0]
    : data;

  return {
    symbol:
      item?.symbol || symbol,

    markPrice:
      n(item?.markPrice),

    indexPrice:
      n(item?.indexPrice),

    lastFundingRate:
      n(item?.lastFundingRate),

    nextFundingTime:
      n(item?.nextFundingTime),

    time:
      n(item?.time)
  };
}

/**
 * Lấy lịch sử Funding Rate gần nhất.
 */
export async function getFundingRate(
  symbol = CONFIG.symbol
) {
  const data = await fetchPublic(
    '/openApi/swap/v2/quote/fundingRate',
    {
      symbol,
      limit: 5
    }
  );

  const item = Array.isArray(data)
    ? data.at(-1)
    : data;

  return {
    symbol:
      item?.symbol || symbol,

    fundingRate:
      n(item?.fundingRate),

    fundingTime:
      n(item?.fundingTime),

    nextFundingTime:
      n(item?.nextFundingTime)
  };
}

/**
 * Lấy Open Interest.
 */
export async function getOpenInterest(
  symbol = CONFIG.symbol
) {
  const data = await fetchPublic(
    '/openApi/swap/v2/quote/openInterest',
    { symbol }
  );

  const item =
    data?.data ?? data;

  return {
    symbol:
      item?.symbol || symbol,

    openInterest:
      n(item?.openInterest),

    time:
      n(item?.time)
  };
}

/**
 * Lấy Bid, Ask và tính Spread.
 */
export async function getOrderBookSpread(
  symbol = CONFIG.symbol
) {
  try {
    const data = await fetchPublic(
      '/openApi/swap/v2/quote/depth',
      {
        symbol,
        limit: 5
      }
    );

    const item =
      data?.data ?? data;

    const bids =
      Array.isArray(item?.bids)
        ? item.bids
        : [];

    const asks =
      Array.isArray(item?.asks)
        ? item.asks
        : [];

    const bestBid = Array.isArray(bids[0])
      ? n(bids[0][0])
      : n(
          bids[0]?.price ??
          bids[0]?.p
        );

    const bestAsk = Array.isArray(asks[0])
      ? n(asks[0][0])
      : n(
          asks[0]?.price ??
          asks[0]?.p
        );

    const mid =
      Number.isFinite(bestBid) &&
      Number.isFinite(bestAsk) &&
      bestBid > 0 &&
      bestAsk > 0
        ? (bestBid + bestAsk) / 2
        : null;

    const spreadPct =
      Number.isFinite(mid) &&
      mid > 0
        ? (
            (bestAsk - bestBid) /
            mid
          ) * 100
        : null;

    return {
      symbol,

      bidPrice:
        bestBid,

      askPrice:
        bestAsk,

      midPrice:
        mid,

      spreadPct,

      time:
        Date.now()
    };
  } catch (error) {
    console.log(
      'Không lấy được order book depth:',
      error.response?.data ||
      error.message
    );

    return {
      symbol,
      bidPrice: null,
      askPrice: null,
      midPrice: null,
      spreadPct: null,
      time: Date.now()
    };
  }
}

/**
 * Lấy thông tin hợp đồng.
 */
export async function getContract(
  symbol = CONFIG.symbol
) {
  const data = await fetchPublic(
    '/openApi/swap/v2/quote/contracts',
    { symbol }
  );

  const source =
    data?.data ?? data;

  const item = Array.isArray(source)
    ? (
        source.find(
          contract =>
            contract.symbol === symbol
        ) ||
        source[0]
      )
    : source;

  return {
    symbol:
      item?.symbol || symbol,

    quantityPrecision:
      n(
        item?.quantityPrecision,
        4
      ),

    pricePrecision:
      n(
        item?.pricePrecision,
        2
      ),

    tradeMinQuantity:
      n(
        item?.tradeMinQuantity,
        0
      ),

    tradeMinUSDT:
      n(
        item?.tradeMinUSDT,
        0
      ),

    maxLongLeverage:
      n(
        item?.maxLongLeverage,
        1
      ),

    maxShortLeverage:
      n(
        item?.maxShortLeverage,
        1
      ),

    apiStateOpen:
      String(
        item?.apiStateOpen ??
        'true'
      ),

    apiStateClose:
      String(
        item?.apiStateClose ??
        'true'
      )
  };
}

/**
 * Lấy các dữ liệu chung.
 *
 * Những dữ liệu này không cần gọi lại
 * cho từng khung thời gian.
 */
export async function getCommonMarketData(
  symbol = CONFIG.symbol
) {
  const [
    premium,
    funding,
    oi,
    book,
    contract
  ] = await Promise.all([
    getPremiumIndex(symbol),
    getFundingRate(symbol),
    getOpenInterest(symbol),
    getOrderBookSpread(symbol),
    getContract(symbol)
  ]);

  return {
    premium,
    funding,
    oi,
    book,
    contract
  };
}

/**
 * Chế độ tương thích code cũ.
 *
 * Có thể gọi:
 *
 * buildMarketSnapshot()
 * buildMarketSnapshot('1h')
 * buildMarketSnapshot('4h')
 */
export async function buildMarketSnapshot(
  interval =
    CONFIG.entryInterval ||
    CONFIG.interval
) {
  const normalizedInterval =
    normalizeInterval(
      interval,
      CONFIG.interval || '15m'
    );

  const [
    candles,
    common
  ] = await Promise.all([
    getKlines(
      CONFIG.symbol,
      normalizedInterval,
      CONFIG.limit
    ),

    getCommonMarketData(
      CONFIG.symbol
    )
  ]);

  return {
    symbol:
      CONFIG.symbol,

    interval:
      normalizedInterval,

    candles,

    premium:
      common.premium,

    funding:
      common.funding,

    oi:
      common.oi,

    book:
      common.book,

    contract:
      common.contract
  };
}

/**
 * Xây dựng dữ liệu đa khung.
 *
 * Funding, OI, Spread và Contract
 * chỉ được gọi một lần.
 *
 * Nến của tất cả các khung được gọi song song.
 */
export async function buildMultiTimeframeSnapshot() {
  const intervals =
    getConfiguredIntervals();

  const entryInterval =
    CONFIG.entryInterval ||
    CONFIG.interval ||
    intervals[0];

  const confirmInterval =
    CONFIG.confirmInterval ||
    intervals[1] ||
    entryInterval;

  const trendInterval =
    CONFIG.trendInterval ||
    intervals[2] ||
    confirmInterval;

  const [
    timeframeEntries,
    common
  ] = await Promise.all([
    Promise.all(
      intervals.map(
        async interval => {
          const candles =
            await getKlines(
              CONFIG.symbol,
              interval,
              CONFIG.limit
            );

          return [
            interval,
            candles
          ];
        }
      )
    ),

    getCommonMarketData(
      CONFIG.symbol
    )
  ]);

  const timeframes =
    Object.fromEntries(
      timeframeEntries.map(
        ([interval, candles]) => [
          interval,
          {
            symbol:
              CONFIG.symbol,

            interval,

            candles,

            premium:
              common.premium,

            funding:
              common.funding,

            oi:
              common.oi,

            book:
              common.book,

            contract:
              common.contract
          }
        ]
      )
    );

  const entrySnapshot =
    timeframes[entryInterval] ||
    timeframes[intervals[0]];

  if (!entrySnapshot) {
    throw new Error(
      `Không có dữ liệu khung entry ${entryInterval}`
    );
  }

  return {
    symbol:
      CONFIG.symbol,

    multiTimeframeEnabled:
      CONFIG.multiTimeframeEnabled === true,

    intervals,

    entryInterval,

    confirmInterval,

    trendInterval,

    timeframes,

    /*
     * Dữ liệu chung đặt ngoài timeframes
     * để ai.js và index.js dễ sử dụng.
     */
    premium:
      common.premium,

    funding:
      common.funding,

    oi:
      common.oi,

    book:
      common.book,

    contract:
      common.contract,

    /*
     * Giữ sẵn dữ liệu khung entry
     * để tương thích khi cần.
     */
    interval:
      entrySnapshot.interval,

    candles:
      entrySnapshot.candles
  };
}
