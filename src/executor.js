import { CONFIG } from "./config.js";
import { fetchSigned } from "./bingxClient.js";
import {
  getSymbolState,
  updateSymbolState
} from "./state.js";
import {
  sendCommunitySignalToTelegram
} from "./telegram.js";

import {
  isTradeRepositoryEnabled,
  getActiveTradeBySymbol,
  createTradeRecord,
  updateTradeTelegramResult,
  recordTradeEvent,
  recordTradeDca,
  markTradeCancelled
} from "./tradeRepository.js";

function getExecutionMode() {
  return String(
    CONFIG.executionMode || ""
  )
    .trim()
    .toUpperCase();
}

function getBingxEnv() {
  return String(
    CONFIG.bingxEnv || ""
  )
    .trim()
    .toLowerCase();
}

function toNumber(
  value,
  fallback = null
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function hasBingxApiError(
  response
) {
  return (
    response?.code !== undefined &&
    response?.code !== 0 &&
    response?.code !== "0"
  );
}

/**
 * Lấy symbol đang chạy từ snapshot.
 *
 * Quan trọng:
 * Khi ENV SYMBOL có nhiều coin:
 * SYMBOL=BTC-USDT,ETH-USDT,SOL-USDT
 *
 * Thì executor không được dùng nguyên chuỗi đó.
 * Mỗi lần chạy phải lấy symbol cụ thể từ snapshot.
 */
function getSymbol(snapshot) {
  const raw =
    String(
      snapshot?.symbol ||
      CONFIG.symbol ||
      "BTC-USDT"
    )
      .trim()
      .toUpperCase();

  const firstSymbol =
    raw
      .split(",")
      .map(item =>
        item.trim()
      )
      .filter(Boolean)[0];

  return firstSymbol ||
    "BTC-USDT";
}

function getCurrentPrice(snapshot) {
  const bidPrice =
    toNumber(
      snapshot?.book?.bidPrice
    );

  const askPrice =
    toNumber(
      snapshot?.book?.askPrice
    );

  if (
    bidPrice > 0 &&
    askPrice > 0
  ) {
    return (
      bidPrice +
      askPrice
    ) / 2;
  }

  const markPrice =
    toNumber(
      snapshot?.premium?.markPrice
    );

  if (markPrice > 0) {
    return markPrice;
  }

  const lastClose =
    toNumber(
      snapshot?.indicators?.lastClose
    );

  if (lastClose > 0) {
    return lastClose;
  }

  const candles =
    Array.isArray(
      snapshot?.candles
    )
      ? snapshot.candles
      : [];

  return toNumber(
    candles.at(-1)?.close
  );
}

function sideFor(signal) {
  const normalized =
    String(signal || "")
      .trim()
      .toUpperCase();

  if (
    normalized === "LONG"
  ) {
    return {
      side:
        "BUY",

      positionSide:
        "LONG"
    };
  }

  if (
    normalized === "SHORT"
  ) {
    return {
      side:
        "SELL",

      positionSide:
        "SHORT"
    };
  }

  throw new Error(
    `Signal không hợp lệ: ${signal}`
  );
}

function clientOrderId(
  symbol,
  mode
) {
  const prefix =
    mode === "USDT_ORDER"
      ? "ai-live"
      : mode === "VST_ORDER"
        ? "ai-vst"
        : "ai-test";

  return (
    `${prefix}-` +
    `${String(symbol || "")
      .replace("-", "")
      .toLowerCase()}-` +
    `${Date.now()}`
  ).slice(
    0,
    40
  );
}

function roundPrice(
  value,
  precision = 2
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return null;
  }

  const safePrecision =
    Math.max(
      0,
      Math.min(
        12,
        Number(precision) || 2
      )
    );

  const multiplier =
    Math.pow(
      10,
      safePrecision
    );

  return (
    Math.round(
      number *
      multiplier
    ) /
    multiplier
  );
}

function buildTpSlParams(
  decision,
  snapshot
) {
  const signal =
    decision?.signal || {};

  const direction =
    String(
      signal.signal || ""
    )
      .trim()
      .toUpperCase();

  const pricePrecision =
    Number(
      snapshot?.contract?.pricePrecision ??
      2
    );

  const entry =
    Number(
      signal.entry1 ??
      signal.entry
    );

  const stopLoss =
    roundPrice(
      signal.stopLoss,
      pricePrecision
    );

  const takeProfit1 =
    roundPrice(
      signal.takeProfit1,
      pricePrecision
    );

  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    throw new Error(
      `Entry không hợp lệ: ${
        signal.entry1 ??
        signal.entry
      }`
    );
  }

  if (
    !Number.isFinite(stopLoss) ||
    stopLoss <= 0
  ) {
    throw new Error(
      `Stop Loss không hợp lệ: ${signal.stopLoss}`
    );
  }

  if (
    !Number.isFinite(takeProfit1) ||
    takeProfit1 <= 0
  ) {
    throw new Error(
      `Take Profit không hợp lệ: ${signal.takeProfit1}`
    );
  }

  if (
    direction === "LONG" &&
    !(
      stopLoss < entry &&
      takeProfit1 > entry
    )
  ) {
    throw new Error(
      `TP/SL LONG sai hướng. ` +
      `Entry: ${entry}, ` +
      `SL: ${stopLoss}, ` +
      `TP1: ${takeProfit1}`
    );
  }

  if (
    direction === "SHORT" &&
    !(
      stopLoss > entry &&
      takeProfit1 < entry
    )
  ) {
    throw new Error(
      `TP/SL SHORT sai hướng. ` +
      `Entry: ${entry}, ` +
      `SL: ${stopLoss}, ` +
      `TP1: ${takeProfit1}`
    );
  }

  if (
    ![
      "LONG",
      "SHORT"
    ].includes(direction)
  ) {
    throw new Error(
      `Không thể tạo TP/SL cho signal: ${signal.signal}`
    );
  }

  return {
    takeProfit:
      JSON.stringify({
        type:
          "TAKE_PROFIT_MARKET",

        stopPrice:
          takeProfit1,

        price:
          takeProfit1,

        workingType:
          "MARK_PRICE"
      }),

    stopLoss:
      JSON.stringify({
        type:
          "STOP_MARKET",

        stopPrice:
          stopLoss,

        price:
          stopLoss,

        workingType:
          "MARK_PRICE"
      })
  };
}

async function setLeverageBeforeOrder(
  decision,
  symbol
) {
  const leverage =
    Number(
      decision?.leverage ||
      CONFIG.maxLeverage ||
      1
    );

  if (
    !Number.isFinite(leverage) ||
    leverage <= 0
  ) {
    throw new Error(
      `Leverage không hợp lệ: ${leverage}`
    );
  }

  const direction =
    String(
      decision?.signal?.signal || ""
    )
      .trim()
      .toUpperCase();

  const side =
    direction === "LONG"
      ? "LONG"
      : direction === "SHORT"
        ? "SHORT"
        : "ALL";

  const response =
    await fetchSigned(
      "POST",
      "/openApi/swap/v2/trade/leverage",
      {
        symbol,
        leverage,
        side
      }
    );

  if (
    hasBingxApiError(
      response
    )
  ) {
    throw new Error(
      `Set leverage lỗi: ${
        response?.msg ||
        response?.message ||
        JSON.stringify(response)
      }`
    );
  }

  return response;
}

async function getOpenPosition(
  symbol
) {
  const response =
    await fetchSigned(
      "GET",
      "/openApi/swap/v2/user/positions",
      {
        symbol
      }
    );

  if (
    hasBingxApiError(
      response
    )
  ) {
    throw new Error(
      `Không lấy được vị thế BingX: ${
        response?.msg ||
        response?.message ||
        JSON.stringify(response)
      }`
    );
  }

  const positions =
    Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.positions)
          ? response.positions
          : [];

  const openedPosition =
    positions.find(
      position => {
        const quantity =
          Math.abs(
            Number(
              position.positionAmt ??
              position.positionAmount ??
              position.availableAmt ??
              position.positionSize ??
              position.quantity ??
              0
            )
          );

        return quantity > 0;
      }
    );

  if (!openedPosition) {
    return null;
  }

  const positionAmt =
    Number(
      openedPosition.positionAmt ??
      openedPosition.positionAmount ??
      openedPosition.availableAmt ??
      openedPosition.positionSize ??
      openedPosition.quantity ??
      0
    );

  const avgPrice =
    Number(
      openedPosition.avgPrice ??
      openedPosition.averagePrice ??
      openedPosition.entryPrice ??
      0
    );

  const markPrice =
    Number(
      openedPosition.markPrice ??
      openedPosition.currentPrice ??
      openedPosition.lastPrice ??
      0
    );

  const unrealizedProfit =
    Number(
      openedPosition.unrealizedProfit ??
      openedPosition.unrealizedPnl ??
      openedPosition.pnl ??
      0
    );

  const leverage =
    Number(
      openedPosition.leverage ??
      CONFIG.maxLeverage ??
      1
    );

  const currentPrice =
    markPrice ||
    avgPrice;

  const notional =
    Math.abs(positionAmt) *
    currentPrice;

  const margin =
    leverage > 0
      ? notional / leverage
      : 0;

  const roePct =
    margin > 0
      ? (
          unrealizedProfit /
          margin
        ) * 100
      : 0;

  return {
    symbol:
      openedPosition.symbol ||
      symbol,

    positionSide:
      String(
        openedPosition.positionSide || ""
      )
        .trim()
        .toUpperCase(),

    positionAmt,
    avgPrice,
    markPrice,
    unrealizedProfit,
    leverage,
    notional,
    margin,
    roePct,

    raw:
      openedPosition
  };
}

function isSameDirection(
  openPosition,
  signal
) {
  if (!openPosition) {
    return false;
  }

  const direction =
    String(signal || "")
      .trim()
      .toUpperCase();

  if (
    direction === "LONG"
  ) {
    return (
      openPosition.positionSide === "LONG" ||
      (
        !openPosition.positionSide &&
        openPosition.positionAmt > 0
      )
    );
  }

  if (
    direction === "SHORT"
  ) {
    return (
      openPosition.positionSide === "SHORT" ||
      (
        !openPosition.positionSide &&
        openPosition.positionAmt < 0
      )
    );
  }

  return false;
}

function checkEntry2Proximity(
  activeTrade,
  currentPrice
) {
  const entry2 =
    toNumber(
      activeTrade?.entry2
    );

  if (
    !entry2 ||
    entry2 <= 0
  ) {
    return {
      allowed:
        false,

      reason:
        "Trade active không có Entry 2 hợp lệ"
    };
  }

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return {
      allowed:
        false,

      reason:
        "Không xác định được giá hiện tại để kiểm tra DCA"
    };
  }

  const distancePct =
    (
      Math.abs(
        currentPrice -
        entry2
      ) /
      entry2
    ) * 100;

  const tolerancePct =
    Math.max(
      0,
      Number(
        CONFIG.dcaEntry2TolerancePct ||
        0.15
      )
    );

  if (
    distancePct >
    tolerancePct
  ) {
    return {
      allowed:
        false,

      distancePct,
      tolerancePct,

      reason:
        `Giá hiện tại chưa gần Entry 2. ` +
        `Lệch ${distancePct.toFixed(3)}%, ` +
        `cho phép tối đa ${tolerancePct}%`
    };
  }

  return {
    allowed:
      true,

    distancePct,
    tolerancePct,

    reason:
      "Giá đang nằm gần Entry 2"
  };
}

function buildDcaDecision(
  decision,
  activeTrade,
  currentPrice,
  openPosition = null
) {
  const dcaMarginUsdt =
    Number(
      CONFIG.dcaMarginUsdt || 0
    );

  const leverage =
    Number(
      decision?.leverage ||
      activeTrade?.leverage ||
      CONFIG.maxLeverage ||
      1
    );

  const dcaNotional =
    dcaMarginUsdt *
    leverage;

  const price =
    Number(
      openPosition?.markPrice ||
      currentPrice ||
      openPosition?.avgPrice ||
      activeTrade?.entry2 ||
      activeTrade?.average_entry ||
      activeTrade?.entry1
    );

  if (
    !Number.isFinite(dcaNotional) ||
    dcaNotional <= 0
  ) {
    throw new Error(
      `DCA notional không hợp lệ: ${dcaNotional}`
    );
  }

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `Không tính được giá DCA hợp lệ: ${price}`
    );
  }

  const quantity =
    Number(
      (
        dcaNotional /
        price
      ).toFixed(8)
    );

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `Không tính được quantity DCA hợp lệ: ${quantity}`
    );
  }

  const roeText =
    openPosition
      ? ` | ROE ${openPosition.roePct.toFixed(2)}%`
      : "";

  return {
    ...decision,

    isDca:
      true,

    quantity,

    notional:
      dcaNotional,

    marginUsed:
      dcaMarginUsdt,

    leverage,

    rr:
      toNumber(
        activeTrade?.rr,
        decision?.rr
      ),

    signal: {
      ...decision.signal,

      signal:
        activeTrade.direction,

      entry:
        price,

      entry1:
        price,

      entry2:
        toNumber(
          activeTrade.entry2
        ),

      stopLoss:
        toNumber(
          activeTrade.stop_loss
        ),

      takeProfit1:
        toNumber(
          activeTrade.take_profit1
        ),

      takeProfit2:
        toNumber(
          activeTrade.take_profit2
        ),

      reason:
        `${decision.signal.reason || ""}` +
        ` | DCA trade #${activeTrade.id}` +
        roeText,

      riskNote:
        `${decision.signal.riskNote || ""}` +
        ` | DCA tại vùng Entry 2 của lệnh gốc`
    }
  };
}

async function evaluateActiveTrade(
  decision,
  snapshot,
  activeTrade,
  mode
) {
  const signalDirection =
    String(
      decision?.signal?.signal || ""
    )
      .trim()
      .toUpperCase();

  if (
    signalDirection !==
    activeTrade.direction
  ) {
    return {
      action:
        "SKIP",

      decision,
      activeTrade,
      openPosition:
        null,

      message:
        `Đang có trade #${activeTrade.id} ` +
        `${activeTrade.direction} chưa TP2/SL. ` +
        `Tín hiệu mới ${signalDirection} bị chặn.`
    };
  }

  if (
    activeTrade.status === "TP1_HIT"
  ) {
    return {
      action:
        "SKIP",

      decision,
      activeTrade,
      openPosition:
        null,

      message:
        `Trade #${activeTrade.id} đã đạt TP1 ` +
        `và đang chờ TP2 hoặc SL. ` +
        `Không call mới và không DCA.`
    };
  }

  if (!CONFIG.allowDca) {
    return {
      action:
        "SKIP",

      decision,
      activeTrade,
      openPosition:
        null,

      message:
        `Đang có trade #${activeTrade.id} ` +
        `${activeTrade.direction} active. ` +
        `DCA đang tắt nên không call thêm.`
    };
  }

  const dcaCount =
    toNumber(
      activeTrade.dca_count,
      0
    );

  const maxDcaCount =
    Math.max(
      0,
      Number(
        CONFIG.maxDcaCount || 0
      )
    );

  if (
    dcaCount >=
    maxDcaCount
  ) {
    return {
      action:
        "SKIP",

      decision,
      activeTrade,
      openPosition:
        null,

      message:
        `Trade #${activeTrade.id} đã DCA ` +
        `${dcaCount}/${maxDcaCount} lần.`
    };
  }

  const lastDcaAt =
    activeTrade.last_dca_at
      ? new Date(
          activeTrade.last_dca_at
        ).getTime()
      : null;

  if (
    lastDcaAt &&
    Number.isFinite(
      lastDcaAt
    )
  ) {
    const elapsedSeconds =
      (
        Date.now() -
        lastDcaAt
      ) / 1000;

    const minSecondsBetweenDca =
      Math.max(
        0,
        Number(
          CONFIG.minSecondsBetweenDca ||
          0
        )
      );

    if (
      elapsedSeconds <
      minSecondsBetweenDca
    ) {
      const remainingSeconds =
        Math.ceil(
          minSecondsBetweenDca -
          elapsedSeconds
        );

      return {
        action:
          "SKIP",

        decision,
        activeTrade,
        openPosition:
          null,

        message:
          `Trade #${activeTrade.id} đang cooldown DCA, ` +
          `còn ${remainingSeconds} giây.`
      };
    }
  }

  const currentPrice =
    getCurrentPrice(snapshot);

  const entry2Check =
    checkEntry2Proximity(
      activeTrade,
      currentPrice
    );

  if (
    !entry2Check.allowed
  ) {
    return {
      action:
        "SKIP",

      decision,
      activeTrade,
      openPosition:
        null,

      message:
        `Trade #${activeTrade.id}: ` +
        `${entry2Check.reason}`
    };
  }

  let openPosition = null;

  if (
    mode !== "SIGNAL_ONLY"
  ) {
    openPosition =
      await getOpenPosition(
        activeTrade.symbol
      );

    if (!openPosition) {
      return {
        action:
          "SKIP",

        decision,
        activeTrade,
        openPosition:
          null,

        message:
          `DB đang có trade #${activeTrade.id} active ` +
          `nhưng BingX không có vị thế mở. ` +
          `Bot không tạo lệnh mới để tránh spam.`
      };
    }

    if (
      !isSameDirection(
        openPosition,
        activeTrade.direction
      )
    ) {
      return {
        action:
          "SKIP",

        decision,
        activeTrade,
        openPosition,

        message:
          `Trade DB là ${activeTrade.direction} ` +
          `nhưng vị thế BingX khác hướng. ` +
          `Không DCA tự động.`
      };
    }

    const dcaTriggerRoePct =
      Number(
        CONFIG.dcaTriggerRoePct || 0
      );

    if (
      openPosition.roePct >
      dcaTriggerRoePct
    ) {
      return {
        action:
          "SKIP",

        decision,
        activeTrade,
        openPosition,

        message:
          `Trade #${activeTrade.id} đang active. ` +
          `ROE ${openPosition.roePct.toFixed(2)}% ` +
          `chưa đạt ngưỡng DCA ${dcaTriggerRoePct}%.`
      };
    }
  }

  return {
    action:
      "DCA",

    decision:
      buildDcaDecision(
        decision,
        activeTrade,
        currentPrice,
        openPosition
      ),

    activeTrade,
    openPosition,
    entry2Check,

    message:
      `Cho phép DCA trade #${activeTrade.id} ` +
      `tại vùng Entry 2.`
  };
}

async function prepareDatabaseTradeAction(
  decision,
  snapshot,
  mode
) {
  const symbol =
    getSymbol(snapshot);

  const activeTrade =
    await getActiveTradeBySymbol(
      symbol
    );

  if (activeTrade) {
    return evaluateActiveTrade(
      decision,
      snapshot,
      activeTrade,
      mode
    );
  }

  const created =
    await createTradeRecord(
      decision,
      snapshot,
      {
        source:
          "EXECUTOR",

        executionMode:
          mode
      }
    );

  if (!created.created) {
    return {
      action:
        "SKIP",

      decision,

      trade:
        created.trade || null,

      activeTrade:
        created.trade || null,

      isNewTrade:
        false,

      message:
        created.reason ||
        "DB đã chặn vì có trade active"
    };
  }

  return {
    action:
      "NEW_ENTRY",

    decision: {
      ...decision,

      isDca:
        false
    },

    trade:
      created.trade,

    isNewTrade:
      true,

    message:
      `Đã tạo trade #${created.trade.id}`
  };
}

async function legacyPositionGuard(
  decision,
  snapshot,
  mode
) {
  if (
    mode === "SIGNAL_ONLY"
  ) {
    return {
      action:
        "NEW_ENTRY",

      decision: {
        ...decision,

        isDca:
          false
      },

      trade:
        null,

      isNewTrade:
        false,

      openPosition:
        null,

      message:
        "DB đang tắt nên không thể khóa call bằng lịch sử lâu dài."
    };
  }

  const symbol =
    getSymbol(snapshot);

  const openPosition =
    await getOpenPosition(
      symbol
    );

  if (!openPosition) {
    return {
      action:
        "NEW_ENTRY",

      decision: {
        ...decision,

        isDca:
          false
      },

      trade:
        null,

      isNewTrade:
        false,

      openPosition:
        null,

      message:
        null
    };
  }

  return {
    action:
      "SKIP",

    decision,
    trade:
      null,

    isNewTrade:
      false,

    openPosition,

    message:
      `Đang có vị thế ${
        openPosition.positionSide ||
        "không rõ hướng"
      }. ` +
      `Bật TRADE_DB_ENABLED=true để quản lý DCA và chống spam chính xác.`
  };
}

function createNotExecutedResult(
  reason,
  extra = {},
  mode = getExecutionMode()
) {
  return {
    executed:
      false,

    isDca:
      false,

    mode,
    reason,
    ...extra
  };
}

async function startCommunityTelegram(
  decision,
  snapshot,
  tradeContext
) {
  try {
    const result =
      await sendCommunitySignalToTelegram(
        decision,
        snapshot
      );

    console.log(
      "Telegram community:",
      result
    );

    const tradeId =
      tradeContext?.trade?.id ||
      tradeContext?.activeTrade?.id ||
      null;

    if (
      tradeId &&
      isTradeRepositoryEnabled()
    ) {
      if (
        tradeContext?.isNewTrade
      ) {
        await updateTradeTelegramResult(
          tradeId,
          result
        );
      } else if (
        decision.isDca
      ) {
        await recordTradeEvent(
          tradeId,
          "DCA_SIGNAL_PUBLISHED",
          {
            eventPrice:
              decision.signal.entry1 ??
              decision.signal.entry,

            quantity:
              decision.quantity,

            notional:
              decision.notional,

            metadata: {
              telegram:
                result
            }
          }
        );
      }
    }

    return result;
  } catch (error) {
    const errorMessage =
      error.response?.data?.description ||
      error.response?.data ||
      error.message ||
      String(error);

    console.error(
      "Telegram gửi call lỗi:",
      errorMessage
    );

    return {
      sent:
        false,

      messageId:
        null,

      fbt:
        null,

      cdt:
        null,

      error:
        errorMessage
    };
  }
}

function parseBingxOrderResponse(
  response,
  decision,
  sideInfo,
  symbol
) {
  const order =
    response?.order ||
    response?.data?.order ||
    response?.data ||
    response;

  const orderId =
    order?.orderId ||
    order?.orderID ||
    order?.clientOrderId ||
    order?.clientOrderID ||
    null;

  const status =
    order?.status ||
    response?.status ||
    null;

  if (
    !orderId &&
    !status
  ) {
    throw new Error(
      `Không xác nhận được order response: ${JSON.stringify(response)}`
    );
  }

  const executedQuantity =
    Number(
      order?.executedQty ??
      order?.quantity ??
      decision.quantity
    );

  const executedEntry =
    Number(
      order?.avgPrice ??
      order?.price ??
      decision.signal.entry1 ??
      decision.signal.entry
    );

  const executedNotional =
    Number.isFinite(
      executedQuantity
    ) &&
    Number.isFinite(
      executedEntry
    ) &&
    executedQuantity > 0 &&
    executedEntry > 0
      ? executedQuantity *
        executedEntry
      : Number(
          decision.notional
        );

  return {
    order,
    orderId,
    status,
    executedQuantity,
    executedEntry,
    executedNotional,

    symbol:
      order?.symbol ||
      symbol,

    side:
      order?.side ||
      sideInfo.side,

    positionSide:
      order?.positionSide ||
      sideInfo.positionSide
  };
}

async function persistSuccessfulDca(
  tradeContext,
  parsed,
  decision,
  mode
) {
  const activeTrade =
    tradeContext?.activeTrade ||
    tradeContext?.trade;

  if (
    !decision.isDca ||
    !activeTrade?.id ||
    !isTradeRepositoryEnabled()
  ) {
    return null;
  }

  return recordTradeDca(
    activeTrade.id,
    {
      entryPrice:
        parsed.executedEntry,

      quantity:
        parsed.executedQuantity,

      notional:
        parsed.executedNotional,

      metadata: {
        executionMode:
          mode,

        orderId:
          parsed.orderId,

        status:
          parsed.status
      }
    }
  );
}

async function executeBingxMarketOrder(
  decision,
  snapshot,
  mode,
  tradeContext
) {
  const symbol =
    getSymbol(snapshot);

  const sideInfo =
    sideFor(
      decision.signal.signal
    );

  const tpSlParams =
    buildTpSlParams(
      decision,
      snapshot
    );

  const telegramPromise =
    startCommunityTelegram(
      decision,
      snapshot,
      tradeContext
    );

  let response;

  try {
    await setLeverageBeforeOrder(
      decision,
      symbol
    );

    response =
      await fetchSigned(
        "POST",
        "/openApi/swap/v2/trade/order",
        {
          symbol,

          side:
            sideInfo.side,

          positionSide:
            sideInfo.positionSide,

          type:
            "MARKET",

          quantity:
            decision.quantity,

          clientOrderId:
            clientOrderId(
              symbol,
              mode
            ),

          ...tpSlParams
        }
      );
  } catch (error) {
    const telegramResult =
      await telegramPromise;

    const tradeId =
      tradeContext?.trade?.id ||
      tradeContext?.activeTrade?.id ||
      null;

    if (
      tradeId &&
      isTradeRepositoryEnabled()
    ) {
      await recordTradeEvent(
        tradeId,
        "ORDER_FAILED",
        {
          eventPrice:
            decision.signal.entry1 ??
            decision.signal.entry,

          quantity:
            decision.quantity,

          notional:
            decision.notional,

          metadata: {
            executionMode:
              mode,

            isDca:
              Boolean(
                decision.isDca
              ),

            telegram:
              telegramResult,

            error:
              error.response?.data ||
              error.message ||
              String(error)
          }
        }
      );

      if (
        tradeContext?.isNewTrade &&
        telegramResult?.sent !== true
      ) {
        await markTradeCancelled(
          tradeId,
          "Telegram và BingX đều thất bại"
        );
      }
    }

    throw error;
  }

  const telegramResult =
    await telegramPromise;

  if (
    hasBingxApiError(
      response
    )
  ) {
    const bingxError =
      response?.msg ||
      response?.message ||
      JSON.stringify(response);

    const tradeId =
      tradeContext?.trade?.id ||
      tradeContext?.activeTrade?.id ||
      null;

    if (
      tradeId &&
      isTradeRepositoryEnabled()
    ) {
      await recordTradeEvent(
        tradeId,
        "ORDER_REJECTED",
        {
          eventPrice:
            decision.signal.entry1 ??
            decision.signal.entry,

          quantity:
            decision.quantity,

          notional:
            decision.notional,

          metadata: {
            executionMode:
              mode,

            isDca:
              Boolean(
                decision.isDca
              ),

            telegram:
              telegramResult,

            bingxError
          }
        }
      );

      if (
        tradeContext?.isNewTrade &&
        telegramResult?.sent !== true
      ) {
        await markTradeCancelled(
          tradeId,
          "Telegram thất bại và BingX từ chối order"
        );
      }
    }

    throw new Error(
      `Gửi ${mode} lỗi: ${bingxError}`
    );
  }

  const parsed =
    parseBingxOrderResponse(
      response,
      decision,
      sideInfo,
      symbol
    );

  const tradeId =
    tradeContext?.trade?.id ||
    tradeContext?.activeTrade?.id ||
    null;

  if (
    tradeId &&
    isTradeRepositoryEnabled()
  ) {
    if (
      decision.isDca
    ) {
      await persistSuccessfulDca(
        tradeContext,
        parsed,
        decision,
        mode
      );
    } else {
      await recordTradeEvent(
        tradeId,
        "ORDER_EXECUTED",
        {
          eventPrice:
            parsed.executedEntry,

          quantity:
            parsed.executedQuantity,

          notional:
            parsed.executedNotional,

          metadata: {
            executionMode:
              mode,

            orderId:
              parsed.orderId,

            status:
              parsed.status,

            side:
              parsed.side,

            positionSide:
              parsed.positionSide
          }
        }
      );
    }
  }

  const currentState =
    getSymbolState(
      symbol
    );

  updateSymbolState(
    symbol,
    {
      lastOrderAt:
        Date.now(),

      lastExecutionMode:
        mode,

      lastSignal:
        decision.signal.signal,

      lastOrderId:
        parsed.orderId,

      lastStatus:
        parsed.status,

      lastEntry:
        parsed.executedEntry,

      lastStopLoss:
        decision.signal.stopLoss,

      lastTakeProfit1:
        decision.signal.takeProfit1,

      lastTakeProfit2:
        decision.signal.takeProfit2,

      lastQuantity:
        parsed.executedQuantity,

      lastNotional:
        parsed.executedNotional,

      lastMarginUsed:
        decision.marginUsed ||
        null,

      dcaCount:
        decision.isDca
          ? Number(
              currentState.dcaCount ||
              0
            ) + 1
          : 0,

      lastDcaAt:
        decision.isDca
          ? Date.now()
          : currentState.lastDcaAt ||
            null
    }
  );

  return {
    executed:
      true,

    isDca:
      Boolean(
        decision.isDca
      ),

    mode,
    tradeId,

    orderId:
      parsed.orderId,

    status:
      parsed.status,

    symbol:
      parsed.symbol,

    signal:
      decision.signal.signal,

    side:
      parsed.side,

    positionSide:
      parsed.positionSide,

    entry:
      parsed.executedEntry,

    entry1:
      Number(
        decision.signal.entry1 ??
        decision.signal.entry
      ),

    entry2:
      toNumber(
        decision.signal.entry2
      ),

    stopLoss:
      Number(
        decision.signal.stopLoss
      ),

    takeProfit1:
      Number(
        decision.signal.takeProfit1
      ),

    takeProfit2:
      Number(
        decision.signal.takeProfit2
      ),

    quantity:
      parsed.executedQuantity,

    notional:
      parsed.executedNotional,

    marginUsed:
      Number(
        decision.marginUsed ||
        0
      ),

    leverage:
      Number(
        decision.leverage ||
        CONFIG.maxLeverage
      ),

    rr:
      Number(
        decision.rr ||
        0
      ),

    reason:
      decision.signal.reason ||
      "",

    riskNote:
      decision.signal.riskNote ||
      "",

    telegram:
      telegramResult
  };
}

async function executeSignalOnly(
  decision,
  snapshot,
  tradeContext
) {
  const symbol =
    getSymbol(snapshot);

  const telegramResult =
    await startCommunityTelegram(
      decision,
      snapshot,
      tradeContext
    );

  const tradeId =
    tradeContext?.trade?.id ||
    tradeContext?.activeTrade?.id ||
    null;

  if (
    telegramResult?.sent !== true &&
    tradeContext?.isNewTrade &&
    tradeId &&
    isTradeRepositoryEnabled()
  ) {
    await markTradeCancelled(
      tradeId,
      "Không gửi được tín hiệu Telegram"
    );
  }

  if (
    decision.isDca &&
    telegramResult?.sent === true &&
    tradeId &&
    isTradeRepositoryEnabled()
  ) {
    await recordTradeDca(
      tradeId,
      {
        entryPrice:
          decision.signal.entry1 ??
          decision.signal.entry,

        quantity:
          decision.quantity,

        notional:
          decision.notional,

        metadata: {
          executionMode:
            "SIGNAL_ONLY",

          telegram:
            telegramResult
        }
      }
    );
  }

  return {
    executed:
      false,

    signalPublished:
      telegramResult?.sent === true,

    isDca:
      Boolean(
        decision.isDca
      ),

    mode:
      "SIGNAL_ONLY",

    symbol,
    tradeId,

    reason:
      decision.isDca
        ? `Đã xử lý call DCA cho trade #${tradeId}.`
        : `Đã xử lý tín hiệu cho trade #${tradeId}, không gửi order.`,

    telegram:
      telegramResult
  };
}

async function executeTestOrder(
  decision,
  snapshot
) {
  const symbol =
    getSymbol(snapshot);

  const sideInfo =
    sideFor(
      decision.signal.signal
    );

  const tpSlParams =
    buildTpSlParams(
      decision,
      snapshot
    );

  const response =
    await fetchSigned(
      "POST",
      "/openApi/swap/v2/trade/order/test",
      {
        symbol,

        side:
          sideInfo.side,

        positionSide:
          sideInfo.positionSide,

        type:
          "MARKET",

        quantity:
          decision.quantity,

        clientOrderId:
          clientOrderId(
            symbol,
            "TEST_ORDER"
          ),

        ...tpSlParams
      }
    );

  if (
    hasBingxApiError(
      response
    )
  ) {
    throw new Error(
      `Gửi TEST_ORDER lỗi: ${
        response?.msg ||
        response?.message ||
        JSON.stringify(response)
      }`
    );
  }

  return {
    executed:
      false,

    testSent:
      true,

    isDca:
      false,

    mode:
      "TEST_ORDER",

    symbol,

    reason:
      "Đã gửi test order, không tạo trade DB và không đăng Telegram.",

    response
  };
}

export async function executeDecision(
  decision,
  snapshot,
  allowVstOrder = false
) {
  const mode =
    getExecutionMode();

  const bingxEnv =
    getBingxEnv();

  const symbol =
    getSymbol(snapshot);

  console.log(
    `Executor mode: ${mode} | ` +
    `BingX env: ${bingxEnv} | ` +
    `Symbol: ${symbol}`
  );

  if (
    !decision?.approved
  ) {
    return createNotExecutedResult(
      decision?.reasons?.length
        ? decision.reasons.join("; ")
        : "Decision không được duyệt",
      {
        symbol
      },
      mode
    );
  }

  const supportedModes = [
    "SIGNAL_ONLY",
    "TEST_ORDER",
    "VST_ORDER",
    "USDT_ORDER"
  ];

  if (
    !supportedModes.includes(
      mode
    )
  ) {
    return createNotExecutedResult(
      `Execution mode không hỗ trợ: ${mode}`,
      {
        symbol
      },
      mode
    );
  }

  if (
    mode === "VST_ORDER"
  ) {
    if (!allowVstOrder) {
      return createNotExecutedResult(
        "Thiếu flag --allow-vst-order",
        {
          symbol
        },
        mode
      );
    }

    if (
      bingxEnv !== "prod-vst"
    ) {
      return createNotExecutedResult(
        `VST_ORDER chỉ chạy khi ` +
        `BINGX_ENV=prod-vst. ` +
        `Hiện tại: ${
          bingxEnv ||
          "(trống)"
        }`,
        {
          symbol
        },
        mode
      );
    }
  }

  if (
    mode === "USDT_ORDER" &&
    bingxEnv !== "prod-live"
  ) {
    return createNotExecutedResult(
      `USDT_ORDER chỉ chạy khi ` +
      `BINGX_ENV=prod-live. ` +
      `Hiện tại: ${
        bingxEnv ||
        "(trống)"
      }`,
      {
        symbol
      },
      mode
    );
  }

  if (
    mode === "TEST_ORDER"
  ) {
    return executeTestOrder(
      decision,
      snapshot
    );
  }

  const tradeContext =
    isTradeRepositoryEnabled()
      ? await prepareDatabaseTradeAction(
          decision,
          snapshot,
          mode
        )
      : await legacyPositionGuard(
          decision,
          snapshot,
          mode
        );

  if (
    tradeContext.action === "SKIP"
  ) {
    console.log(
      "Trade guard chặn:",
      tradeContext.message
    );

    return createNotExecutedResult(
      tradeContext.message ||
      "Đang có trade active, không call thêm.",
      {
        symbol,

        activeTrade:
          tradeContext.activeTrade ||
          tradeContext.trade ||
          null,

        openPosition:
          tradeContext.openPosition ||
          null
      },
      mode
    );
  }

  decision =
    tradeContext.decision ||
    decision;

  if (
    tradeContext.action === "DCA"
  ) {
    console.log(
      "DCA GUARD:",
      tradeContext.message
    );
  }

  if (
    mode === "SIGNAL_ONLY"
  ) {
    return executeSignalOnly(
      decision,
      snapshot,
      tradeContext
    );
  }

  return executeBingxMarketOrder(
    decision,
    snapshot,
    mode,
    tradeContext
  );
}
