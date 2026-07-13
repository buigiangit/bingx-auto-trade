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
 * Chuyển timestamp giây hoặc mili giây
 * về mili giây.
 */
function normalizeTimestamp(value) {
  const timestamp = n(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp < 1_000_000_000_000
    ? timestamp * 1000
    : timestamp;
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
 * Chuyển interval thành mili giây.
 */
function intervalToMilliseconds(interval) {
  const normalized =
    normalizeInterval(
      interval,
      '1m'
    );

  const match =
    normalized.match(
      /^(\d+)(m|h|d|w|M)$/
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
      7 * 24 * 60 * 60 * 1000,

    M:
      30 * 24 * 60 * 60 * 1000
  };

  return (
    amount *
    unitMilliseconds[unit]
  );
}

/**
 * Lấy phần data nếu response
 * vẫn còn wrapper.
 */
function unwrapData(value) {
  return value?.data ?? value;
}

/**
 * Loại bỏ interval trùng nhau.
 */
function uniqueIntervals(intervals) {
  return [
    ...new Set(
      (
        Array.isArray(intervals)
          ? intervals
          : []
      )
        .map(interval =>
          normalizeInterval(
            interval,
            ''
          )
        )
        .filter(Boolean)
    )
  ];
}

/**
 * Lấy danh sách khung cần phân tích.
 */
function getConfiguredIntervals() {
  const entryInterval =
    CONFIG.entryInterval ||
    CONFIG.interval ||
    '15m';

  if (!CONFIG.multiTimeframeEnabled) {
    return [
      entryInterval
    ];
  }

  const intervals =
    uniqueIntervals([
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
 * Chuẩn hóa một cây nến BingX.
 *
 * Hỗ trợ cả object và array.
 */
function normalizeKline(
  kline,
  intervalMilliseconds
) {
  const isArray =
    Array.isArray(kline);

  const openTime =
    normalizeTimestamp(
      isArray
        ? kline[0]
        : (
            kline?.openTime ??
            kline?.time ??
            kline?.timestamp
          )
    );

  const open =
    n(
      isArray
        ? kline[1]
        : kline?.open
    );

  const high =
    n(
      isArray
        ? kline[2]
        : kline?.high
    );

  const low =
    n(
      isArray
        ? kline[3]
        : kline?.low
    );

  const close =
    n(
      isArray
        ? kline[4]
        : kline?.close
    );

  const volume =
    n(
      isArray
        ? kline[5]
        : kline?.volume,
      0
    );

  const explicitCloseTime =
    normalizeTimestamp(
      isArray
        ? kline[6]
        : (
            kline?.closeTime ??
            kline?.endTime
          )
    );

  const inferredCloseTime =
    Number.isFinite(openTime)
      ? (
          openTime +
          intervalMilliseconds -
          1
        )
      : null;

  /*
   * Chỉ dùng closeTime API nếu
   * giá trị hợp lý.
   */
  const closeTimeIsValid =
    Number.isFinite(
      explicitCloseTime
    ) &&
    Number.isFinite(
      openTime
    ) &&
    explicitCloseTime >=
      openTime &&
    explicitCloseTime <=
      (
        openTime +
        intervalMilliseconds * 2
      );

  const closeTime =
    closeTimeIsValid
      ? explicitCloseTime
      : inferredCloseTime;

  const quoteVolume =
    n(
      isArray
        ? kline[7]
        : (
            kline?.quoteVolume ??
            kline?.quoteAssetVolume
          )
    );

  if (
    !Number.isFinite(openTime) ||
    !Number.isFinite(closeTime) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    high < low
  ) {
    return null;
  }

  return {
    /*
     * Giữ cả hai trường:
     *
     * tradeMonitor.js dùng openTime.
     * Code cũ có thể dùng time.
     */
    openTime,

    time:
      openTime,

    closeTime,

    open,
    high,
    low,
    close,
    volume,
    quoteVolume
  };
}

/**
 * Lấy dữ liệu nến của một khung.
 */
export async function getKlines(
  symbol = CONFIG.symbol,
  interval =
    CONFIG.entryInterval ||
    CONFIG.interval,
  limit = CONFIG.limit
) {
  const normalizedSymbol =
    String(
      symbol ||
      CONFIG.symbol ||
      ''
    ).trim();

  if (!normalizedSymbol) {
    throw new Error(
      'Symbol lấy nến không được để trống'
    );
  }

  const normalizedInterval =
    normalizeInterval(
      interval,
      CONFIG.interval ||
      '15m'
    );

  const normalizedLimit =
    Math.max(
      1,
      Math.min(
        1000,
        Math.floor(
          Number(limit) ||
          240
        )
      )
    );

  const response =
    await fetchPublic(
      '/openApi/swap/v3/quote/klines',
      {
        symbol:
          normalizedSymbol,

        interval:
          normalizedInterval,

        limit:
          normalizedLimit
      }
    );

  const source =
    unwrapData(response);

  if (!Array.isArray(source)) {
    throw new Error(
      `Kline response ${normalizedInterval} không phải array`
    );
  }

  const intervalMilliseconds =
    intervalToMilliseconds(
      normalizedInterval
    );

  const candles =
    source
      .map(kline =>
        normalizeKline(
          kline,
          intervalMilliseconds
        )
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.openTime -
          b.openTime
      );

  if (candles.length === 0) {
    throw new Error(
      `Không lấy được nến hợp lệ cho ` +
      `${normalizedSymbol} ` +
      `${normalizedInterval}`
    );
  }

  return candles;
}

/**
 * Lấy Mark Price, Index Price
 * và Funding hiện tại.
 */
export async function getPremiumIndex(
  symbol = CONFIG.symbol
) {
  const response =
    await fetchPublic(
      '/openApi/swap/v2/quote/premiumIndex',
      {
        symbol
      }
    );

  const source =
    unwrapData(response);

  const item =
    Array.isArray(source)
      ? source[0]
      : source;

  return {
    symbol:
      item?.symbol ||
      symbol,

    markPrice:
      n(
        item?.markPrice
      ),

    indexPrice:
      n(
        item?.indexPrice
      ),

    lastFundingRate:
      n(
        item?.lastFundingRate
      ),

    nextFundingTime:
      normalizeTimestamp(
        item?.nextFundingTime
      ),

    time:
      normalizeTimestamp(
        item?.time
      )
  };
}

/**
 * Lấy Funding Rate gần nhất.
 */
export async function getFundingRate(
  symbol = CONFIG.symbol
) {
  const response =
    await fetchPublic(
      '/openApi/swap/v2/quote/fundingRate',
      {
        symbol,
        limit: 5
      }
    );

  const source =
    unwrapData(response);

  const items =
    Array.isArray(source)
      ? source
      : source
        ? [source]
        : [];

  const item =
    items
      .filter(Boolean)
      .sort(
        (a, b) =>
          (
            normalizeTimestamp(
              a?.fundingTime
            ) || 0
          ) -
          (
            normalizeTimestamp(
              b?.fundingTime
            ) || 0
          )
      )
      .at(-1);

  return {
    symbol:
      item?.symbol ||
      symbol,

    fundingRate:
      n(
        item?.fundingRate
      ),

    fundingTime:
      normalizeTimestamp(
        item?.fundingTime
      ),

    nextFundingTime:
      normalizeTimestamp(
        item?.nextFundingTime
      )
  };
}

/**
 * Lấy Open Interest.
 */
export async function getOpenInterest(
  symbol = CONFIG.symbol
) {
  const response =
    await fetchPublic(
      '/openApi/swap/v2/quote/openInterest',
      {
        symbol
      }
    );

  const source =
    unwrapData(response);

  const item =
    Array.isArray(source)
      ? source[0]
      : source;

  return {
    symbol:
      item?.symbol ||
      symbol,

    openInterest:
      n(
        item?.openInterest
      ),

    time:
      normalizeTimestamp(
        item?.time
      )
  };
}

/**
 * Lấy Bid, Ask và tính Spread.
 */
export async function getOrderBookSpread(
  symbol = CONFIG.symbol
) {
  try {
    const response =
      await fetchPublic(
        '/openApi/swap/v2/quote/depth',
        {
          symbol,
          limit: 5
        }
      );

    const item =
      unwrapData(response);

    const bids =
      Array.isArray(
        item?.bids
      )
        ? item.bids
        : [];

    const asks =
      Array.isArray(
        item?.asks
      )
        ? item.asks
        : [];

    const bestBid =
      Array.isArray(
        bids[0]
      )
        ? n(
            bids[0][0]
          )
        : n(
            bids[0]?.price ??
            bids[0]?.p
          );

    const bestAsk =
      Array.isArray(
        asks[0]
      )
        ? n(
            asks[0][0]
          )
        : n(
            asks[0]?.price ??
            asks[0]?.p
          );

    const mid =
      Number.isFinite(
        bestBid
      ) &&
      Number.isFinite(
        bestAsk
      ) &&
      bestBid > 0 &&
      bestAsk > 0
        ? (
            bestBid +
            bestAsk
          ) / 2
        : null;

    const spreadPct =
      Number.isFinite(mid) &&
      mid > 0
        ? (
            (
              bestAsk -
              bestBid
            ) /
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
      error.message ||
      String(error)
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
  const response =
    await fetchPublic(
      '/openApi/swap/v2/quote/contracts',
      {
        symbol
      }
    );

  const source =
    unwrapData(response);

  const item =
    Array.isArray(source)
      ? (
          source.find(
            contract =>
              contract?.symbol ===
              symbol
          ) ||
          source[0]
        )
      : source;

  return {
    symbol:
      item?.symbol ||
      symbol,

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
 * Các dữ liệu này chỉ cần gọi một lần
 * cho toàn bộ timeframe.
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
    getPremiumIndex(
      symbol
    ),

    getFundingRate(
      symbol
    ),

    getOpenInterest(
      symbol
    ),

    getOrderBookSpread(
      symbol
    ),

    getContract(
      symbol
    )
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
 * Chế độ một timeframe.
 */
export async function buildMarketSnapshot(
  interval =
    CONFIG.entryInterval ||
    CONFIG.interval
) {
  const normalizedInterval =
    normalizeInterval(
      interval,
      CONFIG.interval ||
      '15m'
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
        ([
          interval,
          candles
        ]) => [
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
    timeframes[
      entryInterval
    ] ||
    timeframes[
      intervals[0]
    ];

  if (!entrySnapshot) {
    throw new Error(
      `Không có dữ liệu khung entry ${entryInterval}`
    );
  }

  return {
    symbol:
      CONFIG.symbol,

    multiTimeframeEnabled:
      CONFIG.multiTimeframeEnabled ===
      true,

    intervals,

    entryInterval,

    confirmInterval,

    trendInterval,

    timeframes,

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
     * Giữ khung Entry ở top-level
     * để ai.js, index.js, executor.js
     * tiếp tục sử dụng.
     */
    interval:
      entrySnapshot.interval,

    candles:
      entrySnapshot.candles
  };
}
