import { fetchPublic } from './bingxClient.js';
import { CONFIG } from './config.js';

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export async function getKlines(symbol = CONFIG.symbol, interval = CONFIG.interval, limit = CONFIG.limit) {
  const data = await fetchPublic('/openApi/swap/v3/quote/klines', { symbol, interval, limit });
  if (!Array.isArray(data)) throw new Error('Kline response không phải array');
  return data.map(k => ({
    time: n(k[0] ?? k.time),
    open: n(k[1] ?? k.open),
    high: n(k[2] ?? k.high),
    low: n(k[3] ?? k.low),
    close: n(k[4] ?? k.close),
    volume: n(k[5] ?? k.volume),
    closeTime: n(k[6] ?? k.closeTime),
    quoteVolume: n(k[7] ?? k.quoteVolume)
  })).filter(c => Number.isFinite(c.close)).sort((a, b) => a.time - b.time);
}

export async function getPremiumIndex(symbol = CONFIG.symbol) {
  const data = await fetchPublic('/openApi/swap/v2/quote/premiumIndex', { symbol });
  const item = Array.isArray(data) ? data[0] : data;
  return {
    symbol: item?.symbol || symbol,
    markPrice: n(item?.markPrice),
    indexPrice: n(item?.indexPrice),
    lastFundingRate: n(item?.lastFundingRate),
    nextFundingTime: n(item?.nextFundingTime),
    time: n(item?.time)
  };
}

export async function getFundingRate(symbol = CONFIG.symbol) {
  const data = await fetchPublic('/openApi/swap/v2/quote/fundingRate', { symbol, limit: 5 });
  const item = Array.isArray(data) ? data.at(-1) : data;
  return {
    symbol: item?.symbol || symbol,
    fundingRate: n(item?.fundingRate),
    fundingTime: n(item?.fundingTime),
    nextFundingTime: n(item?.nextFundingTime)
  };
}

export async function getOpenInterest(symbol = CONFIG.symbol) {
  const data = await fetchPublic('/openApi/swap/v2/quote/openInterest', { symbol });
  return {
    symbol: data?.symbol || symbol,
    openInterest: n(data?.openInterest),
    time: n(data?.time)
  };
}

export async function getOrderBookSpread(symbol = CONFIG.symbol) {
  try {
    const data = await fetchPublic('/openApi/swap/v2/quote/depth', {
      symbol,
      limit: 5
    });

    const item = data?.data ?? data;

    const bids = item?.bids || [];
    const asks = item?.asks || [];

    const bestBid = Array.isArray(bids[0])
      ? Number(bids[0][0])
      : Number(bids[0]?.price ?? bids[0]?.p);

    const bestAsk = Array.isArray(asks[0])
      ? Number(asks[0][0])
      : Number(asks[0]?.price ?? asks[0]?.p);

    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

    return {
      symbol,
      bidPrice: bestBid || null,
      askPrice: bestAsk || null,
      spreadPct:
        bestBid && bestAsk && mid
          ? ((bestAsk - bestBid) / mid) * 100
          : null,
      time: Date.now()
    };
  } catch (err) {
    console.log('Không lấy được order book depth:', err.message);

    return {
      symbol,
      bidPrice: null,
      askPrice: null,
      spreadPct: null,
      time: Date.now()
    };
  }
}

export async function getContract(symbol = CONFIG.symbol) {
  const data = await fetchPublic('/openApi/swap/v2/quote/contracts', { symbol });
  const item = Array.isArray(data) ? data.find(x => x.symbol === symbol) || data[0] : data;
  return {
    symbol: item?.symbol || symbol,
    quantityPrecision: n(item?.quantityPrecision, 4),
    pricePrecision: n(item?.pricePrecision, 2),
    tradeMinQuantity: n(item?.tradeMinQuantity, 0),
    tradeMinUSDT: n(item?.tradeMinUSDT, 0),
    maxLongLeverage: n(item?.maxLongLeverage, 1),
    maxShortLeverage: n(item?.maxShortLeverage, 1),
    apiStateOpen: String(item?.apiStateOpen || 'true'),
    apiStateClose: String(item?.apiStateClose || 'true')
  };
}

export async function buildMarketSnapshot() {
  const [candles, premium, funding, oi, contract] = await Promise.all([
    getKlines(),
    getPremiumIndex(),
    getFundingRate(),
    getOpenInterest(),
    getContract()
  ]);

  const book = await getOrderBookSpread();

  return {
    symbol: CONFIG.symbol,
    interval: CONFIG.interval,
    candles,
    premium,
    funding,
    oi,
    book,
    contract
  };
}
