import { CONFIG } from './config.js';
import { fetchSigned } from './bingxClient.js';
import {
  getSymbolState,
  updateSymbolState
} from './state.js';
import {
  sendCommunitySignalToTelegram
} from './telegram.js';

/**
 * Chuẩn hóa execution mode.
 */
function getExecutionMode() {
  return String(CONFIG.executionMode || '')
    .trim()
    .toUpperCase();
}

/**
 * Chuẩn hóa môi trường BingX.
 */
function getBingxEnv() {
  return String(CONFIG.bingxEnv || '')
    .trim()
    .toLowerCase();
}

/**
 * Kiểm tra BingX có trả lỗi API không.
 */
function hasBingxApiError(response) {
  return (
    response?.code !== undefined &&
    response?.code !== 0 &&
    response?.code !== '0'
  );
}

/**
 * Chuyển tín hiệu AI thành side cho Hedge Mode.
 */
function sideFor(signal) {
  const normalized = String(signal || '')
    .trim()
    .toUpperCase();

  if (normalized === 'LONG') {
    return {
      side: 'BUY',
      positionSide: 'LONG'
    };
  }

  if (normalized === 'SHORT') {
    return {
      side: 'SELL',
      positionSide: 'SHORT'
    };
  }

  throw new Error(
    `Signal không hợp lệ: ${signal}`
  );
}

/**
 * Tạo clientOrderId riêng.
 */
function clientOrderId(symbol, mode) {
  const prefix =
    mode === 'USDT_ORDER'
      ? 'ai-live'
      : mode === 'VST_ORDER'
        ? 'ai-vst'
        : 'ai-test';

  return `${prefix}-${String(symbol || '')
    .replace('-', '')
    .toLowerCase()}-${Date.now()}`.slice(0, 40);
}

/**
 * Làm tròn giá.
 */
function roundPrice(value, precision = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const multiplier = Math.pow(
    10,
    precision
  );

  return (
    Math.round(number * multiplier) /
    multiplier
  );
}

/**
 * Tạo tham số TP/SL gửi kèm lệnh MARKET.
 */
function buildTpSlParams(
  decision,
  snapshot
) {
  const signal =
    decision?.signal || {};

  const signalSide = String(
    signal.signal || ''
  )
    .trim()
    .toUpperCase();

  const pricePrecision = Number(
    snapshot?.contract?.pricePrecision ?? 2
  );

  const entry = Number(
    signal.entry
  );

  const stopLoss = roundPrice(
    signal.stopLoss,
    pricePrecision
  );

  const takeProfit1 = roundPrice(
    signal.takeProfit1,
    pricePrecision
  );

  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    throw new Error(
      `Entry không hợp lệ: ${signal.entry}`
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

  if (signalSide === 'LONG') {
    if (
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
  } else if (
    signalSide === 'SHORT'
  ) {
    if (
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
  } else {
    throw new Error(
      `Không thể tạo TP/SL cho signal: ` +
      `${signal.signal}`
    );
  }

  return {
    takeProfit: JSON.stringify({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: takeProfit1,
      price: takeProfit1,
      workingType: 'MARK_PRICE'
    }),

    stopLoss: JSON.stringify({
      type: 'STOP_MARKET',
      stopPrice: stopLoss,
      price: stopLoss,
      workingType: 'MARK_PRICE'
    })
  };
}

/**
 * Set leverage trước khi gửi order.
 */
async function setLeverageBeforeOrder(
  decision
) {
  const leverage = Number(
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

  const signal = String(
    decision?.signal?.signal || ''
  )
    .trim()
    .toUpperCase();

  const side =
    signal === 'LONG'
      ? 'LONG'
      : signal === 'SHORT'
        ? 'SHORT'
        : 'ALL';

  const params = {
    symbol: CONFIG.symbol,
    leverage,
    side
  };

  console.log(
    'Đang set leverage trước khi gửi lệnh:',
    params
  );

  const response = await fetchSigned(
    'POST',
    '/openApi/swap/v2/trade/leverage',
    params
  );

  console.log(
    'Set leverage response:',
    JSON.stringify(
      response,
      null,
      2
    )
  );

  if (hasBingxApiError(response)) {
    throw new Error(
      `Set leverage lỗi: ${
        response?.msg ||
        response?.message ||
        JSON.stringify(response)
      }`
    );
  }

  const returnedLeverage = Number(
    response?.leverage ??
    response?.data?.leverage ??
    response?.data?.longLeverage ??
    response?.data?.shortLeverage ??
    leverage
  );

  console.log(
    `Set leverage OK: x${returnedLeverage}`
  );

  return response;
}

/**
 * Lấy vị thế đang mở.
 */
async function getOpenPosition(
  symbol = CONFIG.symbol
) {
  const response = await fetchSigned(
    'GET',
    '/openApi/swap/v2/user/positions',
    {
      symbol
    }
  );

  if (hasBingxApiError(response)) {
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
        : Array.isArray(
            response?.positions
          )
          ? response.positions
          : [];

  const openedPosition =
    positions.find(position => {
      const quantity = Math.abs(
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
    });

  if (!openedPosition) {
    return null;
  }

  const positionAmt = Number(
    openedPosition.positionAmt ??
    openedPosition.positionAmount ??
    openedPosition.availableAmt ??
    openedPosition.positionSize ??
    openedPosition.quantity ??
    0
  );

  const avgPrice = Number(
    openedPosition.avgPrice ??
    openedPosition.averagePrice ??
    openedPosition.entryPrice ??
    0
  );

  const markPrice = Number(
    openedPosition.markPrice ??
    openedPosition.currentPrice ??
    openedPosition.lastPrice ??
    0
  );

  const unrealizedProfit = Number(
    openedPosition.unrealizedProfit ??
    openedPosition.unrealizedPnl ??
    openedPosition.pnl ??
    0
  );

  const leverage = Number(
    openedPosition.leverage ??
    CONFIG.maxLeverage ??
    1
  );

  const currentPrice =
    markPrice || avgPrice;

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

    positionSide: String(
      openedPosition.positionSide || ''
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
    raw: openedPosition
  };
}

/**
 * Kiểm tra tín hiệu có cùng hướng
 * với vị thế hiện tại không.
 */
function isSameDirection(
  openPosition,
  signal
) {
  if (!openPosition) {
    return false;
  }

  const normalized = String(
    signal || ''
  )
    .trim()
    .toUpperCase();

  if (normalized === 'LONG') {
    return (
      openPosition.positionSide ===
        'LONG' ||
      (
        !openPosition.positionSide &&
        openPosition.positionAmt > 0
      )
    );
  }

  if (normalized === 'SHORT') {
    return (
      openPosition.positionSide ===
        'SHORT' ||
      (
        !openPosition.positionSide &&
        openPosition.positionAmt < 0
      )
    );
  }

  return false;
}

/**
 * Tạo decision cho DCA.
 */
function buildDcaDecision(
  decision,
  openPosition
) {
  const dcaMarginUsdt = Number(
    CONFIG.dcaMarginUsdt || 0
  );

  const leverage = Number(
    decision?.leverage ||
    CONFIG.maxLeverage ||
    1
  );

  const dcaNotional =
    dcaMarginUsdt * leverage;

  const price = Number(
    openPosition.markPrice ||
    openPosition.avgPrice ||
    decision?.signal?.entry
  );

  if (
    !Number.isFinite(dcaNotional) ||
    dcaNotional <= 0
  ) {
    throw new Error(
      `DCA notional không hợp lệ: ` +
      `${dcaNotional}`
    );
  }

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `Không tính được giá DCA hợp lệ: ` +
      `${price}`
    );
  }

  const quantity = Number(
    (
      dcaNotional /
      price
    ).toFixed(4)
  );

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `Không tính được quantity DCA hợp lệ: ` +
      `${quantity}`
    );
  }

  return {
    ...decision,

    isDca: true,
    quantity,
    notional: dcaNotional,
    marginUsed: dcaMarginUsdt,
    leverage,

    signal: {
      ...decision.signal,

      entry: price,

      reason:
        `${decision.signal.reason || ''}` +
        ` | DCA vì ROE ` +
        `${openPosition.roePct.toFixed(2)}%` +
        ` <= ${CONFIG.dcaTriggerRoePct}%`
    }
  };
}

/**
 * Kiểm tra vị thế và DCA.
 */
async function checkPositionAndDcaGuard(
  decision
) {
  const openPosition =
    await getOpenPosition(
      CONFIG.symbol
    );

  if (!openPosition) {
    return {
      action: 'NEW_ENTRY',

      decision: {
        ...decision,
        isDca: false
      },

      openPosition: null,
      message: null
    };
  }

  const symbolState =
    getSymbolState(
      CONFIG.symbol
    );

  const sameDirection =
    isSameDirection(
      openPosition,
      decision.signal.signal
    );

  if (!sameDirection) {
    return {
      action: 'SKIP',
      decision,
      openPosition,

      message:
        `Đang có vị thế ` +
        `${openPosition.positionSide || 'không rõ hướng'}, ` +
        `nhưng tín hiệu mới là ` +
        `${decision.signal.signal}. ` +
        `Bot không đảo chiều tự động.`
    };
  }

  if (!CONFIG.allowDca) {
    return {
      action: 'SKIP',
      decision,
      openPosition,

      message:
        `Đang có vị thế mở ` +
        `${openPosition.positionSide}. ` +
        `DCA đang tắt nên không vào thêm.`
    };
  }

  const dcaCount = Number(
    symbolState.dcaCount || 0
  );

  const maxDcaCount = Number(
    CONFIG.maxDcaCount || 0
  );

  if (
    dcaCount >=
    maxDcaCount
  ) {
    return {
      action: 'SKIP',
      decision,
      openPosition,

      message:
        `Đang có vị thế mở. ` +
        `Đã DCA ${dcaCount}/` +
        `${maxDcaCount} lần, ` +
        `không DCA thêm.`
    };
  }

  if (symbolState.lastDcaAt) {
    const elapsedSeconds =
      (
        Date.now() -
        symbolState.lastDcaAt
      ) / 1000;

    const minSecondsBetweenDca =
      Number(
        CONFIG.minSecondsBetweenDca ||
        0
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
        action: 'SKIP',
        decision,
        openPosition,

        message:
          `Đang có vị thế mở. ` +
          `DCA cooldown còn ` +
          `${remainingSeconds} giây.`
      };
    }
  }

  const dcaTriggerRoePct =
    Number(
      CONFIG.dcaTriggerRoePct ||
      0
    );

  if (
    openPosition.roePct >
    dcaTriggerRoePct
  ) {
    return {
      action: 'SKIP',
      decision,
      openPosition,

      message:
        `Đang có vị thế mở ` +
        `${openPosition.positionSide}, ` +
        `ROE ${openPosition.roePct.toFixed(2)}% ` +
        `chưa âm đủ để DCA.`
    };
  }

  return {
    action: 'DCA',

    decision:
      buildDcaDecision(
        decision,
        openPosition
      ),

    openPosition,

    message:
      `Cho phép DCA vì ROE ` +
      `${openPosition.roePct.toFixed(2)}% ` +
      `<= ${dcaTriggerRoePct}%.`
  };
}

/**
 * Kết quả không gửi order.
 */
function createNotExecutedResult(
  reason,
  extra = {},
  mode = getExecutionMode()
) {
  return {
    executed: false,
    isDca: false,
    mode,
    reason,
    ...extra
  };
}

/**
 * Gửi Telegram độc lập với BingX.
 */
function startCommunityTelegram(
  decision,
  snapshot
) {
  return sendCommunitySignalToTelegram(
    decision,
    snapshot
  )
    .then(result => {
      console.log(
        'Telegram community:',
        result
      );

      return result;
    })
    .catch(error => {
      const errorMessage =
        error.response?.data
          ?.description ||
        error.response?.data ||
        error.message ||
        String(error);

      console.error(
        'Telegram gửi call lỗi:',
        errorMessage
      );

      return {
        sent: false,
        messageId: null,
        error: errorMessage
      };
    });
}

/**
 * Đọc response order BingX.
 */
function parseBingxOrderResponse(
  response,
  decision,
  sideInfo
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
      `Không xác nhận được order response: ` +
      `${JSON.stringify(response)}`
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
      ? (
          executedQuantity *
          executedEntry
        )
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
      CONFIG.symbol,

    side:
      order?.side ||
      sideInfo.side,

    positionSide:
      order?.positionSide ||
      sideInfo.positionSide
  };
}

/**
 * Gửi USDT_ORDER hoặc VST_ORDER.
 */
async function executeBingxMarketOrder(
  decision,
  snapshot,
  mode
) {
  const sideInfo =
    sideFor(
      decision.signal.signal
    );

  const tpSlParams =
    buildTpSlParams(
      decision,
      snapshot
    );

  /*
   * Telegram bắt đầu gửi ngay,
   * không chờ BingX.
   */
  const telegramPromise =
    startCommunityTelegram(
      decision,
      snapshot
    );

  let response;
/*await getApiAccountBalance();*/
  try {
    await setLeverageBeforeOrder(
      decision
    );

    const params = {
      symbol: CONFIG.symbol,

      side:
        sideInfo.side,

      positionSide:
        sideInfo.positionSide,

      type: 'MARKET',

      quantity:
        decision.quantity,

      clientOrderId:
        clientOrderId(
          CONFIG.symbol,
          mode
        ),

      ...tpSlParams
    };

    console.log(
      decision.isDca
        ? `Đang gửi lệnh DCA ${mode} kèm TP/SL:`
        : `Đang gửi ${mode} kèm TP/SL:`,
      params
    );

    response = await fetchSigned(
      'POST',
      '/openApi/swap/v2/trade/order',
      params
    );
  } catch (error) {
    const telegramResult =
      await telegramPromise;

    console.error(
      `BingX gửi ${mode} lỗi:`,
      error.response?.data ||
      error.message ||
      String(error)
    );

    console.log(
      'Telegram vẫn giữ nguyên:',
      telegramResult
    );

    throw error;
  }

  const telegramResult =
    await telegramPromise;

  console.log(
    `${mode} response:`,
    JSON.stringify(
      response,
      null,
      2
    )
  );

  if (hasBingxApiError(response)) {
    const bingxError =
      response?.msg ||
      response?.message ||
      JSON.stringify(response);

    console.error(
      `BingX từ chối ${mode}:`,
      bingxError
    );

    throw new Error(
      `Gửi ${mode} lỗi: ` +
      `${bingxError}`
    );
  }

  const parsed =
    parseBingxOrderResponse(
      response,
      decision,
      sideInfo
    );

  console.log(
    'Order OK:',
    {
      mode,

      orderId:
        parsed.orderId,

      status:
        parsed.status,

      symbol:
        parsed.symbol,

      side:
        parsed.side,

      positionSide:
        parsed.positionSide,

      avgPrice:
        parsed.executedEntry,

      executedQty:
        parsed.executedQuantity,

      stopLoss:
        parsed.order?.stopLoss ||
        decision.signal.stopLoss,

      takeProfit:
        parsed.order?.takeProfit ||
        decision.signal.takeProfit1,

      isDca:
        Boolean(
          decision.isDca
        ),

      telegram:
        telegramResult
    }
  );

  const currentState =
    getSymbolState(
      CONFIG.symbol
    );

  updateSymbolState(
    CONFIG.symbol,
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
          ? (
              Number(
                currentState.dcaCount ||
                0
              ) + 1
            )
          : 0,

      lastDcaAt:
        decision.isDca
          ? Date.now()
          : (
              currentState.lastDcaAt ||
              null
            )
    }
  );

  return {
    executed: true,

    isDca:
      Boolean(
        decision.isDca
      ),

    mode,

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
      '',

    riskNote:
      decision.signal.riskNote ||
      '',

    telegram: {
      sent:
        telegramResult?.sent ===
        true,

      messageId:
        telegramResult
          ?.messageId ||
        null
    },

    message:
      decision.isDca
        ? (
            `Đã đăng call DCA lên Telegram ` +
            `và xử lý ${mode} trên BingX.`
          )
        : (
            `Đã đăng call lên Telegram ` +
            `và xử lý ${mode} trên BingX.`
          )
  };
}

/**
 * Hàm xử lý chính.
 */
export async function executeDecision(
  decision,
  snapshot,
  allowVstOrder = false
) {
  const mode =
    getExecutionMode();

  const bingxEnv =
    getBingxEnv();

  console.log(
    `Executor mode: ${mode} | ` +
    `BingX env: ${bingxEnv}`
  );

  /*
   * AI hoặc risk chưa duyệt.
   */
  if (!decision?.approved) {
    return createNotExecutedResult(
      decision?.reasons?.length
        ? decision.reasons.join('; ')
        : 'Decision không được duyệt',
      {},
      mode
    );
  }

  /*
   * Chỉ gửi tín hiệu.
   */
  if (
    mode === 'SIGNAL_ONLY'
  ) {
    return createNotExecutedResult(
      'SIGNAL_ONLY: chỉ báo tín hiệu, không gửi order.',
      {},
      mode
    );
  }

  /*
   * Các mode được hỗ trợ.
   */
  const supportedModes = [
    'TEST_ORDER',
    'VST_ORDER',
    'USDT_ORDER'
  ];

  if (
    !supportedModes.includes(
      mode
    )
  ) {
    return createNotExecutedResult(
      `Execution mode không hỗ trợ: ` +
      `${mode}`,
      {},
      mode
    );
  }

  /*
   * Kiểm tra VST.
   */
  if (
    mode === 'VST_ORDER'
  ) {
    if (!allowVstOrder) {
      return createNotExecutedResult(
        'Thiếu flag --allow-vst-order',
        {},
        mode
      );
    }

    if (
      bingxEnv !== 'prod-vst'
    ) {
      return createNotExecutedResult(
        `VST_ORDER chỉ được chạy khi ` +
        `BINGX_ENV=prod-vst. ` +
        `Hiện tại: ` +
        `${bingxEnv || '(trống)'}`,
        {},
        mode
      );
    }
  }

  /*
   * Kiểm tra tiền thật USDT.
   */
  if (
    mode === 'USDT_ORDER' &&
    bingxEnv !== 'prod-live'
  ) {
    return createNotExecutedResult(
      `USDT_ORDER chỉ được chạy khi ` +
      `BINGX_ENV=prod-live. ` +
      `Hiện tại: ` +
      `${bingxEnv || '(trống)'}`,
      {},
      mode
    );
  }

  /*
   * Kiểm tra vị thế và DCA.
   */
  const guard =
    await checkPositionAndDcaGuard(
      decision
    );

  if (
    guard.action === 'SKIP'
  ) {
    return createNotExecutedResult(
      guard.message ||
      'Đang có vị thế mở, không vào thêm.',
      {
        openPosition:
          guard.openPosition ||
          null
      },
      mode
    );
  }

  decision =
    guard.decision;

  if (
    guard.action === 'DCA'
  ) {
    console.log(
      'DCA GUARD:',
      guard.message
    );
  }

  /*
   * Test order.
   */
  if (
    mode === 'TEST_ORDER'
  ) {
    const sideInfo =
      sideFor(
        decision.signal.signal
      );

    const tpSlParams =
      buildTpSlParams(
        decision,
        snapshot
      );

    const params = {
      symbol:
        CONFIG.symbol,

      side:
        sideInfo.side,

      positionSide:
        sideInfo.positionSide,

      type:
        'MARKET',

      quantity:
        decision.quantity,

      clientOrderId:
        clientOrderId(
          CONFIG.symbol,
          mode
        ),

      ...tpSlParams
    };

    console.log(
      'Đang gửi TEST_ORDER kèm TP/SL:',
      params
    );

    const response =
      await fetchSigned(
        'POST',
        '/openApi/swap/v2/trade/order/test',
        params
      );

    console.log(
      'TEST_ORDER response:',
      JSON.stringify(
        response,
        null,
        2
      )
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
      executed: false,

      testSent: true,

      isDca:
        Boolean(
          decision.isDca
        ),

      mode:
        'TEST_ORDER',

      reason:
        'Đã gửi test order, nhưng chưa tạo vị thế trên BingX.',

      response
    };
  }

  /*
   * USDT_ORDER và VST_ORDER
   * đều gửi vào endpoint đặt order.
   */
  return executeBingxMarketOrder(
    decision,
    snapshot,
    mode
  );
}
async function getApiAccountBalance() {
  const response = await fetchSigned(
    'GET',
    '/openApi/swap/v3/user/balance',
    {}
  );

  console.log(
    'API ACCOUNT BALANCE RAW:',
    JSON.stringify(response, null, 2)
  );

  return response;
}
