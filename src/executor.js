import { CONFIG } from './config.js';
import { fetchSigned } from './bingxClient.js';
import { getSymbolState, updateSymbolState } from './state.js';

function sideFor(signal) {
  if (signal === 'LONG') {
    return {
      side: 'BUY',
      positionSide: 'LONG'
    };
  }

  if (signal === 'SHORT') {
    return {
      side: 'SELL',
      positionSide: 'SHORT'
    };
  }

  throw new Error(`Signal không hợp lệ: ${signal}`);
}

function clientOrderId(symbol) {
  return `ai-vst-${symbol
    .replace('-', '')
    .toLowerCase()}-${Date.now()}`.slice(0, 40);
}

function roundPrice(value, precision = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const multiplier = Math.pow(10, precision);

  return Math.round(number * multiplier) / multiplier;
}

function buildTpSlParams(decision, snapshot) {
  const signal = decision.signal;

  const pricePrecision = Number(
    snapshot?.contract?.pricePrecision ?? 2
  );

  const stopLoss = roundPrice(
    signal.stopLoss,
    pricePrecision
  );

  const takeProfit1 = roundPrice(
    signal.takeProfit1,
    pricePrecision
  );

  if (!stopLoss || !takeProfit1) {
    throw new Error(
      'Không có stopLoss hoặc takeProfit1 hợp lệ để gửi TP/SL'
    );
  }

  if (signal.signal === 'LONG') {
    const validLongStructure =
      stopLoss < signal.entry &&
      takeProfit1 > signal.entry;

    if (!validLongStructure) {
      throw new Error('TP/SL LONG sai hướng');
    }
  }

  if (signal.signal === 'SHORT') {
    const validShortStructure =
      stopLoss > signal.entry &&
      takeProfit1 < signal.entry;

    if (!validShortStructure) {
      throw new Error('TP/SL SHORT sai hướng');
    }
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

async function setLeverageBeforeOrder(decision) {
  const leverage = Number(
    decision.leverage ||
    CONFIG.maxLeverage ||
    1
  );

  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(
      `Leverage không hợp lệ: ${leverage}`
    );
  }

  const leverageSide =
    decision.signal.signal === 'LONG'
      ? 'LONG'
      : decision.signal.signal === 'SHORT'
        ? 'SHORT'
        : 'ALL';

  const params = {
    symbol: CONFIG.symbol,
    leverage,
    side: leverageSide
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
    JSON.stringify(response, null, 2)
  );

  const returnedLeverage = Number(
    response?.leverage ??
    response?.data?.leverage
  );

  const hasApiError =
    response?.code !== undefined &&
    response?.code !== 0 &&
    response?.code !== '0';

  if (
    hasApiError ||
    !Number.isFinite(returnedLeverage)
  ) {
    throw new Error(
      `Set leverage lỗi: ${
        response?.msg ||
        JSON.stringify(response)
      }`
    );
  }

  console.log(`Set leverage OK: x${returnedLeverage}`);

  return response;
}

async function getOpenPosition(
  symbol = CONFIG.symbol
) {
  const response = await fetchSigned(
    'GET',
    '/openApi/swap/v2/user/positions',
    { symbol }
  );

  const positions = Array.isArray(response)
    ? response
    : Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.positions)
        ? response.positions
        : [];

  const openedPosition = positions.find(position => {
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

  const currentPrice = markPrice || avgPrice;

  const notional =
    Math.abs(positionAmt) * currentPrice;

  const margin =
    leverage > 0
      ? notional / leverage
      : 0;

  const roePct =
    margin > 0
      ? (unrealizedProfit / margin) * 100
      : 0;

  return {
    symbol: openedPosition.symbol || symbol,
    positionSide: openedPosition.positionSide,
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

function isSameDirection(openPosition, signal) {
  if (!openPosition) {
    return false;
  }

  if (signal === 'LONG') {
    return (
      openPosition.positionSide === 'LONG' ||
      openPosition.positionAmt > 0
    );
  }

  if (signal === 'SHORT') {
    return (
      openPosition.positionSide === 'SHORT' ||
      openPosition.positionAmt < 0
    );
  }

  return false;
}

function buildDcaDecision(
  decision,
  openPosition
) {
  const dcaNotional =
    Number(CONFIG.dcaMarginUsdt) *
    Number(CONFIG.maxLeverage);

  const price =
    openPosition.markPrice ||
    openPosition.avgPrice ||
    decision.signal.entry;

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `Không tính được giá DCA hợp lệ: ${price}`
    );
  }

  const quantity = Number(
    (dcaNotional / price).toFixed(4)
  );

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      `Không tính được quantity DCA hợp lệ: ${quantity}`
    );
  }

  return {
    ...decision,

    isDca: true,
    quantity,
    notional: dcaNotional,

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

async function checkPositionAndDcaGuard(
  decision
) {
  const openPosition = await getOpenPosition(
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

  const symbolState = getSymbolState(
    CONFIG.symbol
  );

  const now = Date.now();

  const sameDirection = isSameDirection(
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
        `${openPosition.positionSide}, ` +
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

  if (dcaCount >= CONFIG.maxDcaCount) {
    return {
      action: 'SKIP',
      decision,
      openPosition,

      message:
        `Đang có vị thế mở. ` +
        `Đã DCA ${dcaCount}/` +
        `${CONFIG.maxDcaCount} lần, ` +
        `không DCA thêm.`
    };
  }

  if (symbolState.lastDcaAt) {
    const elapsedSeconds =
      (now - symbolState.lastDcaAt) / 1000;

    if (
      elapsedSeconds <
      CONFIG.minSecondsBetweenDca
    ) {
      const remainingSeconds = Math.ceil(
        CONFIG.minSecondsBetweenDca -
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

  if (
    openPosition.roePct >
    CONFIG.dcaTriggerRoePct
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

    decision: buildDcaDecision(
      decision,
      openPosition
    ),

    openPosition,

    message:
      `Cho phép DCA vì ROE ` +
      `${openPosition.roePct.toFixed(2)}% ` +
      `<= ${CONFIG.dcaTriggerRoePct}%.`
  };
}

function createNotExecutedResult(
  reason,
  extra = {}
) {
  return {
    executed: false,
    isDca: false,
    mode: CONFIG.executionMode,
    reason,
    ...extra
  };
}

export async function executeDecision(
  decision,
  snapshot,
  allowVstOrder
) {
  /*
   * 1. Tín hiệu không được duyệt:
   * Không gửi lệnh BingX.
   * Không gửi Telegram.
   */
  if (!decision.approved) {
    return createNotExecutedResult(
      decision.reasons?.length
        ? decision.reasons.join('; ')
        : 'Decision không được duyệt'
    );
  }

  /*
   * 2. SIGNAL_ONLY:
   * Chỉ phân tích, không gửi lệnh.
   */
  if (
    CONFIG.executionMode === 'SIGNAL_ONLY'
  ) {
    return createNotExecutedResult(
      'SIGNAL_ONLY: chỉ báo tín hiệu, không gửi order.'
    );
  }

  /*
   * 3. Kiểm tra vị thế hiện tại.
   * Nếu có vị thế:
   * - Không nhồi lệnh thường.
   * - Chỉ DCA khi đạt đủ điều kiện.
   */
  const guard =
    await checkPositionAndDcaGuard(decision);

  if (guard.action === 'SKIP') {
    return createNotExecutedResult(
      guard.message ||
      'Đang có vị thế mở, không vào thêm.',
      {
        openPosition: guard.openPosition || null
      }
    );
  }

  decision = guard.decision;

  if (guard.action === 'DCA') {
    console.log(
      'DCA GUARD:',
      guard.message
    );
  }

  /*
   * 4. TEST_ORDER:
   * Endpoint test không tạo vị thế thật/VST.
   * Vì vậy executed vẫn là false và Telegram không gửi.
   */
  if (
    CONFIG.executionMode === 'TEST_ORDER'
  ) {
    const sideInfo = sideFor(
      decision.signal.signal
    );

    const tpSlParams = buildTpSlParams(
      decision,
      snapshot
    );

    const params = {
      symbol: CONFIG.symbol,
      side: sideInfo.side,
      positionSide: sideInfo.positionSide,
      type: 'MARKET',
      quantity: decision.quantity,
      clientOrderId: clientOrderId(
        CONFIG.symbol
      ),
      ...tpSlParams
    };

    console.log(
      'Đang gửi TEST_ORDER kèm TP/SL:',
      params
    );

    const response = await fetchSigned(
      'POST',
      '/openApi/swap/v2/trade/order/test',
      params
    );

    console.log(
      'TEST_ORDER response:',
      JSON.stringify(response, null, 2)
    );

    const hasApiError =
      response?.code !== undefined &&
      response?.code !== 0 &&
      response?.code !== '0';

    if (hasApiError) {
      throw new Error(
        `Gửi TEST_ORDER lỗi: ${
          response?.msg ||
          JSON.stringify(response)
        }`
      );
    }

    return {
      executed: false,
      testSent: true,
      isDca: Boolean(decision.isDca),
      mode: 'TEST_ORDER',
      reason:
        'Đã gửi test order, nhưng chưa tạo vị thế trên BingX.',
      response
    };
  }

  /*
   * 5. VST_ORDER:
   * Chỉ executed:true sau khi BingX trả order thành công.
   */
  if (
    CONFIG.executionMode === 'VST_ORDER'
  ) {
    if (!allowVstOrder) {
      return createNotExecutedResult(
        'Thiếu flag --allow-vst-order'
      );
    }

    /*
     * Nên bật lại đoạn kiểm tra này nếu chỉ chạy VST.
     */
    if (CONFIG.bingxEnv !== 'prod-vst') {
      throw new Error(
        'VST_ORDER chỉ được chạy khi BINGX_ENV=prod-vst'
      );
    }

    /*
     * 5.1 Set leverage trước khi gửi order.
     */
    await setLeverageBeforeOrder(decision);

    /*
     * 5.2 Xác định BUY/SELL và LONG/SHORT.
     */
    const sideInfo = sideFor(
      decision.signal.signal
    );

    /*
     * 5.3 Tạo TP và SL.
     */
    const tpSlParams = buildTpSlParams(
      decision,
      snapshot
    );

    /*
     * 5.4 Tạo request order.
     */
    const params = {
      symbol: CONFIG.symbol,
      side: sideInfo.side,
      positionSide: sideInfo.positionSide,
      type: 'MARKET',
      quantity: decision.quantity,

      clientOrderId: clientOrderId(
        CONFIG.symbol
      ),

      ...tpSlParams
    };

    console.log(
      decision.isDca
        ? 'Đang gửi lệnh DCA VST kèm TP/SL:'
        : 'Đang gửi VST_ORDER kèm TP/SL:',
      params
    );

    /*
     * 5.5 Gửi order lên BingX.
     */
    const response = await fetchSigned(
      'POST',
      '/openApi/swap/v2/trade/order',
      params
    );

    console.log(
      'VST_ORDER response:',
      JSON.stringify(response, null, 2)
    );

    /*
     * 5.6 Kiểm tra lỗi API.
     */
    const hasApiError =
      response?.code !== undefined &&
      response?.code !== 0 &&
      response?.code !== '0';

    if (hasApiError) {
      throw new Error(
        `Gửi VST_ORDER lỗi: ${
          response?.msg ||
          JSON.stringify(response)
        }`
      );
    }

    /*
     * 5.7 Parse dữ liệu order BingX.
     */
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
      null;

    /*
     * Không xác nhận được order thì không được
     * trả executed:true.
     */
    if (!orderId && !status) {
      throw new Error(
        `Không xác nhận được order response: ` +
        `${JSON.stringify(response)}`
      );
    }

    const executedQuantity = Number(
      order?.executedQty ??
      order?.quantity ??
      decision.quantity
    );

    const executedEntry = Number(
      order?.avgPrice ??
      order?.price ??
      decision.signal.entry
    );

    const executedNotional =
      Number.isFinite(executedQuantity) &&
      Number.isFinite(executedEntry) &&
      executedQuantity > 0 &&
      executedEntry > 0
        ? executedQuantity * executedEntry
        : Number(decision.notional);

    console.log('Order OK:', {
      orderId,
      status,
      symbol: order?.symbol || CONFIG.symbol,
      side: order?.side || sideInfo.side,
      positionSide:
        order?.positionSide ||
        sideInfo.positionSide,
      avgPrice: executedEntry,
      executedQty: executedQuantity,
      stopLoss:
        order?.stopLoss ||
        decision.signal.stopLoss,
      takeProfit:
        order?.takeProfit ||
        decision.signal.takeProfit1,
      isDca: Boolean(decision.isDca)
    });

    /*
     * 5.8 Lưu state sau khi order BingX thành công.
     */
    const currentState = getSymbolState(
      CONFIG.symbol
    );

    updateSymbolState(
      CONFIG.symbol,
      {
        lastOrderAt: Date.now(),
        lastSignal: decision.signal.signal,
        lastOrderId: orderId,
        lastStatus: status,

        lastEntry: executedEntry,

        lastStopLoss:
          decision.signal.stopLoss,

        lastTakeProfit1:
          decision.signal.takeProfit1,

        lastTakeProfit2:
          decision.signal.takeProfit2,

        lastQuantity:
          executedQuantity,

        lastNotional:
          executedNotional,

        lastMarginUsed:
          decision.marginUsed || null,

        dcaCount: decision.isDca
          ? Number(
              currentState.dcaCount || 0
            ) + 1
          : 0,

        lastDcaAt: decision.isDca
          ? Date.now()
          : currentState.lastDcaAt || null
      }
    );

    /*
     * 5.9 Chỉ tại đây mới trả executed:true.
     * index.js sẽ dựa vào executed:true để gửi Telegram.
     */
    return {
      executed: true,
      isDca: Boolean(decision.isDca),
      mode: 'VST_ORDER',

      orderId,
      status,

      symbol:
        order?.symbol ||
        CONFIG.symbol,

      signal:
        decision.signal.signal,

      side:
        order?.side ||
        sideInfo.side,

      positionSide:
        order?.positionSide ||
        sideInfo.positionSide,

      entry:
        executedEntry,

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
        executedQuantity,

      notional:
        executedNotional,

      marginUsed:
        Number(
          decision.marginUsed || 0
        ),

      leverage:
        Number(
          decision.leverage ||
          CONFIG.maxLeverage
        ),

      rr:
        Number(decision.rr || 0),

      reason:
        decision.signal.reason || '',

      riskNote:
        decision.signal.riskNote || '',

      message: decision.isDca
        ? 'Đã gửi lệnh DCA lên BingX thành công.'
        : 'Đã gửi lệnh mới lên BingX thành công.'
    };
  }

  /*
   * 6. Mode không được hỗ trợ.
   */
  return createNotExecutedResult(
    `Execution mode không hỗ trợ: ` +
    `${CONFIG.executionMode}`
  );
}
```
