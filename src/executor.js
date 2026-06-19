import { CONFIG, assertSafeEnvironment } from './config.js';
import { fetchSigned } from './bingxClient.js';
import { getSymbolState, updateSymbolState } from './state.js';

function sideFor(signal) {
  if (signal === 'LONG') return { side: 'BUY', positionSide: 'LONG' };
  if (signal === 'SHORT') return { side: 'SELL', positionSide: 'SHORT' };
  throw new Error('Signal không hợp lệ');
}

function clientOrderId(symbol) {
  return `ai-vst-${symbol.replace('-', '').toLowerCase()}-${Date.now()}`.slice(0, 40);
}
function roundPrice(value, precision = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  const p = Math.pow(10, precision);
  return Math.round(n * p) / p;
}

function buildTpSlParams(decision, snapshot) {
  const signal = decision.signal;
  const pricePrecision = Number(snapshot?.contract?.pricePrecision ?? 2);

  const stopLoss = roundPrice(signal.stopLoss, pricePrecision);
  const takeProfit1 = roundPrice(signal.takeProfit1, pricePrecision);

  if (!stopLoss || !takeProfit1) {
    throw new Error('Không có stopLoss hoặc takeProfit1 hợp lệ để gửi TP/SL');
  }

  if (signal.signal === 'LONG') {
    if (!(stopLoss < signal.entry && takeProfit1 > signal.entry)) {
      throw new Error('TP/SL LONG sai hướng');
    }
  }

  if (signal.signal === 'SHORT') {
    if (!(stopLoss > signal.entry && takeProfit1 < signal.entry)) {
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
  const leverage = Number(decision.leverage || CONFIG.maxLeverage || 1);

  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(`Leverage không hợp lệ: ${leverage}`);
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

  console.log('Đang set leverage trước khi gửi lệnh:', params);

  const res = await fetchSigned(
    'POST',
    '/openApi/swap/v2/trade/leverage',
    params
  );

  console.log('Set leverage response:', JSON.stringify(res, null, 2));

  const returnedLeverage = Number(res?.leverage ?? res?.data?.leverage);

  if (
    (res?.code !== undefined && res?.code !== 0 && res?.code !== '0') ||
    !Number.isFinite(returnedLeverage)
  ) {
    throw new Error(`Set leverage lỗi: ${res?.msg || JSON.stringify(res)}`);
  }

  console.log(`Set leverage OK: x${returnedLeverage}`);

  return res;
}
async function getOpenPosition(symbol = CONFIG.symbol) {
  const res = await fetchSigned(
    'GET',
    '/openApi/swap/v2/user/positions',
    { symbol }
  );

  const list = Array.isArray(res)
    ? res
    : Array.isArray(res?.data)
      ? res.data
      : Array.isArray(res?.positions)
        ? res.positions
        : [];

  const opened = list.find(p => {
    const qty = Math.abs(Number(
      p.positionAmt ??
      p.positionAmount ??
      p.availableAmt ??
      p.positionSize ??
      p.quantity ??
      0
    ));

    return qty > 0;
  });

  if (!opened) return null;

  const positionAmt = Number(
    opened.positionAmt ??
    opened.positionAmount ??
    opened.availableAmt ??
    opened.positionSize ??
    opened.quantity ??
    0
  );

  const avgPrice = Number(
    opened.avgPrice ??
    opened.averagePrice ??
    opened.entryPrice ??
    0
  );

  const markPrice = Number(
    opened.markPrice ??
    opened.currentPrice ??
    opened.lastPrice ??
    0
  );

  const unrealizedProfit = Number(
    opened.unrealizedProfit ??
    opened.unrealizedPnl ??
    opened.pnl ??
    0
  );

  const leverage = Number(
    opened.leverage ??
    CONFIG.maxLeverage ??
    1
  );

  const notional = Math.abs(positionAmt) * (markPrice || avgPrice);
  const margin = leverage > 0 ? notional / leverage : 0;

  let roePct = 0;

  if (margin > 0) {
    roePct = (unrealizedProfit / margin) * 100;
  }

  return {
    symbol: opened.symbol || symbol,
    positionSide: opened.positionSide,
    positionAmt,
    avgPrice,
    markPrice,
    unrealizedProfit,
    leverage,
    notional,
    margin,
    roePct,
    raw: opened
  };
}

function isSameDirection(openPosition, signal) {
  if (!openPosition) return false;

  if (signal === 'LONG') {
    return openPosition.positionSide === 'LONG' || openPosition.positionAmt > 0;
  }

  if (signal === 'SHORT') {
    return openPosition.positionSide === 'SHORT' || openPosition.positionAmt < 0;
  }

  return false;
}

function buildDcaDecision(decision, openPosition) {
  const dcaNotional = CONFIG.dcaMarginUsdt * CONFIG.maxLeverage;
  const price = openPosition.markPrice || openPosition.avgPrice || decision.signal.entry;

  const quantity = Number((dcaNotional / price).toFixed(4));

  return {
    ...decision,
    isDca: true,
    quantity,
    notional: dcaNotional,
    signal: {
      ...decision.signal,
      entry: price,
      reason: `${decision.signal.reason || ''} | DCA vì ROE ${openPosition.roePct.toFixed(2)}% <= ${CONFIG.dcaTriggerRoePct}%`
    }
  };
}

async function checkPositionAndDcaGuard(decision) {
  const openPosition = await getOpenPosition(CONFIG.symbol);

  if (!openPosition) {
    return {
      action: 'NEW_ENTRY',
      decision,
      message: null
    };
  }

  const symbolState = getSymbolState(CONFIG.symbol);
  const now = Date.now();

  const sameDirection = isSameDirection(openPosition, decision.signal.signal);

  if (!sameDirection) {
    return {
      action: 'SKIP',
      decision,
      message: `Đang có vị thế ${openPosition.positionSide} nhưng tín hiệu mới là ${decision.signal.signal}, không đảo chiều tự động.`
    };
  }

  if (!CONFIG.allowDca) {
    return {
      action: 'SKIP',
      decision,
      message: `Đang có vị thế mở ${openPosition.positionSide}, DCA đang tắt nên không vào thêm.`
    };
  }

  const dcaCount = Number(symbolState.dcaCount || 0);

  if (dcaCount >= CONFIG.maxDcaCount) {
    return {
      action: 'SKIP',
      decision,
      message: `Đang có vị thế mở. Đã DCA ${dcaCount}/${CONFIG.maxDcaCount} lần, không DCA thêm.`
    };
  }

  if (symbolState.lastDcaAt) {
    const elapsedSeconds = (now - symbolState.lastDcaAt) / 1000;

    if (elapsedSeconds < CONFIG.minSecondsBetweenDca) {
      return {
        action: 'SKIP',
        decision,
        message: `Đang có vị thế mở. DCA cooldown còn ${Math.ceil(CONFIG.minSecondsBetweenDca - elapsedSeconds)} giây.`
      };
    }
  }

  if (openPosition.roePct > CONFIG.dcaTriggerRoePct) {
    return {
      action: 'SKIP',
      decision,
      message: `Đang có vị thế mở ${openPosition.positionSide}, ROE ${openPosition.roePct.toFixed(2)}% chưa âm đủ để DCA.`
    };
  }

  return {
    action: 'DCA',
    decision: buildDcaDecision(decision, openPosition),
    openPosition,
    message: `Cho phép DCA vì ROE ${openPosition.roePct.toFixed(2)}% <= ${CONFIG.dcaTriggerRoePct}%.`
  };
}

export async function executeDecision(decision, snapshot, allowVstOrder) {
  // 1. Nếu tín hiệu không được duyệt thì không làm gì
  if (!decision.approved) {
    return decision.reasons?.length
      ? decision.reasons.join('; ')
      : 'Decision không được duyệt';
  }

  // 2. Chế độ chỉ báo tín hiệu
  if (CONFIG.executionMode === 'SIGNAL_ONLY') {
    return 'SIGNAL_ONLY: chỉ báo tín hiệu, không gửi order.';
  }

  // 3. Guard vị thế đang mở + logic DCA
  // Hàm này cần bạn đã thêm phía trên:
  // checkPositionAndDcaGuard(decision)
  const guard = await checkPositionAndDcaGuard(decision);

  if (guard.action === 'SKIP') {
    return guard.message || 'Đang có vị thế mở, không vào thêm.';
  }

  // Nếu guard cho phép DCA thì decision sẽ được đổi sang decision DCA
  decision = guard.decision;

  if (guard.action === 'DCA') {
    console.log('DCA GUARD:', guard.message);
  }

  // 4. TEST_ORDER: chỉ test API, không khớp lệnh thật
  if (CONFIG.executionMode === 'TEST_ORDER') {
    const sideInfo = sideFor(decision.signal.signal);
    const tpSlParams = buildTpSlParams(decision, snapshot);

    const params = {
      symbol: CONFIG.symbol,
      side: sideInfo.side,
      positionSide: sideInfo.positionSide,
      type: 'MARKET',
      quantity: decision.quantity,
      clientOrderId: clientOrderId(CONFIG.symbol),
      ...tpSlParams
    };

    console.log('Đang gửi TEST_ORDER kèm TP/SL:', params);

    const res = await fetchSigned(
      'POST',
      '/openApi/swap/v2/trade/order/test',
      params
    );

    console.log('TEST_ORDER response:', JSON.stringify(res, null, 2));

    if (
      res?.code !== undefined &&
      res?.code !== 0 &&
      res?.code !== '0'
    ) {
      throw new Error(`Gửi TEST_ORDER lỗi: ${res?.msg || JSON.stringify(res)}`);
    }

    return 'Đã gửi test order kèm TP/SL.';
  }

  // 5. VST_ORDER: gửi lệnh mô phỏng VST
  if (CONFIG.executionMode === 'VST_ORDER') {
    if (!allowVstOrder) {
      return 'Muốn gửi lệnh mô phỏng VST, chạy thêm flag --allow-vst-order.';
    }

    // if (CONFIG.bingxEnv !== 'prod-vst') {
    //   throw new Error('Chỉ cho phép VST_ORDER khi BINGX_ENV=prod-vst');
    // }

    // 5.1 Set leverage trước khi gửi lệnh
    await setLeverageBeforeOrder(decision);

    // 5.2 Tạo side LONG/SHORT theo Hedge Mode
    const sideInfo = sideFor(decision.signal.signal);

    // 5.3 Tạo TP/SL
    const tpSlParams = buildTpSlParams(decision, snapshot);

    // 5.4 Params gửi order
    const params = {
      symbol: CONFIG.symbol,
      side: sideInfo.side,
      positionSide: sideInfo.positionSide,
      type: 'MARKET',
      quantity: decision.quantity,
      clientOrderId: clientOrderId(CONFIG.symbol),
      ...tpSlParams
    };

    console.log('Đang gửi VST_ORDER kèm TP/SL:', params);

    const res = await fetchSigned(
      'POST',
      '/openApi/swap/v2/trade/order',
      params
    );

    console.log('VST_ORDER response:', JSON.stringify(res, null, 2));

    // 5.5 Parse response BingX
    const order = res?.order || res?.data?.order || res?.data || res;

    const orderId =
      order?.orderId ||
      order?.orderID ||
      order?.clientOrderId ||
      order?.clientOrderID;

    const status = order?.status;

    // Nếu BingX có code và code khác 0 thì mới xem là lỗi
    if (
      res?.code !== undefined &&
      res?.code !== 0 &&
      res?.code !== '0'
    ) {
      throw new Error(`Gửi VST_ORDER lỗi: ${res?.msg || JSON.stringify(res)}`);
    }

    // Nếu không có orderId/status thì response không rõ ràng
    if (!orderId && !status) {
      throw new Error(`Không xác nhận được order response: ${JSON.stringify(res)}`);
    }

    console.log('Order OK:', {
      orderId,
      status,
      symbol: order?.symbol,
      side: order?.side,
      positionSide: order?.positionSide,
      avgPrice: order?.avgPrice,
      executedQty: order?.executedQty,
      quantity: order?.quantity,
      stopLoss: order?.stopLoss,
      takeProfit: order?.takeProfit
    });

    // 5.6 Update state sau khi order thành công
    const currentState = getSymbolState(CONFIG.symbol);

    updateSymbolState(CONFIG.symbol, {
      lastOrderAt: Date.now(),
      lastSignal: decision.signal.signal,
      lastOrderId: orderId || null,
      lastStatus: status || null,
      lastEntry: decision.signal.entry,
      lastStopLoss: decision.signal.stopLoss,
      lastTakeProfit1: decision.signal.takeProfit1,
      lastQuantity: decision.quantity,
      lastNotional: decision.notional,
      lastMarginUsed: decision.marginUsed || null,

      dcaCount: decision.isDca
        ? Number(currentState.dcaCount || 0) + 1
        : 0,

      lastDcaAt: decision.isDca
        ? Date.now()
        : currentState.lastDcaAt || null
    });

    if (decision.isDca) {
      return `Đã gửi lệnh DCA VST kèm TP/SL. OrderId: ${orderId || 'N/A'}, status: ${status || 'N/A'}`;
    }

    return `Đã gửi lệnh VST kèm TP/SL. OrderId: ${orderId || 'N/A'}, status: ${status || 'N/A'}`;
  }

  // 6. Mode không hỗ trợ
  return `Execution mode không hỗ trợ: ${CONFIG.executionMode}`;
}