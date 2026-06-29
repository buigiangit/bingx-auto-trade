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
 * Chuyển tín hiệu AI thành side dùng cho tài khoản Hedge Mode.
 */
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

/**
 * Tạo clientOrderId riêng cho mỗi request.
 */
function clientOrderId(symbol) {
  return `ai-vst-${symbol
    .replace('-', '')
    .toLowerCase()}-${Date.now()}`.slice(0, 40);
}

/**
 * Làm tròn giá theo pricePrecision của hợp đồng.
 */
function roundPrice(value, precision = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const multiplier = Math.pow(10, precision);

  return Math.round(number * multiplier) / multiplier;
}

/**
 * Tạo tham số TP/SL gửi kèm lệnh MARKET.
 */
function buildTpSlParams(decision, snapshot) {
  const signal = decision.signal;

  const pricePrecision = Number(
    snapshot?.contract?.pricePrecision ?? 2
  );

  const entry = Number(signal.entry);

  const stopLoss = roundPrice(
    signal.stopLoss,
    pricePrecision
  );

  const takeProfit1 = roundPrice(
    signal.takeProfit1,
    pricePrecision
  );

  if (!Number.isFinite(entry) || entry <= 0) {
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

  if (signal.signal === 'LONG') {
    const validLongStructure =
      stopLoss < entry &&
      takeProfit1 > entry;

    if (!validLongStructure) {
      throw new Error(
        `TP/SL LONG sai hướng. ` +
        `Entry: ${entry}, ` +
        `SL: ${stopLoss}, ` +
        `TP1: ${takeProfit1}`
      );
    }
  } else if (signal.signal === 'SHORT') {
    const validShortStructure =
      stopLoss > entry &&
      takeProfit1 < entry;

    if (!validShortStructure) {
      throw new Error(
        `TP/SL SHORT sai hướng. ` +
        `Entry: ${entry}, ` +
        `SL: ${stopLoss}, ` +
        `TP1: ${takeProfit1}`
      );
    }
  } else {
    throw new Error(
      `Không thể tạo TP/SL cho signal: ${signal.signal}`
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
 * Set leverage theo hướng LONG/SHORT trước khi đặt order.
 */
async function setLeverageBeforeOrder(decision) {
  const leverage = Number(
    decision.leverage ||
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

  console.log(
    `Set leverage OK: x${returnedLeverage}`
  );

  return response;
}

/**
 * Lấy vị thế hiện đang mở trên BingX.
 */
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

  const openedPosition = positions.find(
    position => {
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
    }
  );

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
    symbol:
      openedPosition.symbol || symbol,

    positionSide:
      openedPosition.positionSide,

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
 * Kiểm tra tín hiệu hiện tại có cùng hướng vị thế đang mở hay không.
 */
function isSameDirection(
  openPosition,
  signal
) {
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

/**
 * Tạo decision dành riêng cho DCA.
 */
function buildDcaDecision(
  decision,
  openPosition
) {
  const dcaMarginUsdt = Number(
    CONFIG.dcaMarginUsdt || 0
  );

  const leverage = Number(
    CONFIG.maxLeverage || 1
  );

  const dcaNotional =
    dcaMarginUsdt * leverage;

  const price = Number(
    openPosition.markPrice ||
    openPosition.avgPrice ||
    decision.signal.entry
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
    marginUsed: dcaMarginUsdt,

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
 * Kiểm tra vị thế và điều kiện DCA.
 */
async function checkPositionAndDcaGuard(
  decision
) {
  const openPosition =
    await getOpenPosition(CONFIG.symbol);

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

/**
 * Kết quả khi không gửi order.
 */
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

/**
 * Gửi call Telegram dành cho cộng đồng.
 *
 * Hàm này luôn tự bắt lỗi để Telegram lỗi
 * không làm dừng luồng gửi BingX.
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
        error.response?.data?.description ||
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
 * Hàm xử lý chính.
 */
export async function executeDecision(
  decision,
  snapshot,
  allowVstOrder
) {
  /*
   * AI/risk filter chưa duyệt:
   * không gửi Telegram, không gửi BingX.
   */
  if (!decision.approved) {
    return createNotExecutedResult(
      decision.reasons?.length
        ? decision.reasons.join('; ')
        : 'Decision không được duyệt'
    );
  }

  /*
   * Chỉ phân tích tín hiệu.
   */
  if (
    CONFIG.executionMode === 'SIGNAL_ONLY'
  ) {
    return createNotExecutedResult(
      'SIGNAL_ONLY: chỉ báo tín hiệu, không gửi order.'
    );
  }

  /*
   * Kiểm tra vị thế hiện tại và điều kiện DCA.
   */
  const guard =
    await checkPositionAndDcaGuard(decision);

  if (guard.action === 'SKIP') {
    return createNotExecutedResult(
      guard.message ||
      'Đang có vị thế mở, không vào thêm.',
      {
        openPosition:
          guard.openPosition || null
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
   * TEST_ORDER:
   * không gửi call Telegram cộng đồng.
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
      positionSide:
        sideInfo.positionSide,
      type: 'MARKET',
      quantity:
        decision.quantity,

      clientOrderId:
        clientOrderId(CONFIG.symbol),

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
      isDca:
        Boolean(decision.isDca),
      mode: 'TEST_ORDER',

      reason:
        'Đã gửi test order, nhưng chưa tạo vị thế trên BingX.',

      response
    };
  }

  /*
   * VST_ORDER:
   * - Telegram đăng call cho cộng đồng.
   * - BingX xử lý order riêng.
   * - BingX thành công/lỗi không sửa tin Telegram.
   */
  if (
    CONFIG.executionMode === 'VST_ORDER'
  ) {
    if (!allowVstOrder) {
      return createNotExecutedResult(
        'Thiếu flag --allow-vst-order'
      );
    }

    if (CONFIG.bingxEnv !== 'prod-vst') {
      throw new Error(
        'VST_ORDER chỉ được chạy khi BINGX_ENV=prod-vst'
      );
    }

    /*
     * Bắt đầu gửi Telegram ngay khi guard đã cho phép.
     *
     * Không chờ set leverage hoặc BingX trả kết quả.
     */
    const telegramPromise =
      startCommunityTelegram(
        decision,
        snapshot
      );

    /*
     * Tạo thông tin order BingX.
     *
     * Nếu đoạn này lỗi thì Telegram vẫn đã được gửi,
     * nhưng lỗi BingX chỉ hiển thị trong log.
     */
    const sideInfo = sideFor(
      decision.signal.signal
    );

    const tpSlParams = buildTpSlParams(
      decision,
      snapshot
    );

    /*
     * Set leverage trước khi gửi order BingX.
     */
    await setLeverageBeforeOrder(decision);

    const params = {
      symbol: CONFIG.symbol,
      side: sideInfo.side,
      positionSide:
        sideInfo.positionSide,
      type: 'MARKET',
      quantity:
        decision.quantity,

      clientOrderId:
        clientOrderId(CONFIG.symbol),

      ...tpSlParams
    };

    console.log(
      decision.isDca
        ? 'Đang gửi lệnh DCA VST kèm TP/SL:'
        : 'Đang gửi VST_ORDER kèm TP/SL:',
      params
    );

    /*
     * Gửi order BingX.
     *
     * Telegram đang chạy độc lập ở telegramPromise.
     */
    let response;

    try {
      response = await fetchSigned(
        'POST',
        '/openApi/swap/v2/trade/order',
        params
      );
    } catch (error) {
      /*
       * Đảm bảo Telegram promise được xử lý,
       * nhưng không thay đổi/xóa tin Telegram.
       */
      const telegramResult =
        await telegramPromise;

      console.error(
        'BingX gửi order lỗi:',
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

    /*
     * Lấy kết quả Telegram.
     * Tin Telegram không phụ thuộc response BingX.
     */
    const telegramResult =
      await telegramPromise;

    console.log(
      'VST_ORDER response:',
      JSON.stringify(response, null, 2)
    );

    const hasApiError =
      response?.code !== undefined &&
      response?.code !== 0 &&
      response?.code !== '0';

    if (hasApiError) {
      const bingxError =
        response?.msg ||
        response?.message ||
        JSON.stringify(response);

      console.error(
        'BingX từ chối order:',
        bingxError
      );

      /*
       * Không sửa tin Telegram.
       */
      throw new Error(
        `Gửi VST_ORDER lỗi: ${bingxError}`
      );
    }

    /*
     * Parse response order BingX.
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
        ? executedQuantity *
          executedEntry
        : Number(decision.notional);

    console.log('Order OK:', {
      orderId,
      status,

      symbol:
        order?.symbol ||
        CONFIG.symbol,

      side:
        order?.side ||
        sideInfo.side,

      positionSide:
        order?.positionSide ||
        sideInfo.positionSide,

      avgPrice:
        executedEntry,

      executedQty:
        executedQuantity,

      stopLoss:
        order?.stopLoss ||
        decision.signal.stopLoss,

      takeProfit:
        order?.takeProfit ||
        decision.signal.takeProfit1,

      isDca:
        Boolean(decision.isDca),

      telegram:
        telegramResult
    });

    /*
     * Lưu state sau khi BingX xác nhận order thành công.
     */
    const currentState =
      getSymbolState(CONFIG.symbol);

    updateSymbolState(
      CONFIG.symbol,
      {
        lastOrderAt: Date.now(),

        lastSignal:
          decision.signal.signal,

        lastOrderId:
          orderId,

        lastStatus:
          status,

        lastEntry:
          executedEntry,

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

        dcaCount:
          decision.isDca
            ? Number(
                currentState.dcaCount || 0
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
      executed: true,

      isDca:
        Boolean(decision.isDca),

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
        Number(
          decision.rr || 0
        ),

      reason:
        decision.signal.reason || '',

      riskNote:
        decision.signal.riskNote || '',

      telegram: {
        sent:
          telegramResult?.sent === true,

        messageId:
          telegramResult?.messageId || null
      },

      message:
        decision.isDca
          ? 'Đã đăng call DCA lên Telegram và xử lý order BingX.'
          : 'Đã đăng call lên Telegram và xử lý order BingX.'
    };
  }

  return createNotExecutedResult(
    `Execution mode không hỗ trợ: ` +
    `${CONFIG.executionMode}`
  );
}
