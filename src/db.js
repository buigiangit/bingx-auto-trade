import pg from 'pg';
import { CONFIG } from './config.js';

const { Pool } = pg;

let pool = null;
let databaseInitialized = false;

/**
 * Kiểm tra DB có được bật không.
 */
export function isDatabaseEnabled() {
  return (
    CONFIG.tradeDbEnabled === true &&
    Boolean(CONFIG.databaseUrl)
  );
}

/**
 * Khởi tạo PostgreSQL connection pool.
 */
export function getDatabasePool() {
  if (!isDatabaseEnabled()) {
    throw new Error(
      'PostgreSQL chưa được bật hoặc thiếu DATABASE_URL'
    );
  }

  if (!pool) {
    pool = new Pool({
      connectionString:
        CONFIG.databaseUrl,

      max:
        Math.max(
          1,
          Number(
            CONFIG.databasePoolMax || 5
          )
        ),

      idleTimeoutMillis:
        Math.max(
          1000,
          Number(
            CONFIG.databaseIdleTimeoutMs ||
            30000
          )
        ),

      connectionTimeoutMillis:
        Math.max(
          1000,
          Number(
            CONFIG.databaseConnectionTimeoutMs ||
            10000
          )
        ),

      keepAlive:
        true,

      ssl:
        CONFIG.databaseSsl
          ? {
              rejectUnauthorized: false
            }
          : false
    });

    pool.on('error', error => {
      console.error(
        'PostgreSQL pool error:',
        error.message ||
        String(error)
      );
    });
  }

  return pool;
}

/**
 * Thực hiện truy vấn PostgreSQL.
 */
export async function queryDatabase(
  text,
  params = []
) {
  const databasePool =
    getDatabasePool();

  return databasePool.query(
    text,
    params
  );
}

/**
 * Chạy nhiều truy vấn trong transaction.
 */
export async function withDatabaseTransaction(
  callback
) {
  if (typeof callback !== 'function') {
    throw new Error(
      'withDatabaseTransaction yêu cầu callback'
    );
  }

  const databasePool =
    getDatabasePool();

  const client =
    await databasePool.connect();

  try {
    await client.query('BEGIN');

    const result =
      await callback(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        'PostgreSQL rollback error:',
        rollbackError.message ||
        String(rollbackError)
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Kiểm tra kết nối PostgreSQL.
 */
export async function testDatabaseConnection() {
  if (!isDatabaseEnabled()) {
    console.log(
      'Trade database: OFF'
    );

    return {
      connected: false,
      enabled: false
    };
  }

  const result =
    await queryDatabase(`
      SELECT
        NOW() AS database_time,
        current_database() AS database_name
    `);

  const row =
    result.rows[0] || {};

  console.log(
    'Trade database: CONNECTED',
    {
      database:
        row.database_name,

      time:
        row.database_time
    }
  );

  return {
    connected: true,
    enabled: true,
    databaseName:
      row.database_name,

    databaseTime:
      row.database_time
  };
}

/**
 * Tạo bảng lưu lệnh AI.
 */
async function createTradesTable() {
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS ai_trades (
      id BIGSERIAL PRIMARY KEY,

      symbol VARCHAR(30) NOT NULL,
      direction VARCHAR(10) NOT NULL,

      status VARCHAR(30)
        NOT NULL
        DEFAULT 'OPEN',

      outcome VARCHAR(30),

      entry1 NUMERIC(30, 12)
        NOT NULL,

      entry2 NUMERIC(30, 12),

      average_entry NUMERIC(30, 12),

      entry2_hit_at TIMESTAMPTZ,
      entry2_hit_price NUMERIC(30, 12),

      stop_loss NUMERIC(30, 12)
        NOT NULL,

      take_profit1 NUMERIC(30, 12)
        NOT NULL,

      take_profit2 NUMERIC(30, 12)
        NOT NULL,

      confidence NUMERIC(8, 2),
      rr NUMERIC(12, 4),

      leverage NUMERIC(12, 4),
      quantity NUMERIC(30, 12),
      notional NUMERIC(30, 12),

      timeframe VARCHAR(20),
      confirm_timeframe VARCHAR(20),
      trend_timeframe VARCHAR(20),

      reason TEXT,
      risk_note TEXT,

      ai_model VARCHAR(100),
      execution_mode VARCHAR(30),

      ai_snapshot JSONB,
      ai_signal JSONB,

      dca_count INTEGER
        NOT NULL
        DEFAULT 0,

      total_quantity NUMERIC(30, 12),
      total_notional NUMERIC(30, 12),

      last_dca_at TIMESTAMPTZ,

      tp1_hit_at TIMESTAMPTZ,
      tp1_hit_price NUMERIC(30, 12),

      tp2_hit_at TIMESTAMPTZ,
      tp2_hit_price NUMERIC(30, 12),

      sl_hit_at TIMESTAMPTZ,
      sl_hit_price NUMERIC(30, 12),

      opened_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      closed_at TIMESTAMPTZ,

      last_checked_at TIMESTAMPTZ,

      last_checked_candle_time BIGINT,

      max_favorable_price NUMERIC(30, 12),

      max_adverse_price NUMERIC(30, 12),

      telegram_fbt_message_id BIGINT,

      telegram_cdt_message_id BIGINT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      CONSTRAINT ai_trades_direction_check
        CHECK (
          direction IN (
            'LONG',
            'SHORT'
          )
        ),

      CONSTRAINT ai_trades_status_check
        CHECK (
          status IN (
            'OPEN',
            'TP1_HIT',
            'TP2_HIT',
            'SL_HIT',
            'EXPIRED',
            'CANCELLED'
          )
        )
    )
  `);
}

/**
 * Tạo bảng lịch sử sự kiện.
 */
async function createTradeEventsTable() {
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS ai_trade_events (
      id BIGSERIAL PRIMARY KEY,

      trade_id BIGINT
        NOT NULL
        REFERENCES ai_trades(id)
        ON DELETE CASCADE,

      event_type VARCHAR(40)
        NOT NULL,

      event_price NUMERIC(30, 12),

      quantity NUMERIC(30, 12),

      notional NUMERIC(30, 12),

      metadata JSONB,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    )
  `);
}

/**
 * Tạo index chống hai lệnh active
 * cùng symbol.
 *
 * OPEN và TP1_HIT đều được xem là
 * lệnh vẫn đang hoạt động.
 */
async function createTradeIndexes() {
  await queryDatabase(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      uq_ai_trades_active_symbol
    ON ai_trades(symbol)
    WHERE status IN (
      'OPEN',
      'TP1_HIT'
    )
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trades_status
    ON ai_trades(status)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trades_symbol
    ON ai_trades(symbol)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trades_opened_at
    ON ai_trades(opened_at DESC)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trades_closed_at
    ON ai_trades(closed_at DESC)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trade_events_trade_id
    ON ai_trade_events(trade_id)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trade_events_type
    ON ai_trade_events(event_type)
  `);

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS
      idx_ai_trade_events_created_at
    ON ai_trade_events(created_at DESC)
  `);
}

/**
 * Bổ sung cột khi bảng cũ đã tồn tại.
 *
 * Giúp deploy bản mới không cần xóa DB.
 */
async function ensureTradeColumns() {
  const statements = [
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        confirm_timeframe VARCHAR(20)
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        trend_timeframe VARCHAR(20)
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        ai_model VARCHAR(100)
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        execution_mode VARCHAR(30)
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        entry2_hit_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        entry2_hit_price NUMERIC(30, 12)
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        last_dca_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        telegram_fbt_message_id BIGINT
    `,
    `
      ALTER TABLE ai_trades
      ADD COLUMN IF NOT EXISTS
        telegram_cdt_message_id BIGINT
    `
  ];

  for (const statement of statements) {
    await queryDatabase(statement);
  }
}

/**
 * Khởi tạo toàn bộ cấu trúc database.
 */
export async function initializeDatabase() {
  if (!isDatabaseEnabled()) {
    console.log(
      'Trade database initialization: SKIPPED'
    );

    return {
      initialized: false,
      enabled: false
    };
  }

  if (databaseInitialized) {
    return {
      initialized: true,
      enabled: true,
      reused: true
    };
  }

  await testDatabaseConnection();

  await createTradesTable();

  await ensureTradeColumns();

  await createTradeEventsTable();

  await createTradeIndexes();

  databaseInitialized = true;

  console.log(
    'Trade database tables: READY'
  );

  return {
    initialized: true,
    enabled: true
  };
}

/**
 * Đóng PostgreSQL pool khi bot dừng.
 */
export async function closeDatabase() {
  if (!pool) {
    return;
  }

  const currentPool =
    pool;

  pool = null;
  databaseInitialized = false;

  await currentPool.end();

  console.log(
    'Trade database connection: CLOSED'
  );
}
