import { CONFIG } from './config.js';

import {
  isDatabaseEnabled,
  queryDatabase,
  withDatabaseTransaction
} from './db.js';

const ACTIVE_TRADE_STATUSES = [
  'OPEN',
  'TP1_HIT'
];

const FINAL_TRADE_STATUSES = [
  'TP2_HIT',
  'SL_HIT',
  'EXPIRED',
  'CANCELLED'
];

const NUMERIC_TRADE_FIELDS = [
  'id',
  'entry1',
  'entry2',
  'average_entry',
  'entry2_hit_price',
  'stop_loss',
  'take_profit1',
  'take_profit2',
  'confidence',
  'rr',
  'leverage',
  'quantity',
  'notional',
  'dca_count',
  'total_quantity',
  'total_notional',
  'tp1_hit_price',
  'tp2_hit_price',
  'sl_hit_price',
  'last_checked_candle_time',
  'max_favorable_price',
  'max_adverse_price',
  'telegram_fbt_message_id',
  'telegram_cdt_message_id'
];

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
 * Bắt buộc giá trị là số dương.
 */
function positiveNumber(
  value,
  fieldName
) {
  const number =
    toNumber(value);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    throw new Error(
      `${fieldName} không hợp lệ: ${value}`
    );
  }

  return number;
}

/**
 * Chuẩn hóa direction.
 */
function normalizeDirection(value) {
  const direction =
    String(value || '')
      .trim()
      .toUpperCase();

  if (
    ![
      'LONG',
      'SHORT'
    ].includes(direction)
  ) {
    throw new Error(
      `Direction không hợp lệ: ${value}`
    );
  }

  return direction;
}

/**
 * Chuyển object thành dữ liệu JSON an toàn
 * để lưu vào PostgreSQL JSONB.
 */
function toSafeJson(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  try {
    const seen =
      new WeakSet();

    const text =
      JSON.stringify(
        value,
        (key, item) => {
          if (
            typeof item === 'bigint'
          ) {
            return item.toString();
          }

          if (
            typeof item === 'number' &&
            !Number.isFinite(item)
          ) {
            return null;
          }

          if (
            item &&
            typeof item === 'object'
          ) {
            if (seen.has(item)) {
              return '[Circular]';
            }

            seen.add(item);
          }

          return item;
        }
      );

    return JSON.parse(text);
  } catch (error) {
    return {
      serializationError:
        error.message ||
        String(error)
    };
  }
}

/**
 * Chuẩn hóa row PostgreSQL.
 *
 * NUMERIC thường được pg trả về dạng string.
 */
function normalizeTradeRow(row) {
  if (!row) {
    return null;
  }

  const normalized = {
    ...row
  };

  for (
    const field of NUMERIC_TRADE_FIELDS
  ) {
    if (
      normalized[field] !== null &&
      normalized[field] !== undefined
    ) {
      normalized[field] =
        toNumber(normalized[field]);
    }
  }

  return normalized;
}

/**
 * Chuẩn hóa event row.
 */
function normalizeEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,

    id:
      toNumber(row.id),

    trade_id:
      toNumber(row.trade_id),

    event_price:
      toNumber(row.event_price),

    quantity:
      toNumber(row.quantity),

    notional:
      toNumber(row.notional)
  };
}

/**
 * Thực hiện query bằng transaction client
 * hoặc pool mặc định.
 */
async function runQuery(
  client,
  text,
  params = []
) {
  if (client) {
    return client.query(
      text,
      params
    );
  }

  return queryDatabase(
    text,
    params
  );
}

/**
 * Lưu sự kiện giao dịch.
 */
async function insertTradeEvent(
  client,
  {
    tradeId,
    eventType,
    eventPrice = null,
    quantity = null,
    notional = null,
    metadata = null
  }
) {
  const result =
    await runQuery(
      client,
      `
        INSERT INTO ai_trade_events (
          trade_id,
          event_type,
          event_price,
          quantity,
          notional,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb
        )
        RETURNING *
      `,
      [
        tradeId,
        String(eventType || '')
          .trim()
          .toUpperCase(),
        toNumber(eventPrice),
        toNumber(quantity),
        toNumber(notional),
        metadata
          ? JSON.stringify(
              toSafeJson(metadata)
            )
          : null
      ]
    );

  return normalizeEventRow(
    result.rows[0]
  );
}

/**
 * Lấy một trade theo ID.
 */
async function getTradeByIdWithClient(
  client,
  tradeId,
  forUpdate = false
) {
  const result =
    await runQuery(
      client,
      `
        SELECT *
        FROM ai_trades
        WHERE id = $1
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      [
        tradeId
      ]
    );

  return normalizeTradeRow(
    result.rows[0]
  );
}

/**
 * Lấy active trade theo symbol.
 */
async function getActiveTradeWithClient(
  client,
  symbol,
  forUpdate = false
) {
  const result =
    await runQuery(
      client,
      `
        SELECT *
        FROM ai_trades
        WHERE symbol = $1
          AND status = ANY($2::varchar[])
        ORDER BY opened_at DESC
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      [
        symbol,
        ACTIVE_TRADE_STATUSES
      ]
    );

  return normalizeTradeRow(
    result.rows[0]
  );
}

/**
 * Kiểm tra repository DB có hoạt động không.
 */
export function isTradeRepositoryEnabled() {
  return isDatabaseEnabled();
}

/**
 * Lấy một lệnh theo ID.
 */
export async function getTradeById(
  tradeId
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return getTradeByIdWithClient(
    null,
    tradeId,
    false
  );
}

/**
 * Tìm lệnh đang active theo symbol.
 *
 * OPEN và TP1_HIT đều được xem là active.
 */
export async function getActiveTradeBySymbol(
  symbol = CONFIG.symbol
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return getActiveTradeWithClient(
    null,
    symbol,
    false
  );
}

/**
 * Lấy danh sách lệnh đang active.
 */
export async function getActiveTrades(
  limit = CONFIG.tradeMonitorBatchSize || 50
) {
  if (!isTradeRepositoryEnabled()) {
    return [];
  }

  const safeLimit =
    Math.max(
      1,
      Math.min(
        500,
        Number(limit) || 50
      )
    );

  const result =
    await queryDatabase(
      `
        SELECT *
        FROM ai_trades
        WHERE status = ANY($1::varchar[])
        ORDER BY opened_at ASC
        LIMIT $2
      `,
      [
        ACTIVE_TRADE_STATUSES,
        safeLimit
      ]
    );

  return result.rows.map(
    normalizeTradeRow
  );
}

/**
 * Kiểm tra có lệnh đang khóa call mới không.
 */
export async function hasActiveTrade(
  symbol = CONFIG.symbol
) {
  const trade =
    await getActiveTradeBySymbol(
      symbol
    );

  return Boolean(trade);
}

/**
 * Tạo bản ghi lệnh mới.
 *
 * Hàm này phải chạy trước khi gửi Telegram.
 * Unique index trong DB sẽ ngăn hai vòng bot
 * đồng thời tạo hai lệnh cho cùng symbol.
 */
export async function createTradeRecord(
  decision,
  snapshot,
  extra = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return {
      created: false,
      skipped: true,
      reason:
        'Trade database chưa được bật',
      trade: null
    };
  }

  const signal =
    decision?.signal || {};

  const symbol =
    String(
      snapshot?.symbol ||
      CONFIG.symbol ||
      ''
    ).trim();

  if (!symbol) {
    throw new Error(
      'Không xác định được symbol để lưu trade'
    );
  }

  const direction =
    normalizeDirection(
      signal.signal
    );

  const entry1 =
    positiveNumber(
      signal.entry1 ??
      signal.entry,
      'entry1'
    );

  const entry2 =
    toNumber(
      signal.entry2
    );

  const stopLoss =
    positiveNumber(
      signal.stopLoss,
      'stopLoss'
    );

  const takeProfit1 =
    positiveNumber(
      signal.takeProfit1,
      'takeProfit1'
    );

  const takeProfit2 =
    positiveNumber(
      signal.takeProfit2,
      'takeProfit2'
    );

  const quantity =
    toNumber(
      decision?.quantity
    );

  const notional =
    toNumber(
      decision?.notional
    );

  const snapshotJson =
    toSafeJson(snapshot);

  const signalJson =
    toSafeJson({
      decision,
      signal,
      extra
    });

  try {
    return await withDatabaseTransaction(
      async client => {
        const existingTrade =
          await getActiveTradeWithClient(
            client,
            symbol,
            true
          );

        if (existingTrade) {
          return {
            created: false,
            skipped: false,
            reason:
              `Đã có trade active #${existingTrade.id}`,
            trade:
              existingTrade
          };
        }

        const insertResult =
          await client.query(
            `
              INSERT INTO ai_trades (
                symbol,
                direction,
                status,
                entry1,
                entry2,
                average_entry,
                stop_loss,
                take_profit1,
                take_profit2,
                confidence,
                rr,
                leverage,
                quantity,
                notional,
                total_quantity,
                total_notional,
                timeframe,
                confirm_timeframe,
                trend_timeframe,
                reason,
                risk_note,
                ai_model,
                execution_mode,
                ai_snapshot,
                ai_signal,
                max_favorable_price,
                max_adverse_price
              )
              VALUES (
                $1,
                $2,
                'OPEN',
                $3,
                $4,
                $3,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $11,
                $12,
                $13,
                $14,
                $15,
                $16,
                $17,
                $18,
                $19,
                $20::jsonb,
                $21::jsonb,
                $3,
                $3
              )
              RETURNING *
            `,
            [
              symbol,
              direction,
              entry1,
              entry2,
              stopLoss,
              takeProfit1,
              takeProfit2,
              toNumber(
                signal.confidence,
                0
              ),
              toNumber(
                decision?.rr,
                0
              ),
              toNumber(
                decision?.leverage ??
                CONFIG.maxLeverage
              ),
              quantity,
              notional,
              snapshot?.entryInterval ||
                snapshot?.interval ||
                CONFIG.entryInterval ||
                CONFIG.interval,
              snapshot?.confirmInterval ||
                CONFIG.confirmInterval ||
                null,
              snapshot?.trendInterval ||
                CONFIG.trendInterval ||
                null,
              String(
                signal.reason || ''
              ),
              String(
                signal.riskNote || ''
              ),
              CONFIG.openaiModel ||
                null,
              CONFIG.executionMode ||
                null,
              JSON.stringify(
                snapshotJson
              ),
              JSON.stringify(
                signalJson
              )
            ]
          );

        const trade =
          normalizeTradeRow(
            insertResult.rows[0]
          );

        await insertTradeEvent(
          client,
          {
            tradeId:
              trade.id,

            eventType:
              'SIGNAL_CREATED',

            eventPrice:
              entry1,

            quantity,

            notional,

            metadata: {
              symbol,
              direction,
              entry1,
              entry2,
              stopLoss,
              takeProfit1,
              takeProfit2,
              confidence:
                toNumber(
                  signal.confidence,
                  0
                ),
              rr:
                toNumber(
                  decision?.rr,
                  0
                ),
              timeframe:
                trade.timeframe
            }
          }
        );

        return {
          created: true,
          skipped: false,
          reason:
            'Đã tạo trade mới',
          trade
        };
      }
    );
  } catch (error) {
    /*
     * PostgreSQL unique violation.
     *
     * Trường hợp hai vòng bot chạy đồng thời,
     * unique index sẽ chỉ cho một lệnh được tạo.
     */
    if (
      error?.code === '23505'
    ) {
      const activeTrade =
        await getActiveTradeBySymbol(
          symbol
        );

      return {
        created: false,
        skipped: false,
        reason:
          'DB đã chặn trade trùng vì đang có lệnh active',
        trade:
          activeTrade
      };
    }

    throw error;
  }
}

/**
 * Lưu event tùy chỉnh.
 */
export async function recordTradeEvent(
  tradeId,
  eventType,
  options = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return insertTradeEvent(
    null,
    {
      tradeId,
      eventType,

      eventPrice:
        options.eventPrice,

      quantity:
        options.quantity,

      notional:
        options.notional,

      metadata:
        options.metadata
    }
  );
}

/**
 * Lưu message ID Telegram FBT/CDT.
 */
export async function updateTradeTelegramResult(
  tradeId,
  telegramResult
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  const fbtMessageId =
    toNumber(
      telegramResult?.fbt
        ?.messageId
    );

  const cdtMessageId =
    toNumber(
      telegramResult?.cdt
        ?.messageId
    );

  return withDatabaseTransaction(
    async client => {
      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              telegram_fbt_message_id =
                COALESCE(
                  $2,
                  telegram_fbt_message_id
                ),

              telegram_cdt_message_id =
                COALESCE(
                  $3,
                  telegram_cdt_message_id
                ),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            fbtMessageId,
            cdtMessageId
          ]
        );

      const trade =
        normalizeTradeRow(
          result.rows[0]
        );

      if (trade) {
        await insertTradeEvent(
          client,
          {
            tradeId,

            eventType:
              'SIGNAL_PUBLISHED',

            eventPrice:
              trade.entry1,

            metadata: {
              sent:
                telegramResult?.sent === true,

              fbt:
                telegramResult?.fbt || null,

              cdt:
                telegramResult?.cdt || null
            }
          }
        );
      }

      return trade;
    }
  );
}

/**
 * Đánh dấu giá đã chạm Entry 2.
 *
 * Đây chưa phải DCA.
 * Monitor chỉ ghi nhận thị trường đã đi tới vùng Entry 2.
 */
export async function markTradeEntry2Hit(
  tradeId,
  hitPrice,
  metadata = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (
        !trade ||
        FINAL_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return trade;
      }

      if (
        trade.entry2_hit_at
      ) {
        return trade;
      }

      if (
        !Number.isFinite(
          toNumber(trade.entry2)
        )
      ) {
        return trade;
      }

      const price =
        positiveNumber(
          hitPrice,
          'entry2 hit price'
        );

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              entry2_hit_at =
                NOW(),

              entry2_hit_price =
                $2,

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            price
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'ENTRY2_HIT',

          eventPrice:
            price,

          metadata
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Ghi nhận DCA vào chính trade đang active.
 *
 * Không tạo trade mới.
 */
export async function recordTradeDca(
  tradeId,
  {
    entryPrice,
    quantity,
    notional,
    metadata = {}
  }
) {
  if (!isTradeRepositoryEnabled()) {
    return {
      recorded: false,
      reason:
        'Trade database chưa bật',
      trade: null
    };
  }

  const dcaEntryPrice =
    positiveNumber(
      entryPrice,
      'DCA entryPrice'
    );

  const dcaQuantity =
    positiveNumber(
      quantity,
      'DCA quantity'
    );

  const dcaNotional =
    toNumber(
      notional,
      dcaEntryPrice * dcaQuantity
    );

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        throw new Error(
          `Không tìm thấy trade #${tradeId}`
        );
      }

      if (
        !ACTIVE_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return {
          recorded: false,
          reason:
            `Trade #${tradeId} không còn active`,
          trade
        };
      }

      if (
        trade.dca_count >=
        Number(
          CONFIG.maxDcaCount || 1
        )
      ) {
        return {
          recorded: false,
          reason:
            `Trade #${tradeId} đã đạt MAX_DCA_COUNT`,
          trade
        };
      }

      const oldQuantity =
        toNumber(
          trade.total_quantity,
          toNumber(
            trade.quantity,
            0
          )
        );

      const oldNotional =
        toNumber(
          trade.total_notional,
          toNumber(
            trade.notional,
            0
          )
        );

      const oldAverageEntry =
        toNumber(
          trade.average_entry,
          trade.entry1
        );

      const newTotalQuantity =
        oldQuantity +
        dcaQuantity;

      const newTotalNotional =
        oldNotional +
        dcaNotional;

      const newAverageEntry =
        newTotalQuantity > 0
          ? (
              (
                oldAverageEntry *
                oldQuantity
              ) +
              (
                dcaEntryPrice *
                dcaQuantity
              )
            ) /
            newTotalQuantity
          : oldAverageEntry;

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              dca_count =
                dca_count + 1,

              average_entry =
                $2,

              total_quantity =
                $3,

              total_notional =
                $4,

              last_dca_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            newAverageEntry,
            newTotalQuantity,
            newTotalNotional
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'DCA',

          eventPrice:
            dcaEntryPrice,

          quantity:
            dcaQuantity,

          notional:
            dcaNotional,

          metadata: {
            previousAverageEntry:
              oldAverageEntry,

            newAverageEntry,

            previousQuantity:
              oldQuantity,

            newTotalQuantity,

            previousNotional:
              oldNotional,

            newTotalNotional,

            ...metadata
          }
        }
      );

      return {
        recorded: true,
        reason:
          'Đã ghi nhận DCA',
        trade:
          updatedTrade
      };
    }
  );
}

/**
 * Đánh dấu TP1.
 *
 * Trade vẫn active và tiếp tục chờ TP2 hoặc SL.
 */
export async function markTradeTp1(
  tradeId,
  hitPrice,
  metadata = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      if (
        FINAL_TRADE_STATUSES.includes(
          trade.status
        ) ||
        trade.tp1_hit_at
      ) {
        return trade;
      }

      const price =
        positiveNumber(
          hitPrice,
          'TP1 hit price'
        );

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              status =
                'TP1_HIT',

              tp1_hit_at =
                NOW(),

              tp1_hit_price =
                $2,

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            price
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'TP1_HIT',

          eventPrice:
            price,

          metadata
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Đánh dấu TP2 và đóng trade.
 *
 * Nếu giá đi thẳng tới TP2 mà monitor
 * chưa ghi TP1, hệ thống tự ghi TP1 trước.
 */
export async function markTradeTp2(
  tradeId,
  hitPrice,
  metadata = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      if (
        FINAL_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return trade;
      }

      const price =
        positiveNumber(
          hitPrice,
          'TP2 hit price'
        );

      if (!trade.tp1_hit_at) {
        await client.query(
          `
            UPDATE ai_trades
            SET
              tp1_hit_at =
                NOW(),

              tp1_hit_price =
                take_profit1,

              updated_at =
                NOW()

            WHERE id = $1
          `,
          [
            tradeId
          ]
        );

        await insertTradeEvent(
          client,
          {
            tradeId,

            eventType:
              'TP1_HIT',

            eventPrice:
              trade.take_profit1,

            metadata: {
              automaticallyDetected:
                true,

              reason:
                'TP2 được phát hiện trước khi TP1 được ghi nhận'
            }
          }
        );
      }

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              status =
                'TP2_HIT',

              outcome =
                'WIN_TP2',

              tp2_hit_at =
                NOW(),

              tp2_hit_price =
                $2,

              closed_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            price
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'TP2_HIT',

          eventPrice:
            price,

          metadata
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Đánh dấu SL và đóng trade.
 *
 * Nếu đã đạt TP1 rồi mới SL:
 * outcome = TP1_THEN_SL
 *
 * Nếu chưa đạt TP1:
 * outcome = LOSS_SL
 */
export async function markTradeStopLoss(
  tradeId,
  hitPrice,
  metadata = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      if (
        FINAL_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return trade;
      }

      const price =
        positiveNumber(
          hitPrice,
          'SL hit price'
        );

      const outcome =
        trade.tp1_hit_at
          ? 'TP1_THEN_SL'
          : 'LOSS_SL';

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              status =
                'SL_HIT',

              outcome =
                $2,

              sl_hit_at =
                NOW(),

              sl_hit_price =
                $3,

              closed_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            outcome,
            price
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'SL_HIT',

          eventPrice:
            price,

          metadata: {
            outcome,
            ...metadata
          }
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Đánh dấu trade hết hạn.
 */
export async function markTradeExpired(
  tradeId,
  metadata = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      if (
        FINAL_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return trade;
      }

      const outcome =
        trade.tp1_hit_at
          ? 'WIN_TP1'
          : 'EXPIRED';

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              status =
                'EXPIRED',

              outcome =
                $2,

              closed_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            outcome
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'EXPIRED',

          eventPrice:
            metadata.currentPrice,

          metadata: {
            outcome,
            ...metadata
          }
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Hủy trade thủ công.
 */
export async function markTradeCancelled(
  tradeId,
  reason = ''
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      if (
        FINAL_TRADE_STATUSES.includes(
          trade.status
        )
      ) {
        return trade;
      }

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              status =
                'CANCELLED',

              outcome =
                'CANCELLED',

              closed_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId
          ]
        );

      const updatedTrade =
        normalizeTradeRow(
          result.rows[0]
        );

      await insertTradeEvent(
        client,
        {
          tradeId,

          eventType:
            'CANCELLED',

          eventPrice:
            null,

          metadata: {
            reason
          }
        }
      );

      return updatedTrade;
    }
  );
}

/**
 * Cập nhật trạng thái monitor:
 * - Nến cuối đã kiểm tra
 * - Mức giá thuận lợi nhất
 * - Mức giá bất lợi nhất
 */
export async function updateTradeMonitoringState(
  tradeId,
  {
    highPrice = null,
    lowPrice = null,
    currentPrice = null,
    lastCheckedCandleTime = null
  } = {}
) {
  if (!isTradeRepositoryEnabled()) {
    return null;
  }

  return withDatabaseTransaction(
    async client => {
      const trade =
        await getTradeByIdWithClient(
          client,
          tradeId,
          true
        );

      if (!trade) {
        return null;
      }

      const high =
        toNumber(
          highPrice,
          toNumber(currentPrice)
        );

      const low =
        toNumber(
          lowPrice,
          toNumber(currentPrice)
        );

      const basePrice =
        toNumber(
          trade.average_entry,
          trade.entry1
        );

      let favorable =
        toNumber(
          trade.max_favorable_price,
          basePrice
        );

      let adverse =
        toNumber(
          trade.max_adverse_price,
          basePrice
        );

      if (
        trade.direction === 'LONG'
      ) {
        if (
          Number.isFinite(high)
        ) {
          favorable =
            Math.max(
              favorable,
              high
            );
        }

        if (
          Number.isFinite(low)
        ) {
          adverse =
            Math.min(
              adverse,
              low
            );
        }
      }

      if (
        trade.direction === 'SHORT'
      ) {
        if (
          Number.isFinite(low)
        ) {
          favorable =
            Math.min(
              favorable,
              low
            );
        }

        if (
          Number.isFinite(high)
        ) {
          adverse =
            Math.max(
              adverse,
              high
            );
        }
      }

      const result =
        await client.query(
          `
            UPDATE ai_trades
            SET
              last_checked_at =
                NOW(),

              last_checked_candle_time =
                COALESCE(
                  $2,
                  last_checked_candle_time
                ),

              max_favorable_price =
                $3,

              max_adverse_price =
                $4,

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
          `,
          [
            tradeId,
            toNumber(
              lastCheckedCandleTime
            ),
            favorable,
            adverse
          ]
        );

      return normalizeTradeRow(
        result.rows[0]
      );
    }
  );
}

/**
 * Lấy lịch sử event của một trade.
 */
export async function getTradeEvents(
  tradeId
) {
  if (!isTradeRepositoryEnabled()) {
    return [];
  }

  const result =
    await queryDatabase(
      `
        SELECT *
        FROM ai_trade_events
        WHERE trade_id = $1
        ORDER BY created_at ASC
      `,
      [
        tradeId
      ]
    );

  return result.rows.map(
    normalizeEventRow
  );
}
