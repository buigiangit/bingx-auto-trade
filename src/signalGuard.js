import { CONFIG } from './config.js';
import {
getSymbolState,
updateSymbolState
} from './state.js';

function toNumber(value, fallback = null) {
const number = Number(value);

return Number.isFinite(number)
? number
: fallback;
}

function getCurrentPrice(snapshot) {
const bidPrice = toNumber(
snapshot?.book?.bidPrice
);

const askPrice = toNumber(
snapshot?.book?.askPrice
);

if (
bidPrice > 0 &&
askPrice > 0
) {
return (bidPrice + askPrice) / 2;
}

const markPrice = toNumber(
snapshot?.premium?.markPrice
);

if (markPrice > 0) {
return markPrice;
}

const lastClose = toNumber(
snapshot?.indicators?.lastClose
);

if (lastClose > 0) {
return lastClose;
}

const candles = Array.isArray(
snapshot?.candles
)
? snapshot.candles
: [];

return toNumber(
candles.at(-1)?.close
);
}

function getLastCandleTime(snapshot) {
const candles = Array.isArray(
snapshot?.candles
)
? snapshot.candles
: [];

const lastCandle =
candles.at(-1);

return (
toNumber(lastCandle?.closeTime) ||
toNumber(lastCandle?.time) ||
null
);
}

function calcPriceMovePct(
currentPrice,
lastEntry
) {
if (
!Number.isFinite(currentPrice) ||
!Number.isFinite(lastEntry) ||
currentPrice <= 0 ||
lastEntry <= 0
) {
return null;
}

return (
Math.abs(currentPrice - lastEntry) /
lastEntry
) * 100;
}

function getSignalStatus(
signalState,
currentPrice,
now
) {
if (!signalState) {
return {
status: 'NONE',
reason: 'Chưa có kèo cũ'
};
}

const signal =
signalState.signal;

const entry = toNumber(
signalState.entry1 ??
signalState.entry
);

const stopLoss = toNumber(
signalState.stopLoss
);

const takeProfit1 = toNumber(
signalState.takeProfit1
);

const takeProfit2 = toNumber(
signalState.takeProfit2
);

const createdAt = toNumber(
signalState.createdAt
);

const expireMs =
Number(CONFIG.signalExpireSeconds || 7200) *
1000;

if (
createdAt &&
now - createdAt >= expireMs
) {
return {
status: 'EXPIRED',
reason: 'Kèo cũ đã hết hạn'
};
}

if (
!Number.isFinite(currentPrice) ||
currentPrice <= 0
) {
return {
status: 'ACTIVE',
reason: 'Không có giá hiện tại để kiểm tra TP/SL'
};
}

if (signal === 'LONG') {
if (
takeProfit2 > 0 &&
currentPrice >= takeProfit2
) {
return {
status: 'TP2',
reason: 'Kèo LONG cũ đã chạm TP2'
};
}

```
if (
  takeProfit1 > 0 &&
  currentPrice >= takeProfit1
) {
  return {
    status: 'TP1',
    reason: 'Kèo LONG cũ đã chạm TP1'
  };
}

if (
  stopLoss > 0 &&
  currentPrice <= stopLoss
) {
  return {
    status: 'SL',
    reason: 'Kèo LONG cũ đã chạm SL'
  };
}
```

}

if (signal === 'SHORT') {
if (
takeProfit2 > 0 &&
currentPrice <= takeProfit2
) {
return {
status: 'TP2',
reason: 'Kèo SHORT cũ đã chạm TP2'
};
}

```
if (
  takeProfit1 > 0 &&
  currentPrice <= takeProfit1
) {
  return {
    status: 'TP1',
    reason: 'Kèo SHORT cũ đã chạm TP1'
  };
}

if (
  stopLoss > 0 &&
  currentPrice >= stopLoss
) {
  return {
    status: 'SL',
    reason: 'Kèo SHORT cũ đã chạm SL'
  };
}
```

}

return {
status: 'ACTIVE',
reason: 'Kèo cũ vẫn đang active'
};
}

function updateCommunitySignalStatus(
symbol,
signalState,
statusResult
) {
if (
!signalState ||
statusResult.status === signalState.status
) {
return;
}

updateSymbolState(
symbol,
{
communitySignal: {
...signalState,
status:
statusResult.status,

```
    statusReason:
      statusResult.reason,

    statusUpdatedAt:
      Date.now()
  }
}
```

);
}

export function canPublishCommunitySignal(
decision,
snapshot
) {
const symbol =
snapshot?.symbol ||
CONFIG.symbol;

const signal =
String(
decision?.signal?.signal || ''
).toUpperCase();

if (
!decision?.approved ||
!['LONG', 'SHORT'].includes(signal)
) {
return {
allowed: false,
reason: 'Tín hiệu chưa được duyệt hoặc không phải LONG/SHORT'
};
}

const now = Date.now();

const currentPrice =
getCurrentPrice(snapshot);

const currentCandleTime =
getLastCandleTime(snapshot);

const state =
getSymbolState(symbol);

const lastSignalState =
state.communitySignal || null;

if (!lastSignalState) {
return {
allowed: true,
reason: 'Chưa có kèo cộng đồng trước đó',
currentPrice,
currentCandleTime
};
}

const statusResult =
getSignalStatus(
lastSignalState,
currentPrice,
now
);

updateCommunitySignalStatus(
symbol,
lastSignalState,
statusResult
);

const isLastActive =
statusResult.status === 'ACTIVE';

const lastCreatedAt =
toNumber(lastSignalState.createdAt);

const cooldownMs =
Number(CONFIG.minSecondsBetweenSignals || 1800) *
1000;

if (
lastCreatedAt &&
now - lastCreatedAt < cooldownMs
) {
const remainingSeconds =
Math.ceil(
(cooldownMs - (now - lastCreatedAt)) /
1000
);

```
return {
  allowed: false,
  reason:
    `Signal cooldown còn ${remainingSeconds}s`,
  currentPrice,
  currentCandleTime,
  lastSignalState,
  statusResult
};
```

}

if (
CONFIG.onlySignalOnNewCandle &&
lastSignalState.candleTime &&
currentCandleTime &&
String(lastSignalState.candleTime) ===
String(currentCandleTime)
) {
return {
allowed: false,
reason:
'Chưa có nến mới, không call lại',
currentPrice,
currentCandleTime,
lastSignalState,
statusResult
};
}

const lastEntry =
toNumber(
lastSignalState.entry1 ??
lastSignalState.entry
);

const priceMovePct =
calcPriceMovePct(
currentPrice,
lastEntry
);

const minMovePct =
Number(
CONFIG.minSignalPriceMovePct || 0.35
);

if (
isLastActive &&
CONFIG.blockSameDirectionSignal &&
lastSignalState.signal === signal &&
Number.isFinite(priceMovePct) &&
priceMovePct < minMovePct
) {
return {
allowed: false,
reason:
`Đã có kèo ${signal} active, giá mới lệch ${priceMovePct.toFixed(3)}%, chưa đủ ${minMovePct}%`,
currentPrice,
currentCandleTime,
lastSignalState,
statusResult,
priceMovePct
};
}

if (
isLastActive &&
lastSignalState.signal === signal
) {
return {
allowed: false,
reason:
`Đã có kèo ${signal} active, không spam cùng hướng`,
currentPrice,
currentCandleTime,
lastSignalState,
statusResult,
priceMovePct
};
}

return {
allowed: true,
reason:
`Cho phép call kèo mới. Kèo cũ: ${statusResult.status}`,
currentPrice,
currentCandleTime,
lastSignalState,
statusResult,
priceMovePct
};
}

export function recordCommunitySignal(
decision,
snapshot,
telegramResult = {}
) {
const symbol =
snapshot?.symbol ||
CONFIG.symbol;

const signal =
decision.signal;

const now = Date.now();

const currentPrice =
getCurrentPrice(snapshot);

const candleTime =
getLastCandleTime(snapshot);

const communitySignal = {
symbol,

```
signal:
  signal.signal,

status:
  'ACTIVE',

createdAt:
  now,

candleTime,

currentPrice,

entry:
  Number(signal.entry),

entry1:
  Number(signal.entry1 ?? signal.entry),

entry2:
  signal.entry2 !== null &&
  signal.entry2 !== undefined
    ? Number(signal.entry2)
    : null,

stopLoss:
  Number(signal.stopLoss),

takeProfit1:
  Number(signal.takeProfit1),

takeProfit2:
  Number(signal.takeProfit2),

confidence:
  Number(signal.confidence || 0),

reason:
  signal.reason || '',

riskNote:
  signal.riskNote || '',

telegram:
  {
    sent:
      telegramResult?.sent === true,

    messageId:
      telegramResult?.messageId || null
  }
```

};

updateSymbolState(
symbol,
{
communitySignal,

```
  lastCommunitySignalAt:
    now,

  lastCommunitySignal:
    communitySignal.signal,

  lastCommunityEntry:
    communitySignal.entry1,

  lastCommunityCandleTime:
    candleTime
}
```

);

return communitySignal;
}
