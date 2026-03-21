import { pool } from "@/lib/db";

const SCHEMA = "sandbox_agent";

/**
 * Query the SDK's persisted events directly from Postgres.
 * The SDK's persist-postgres driver stores events in sandbox_agent.events.
 */
export async function getSessionEvents(
  sessionId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  // Check if schema/table exists (driver auto-creates on first use)
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'events'
    )`,
    [SCHEMA],
  );

  if (!tableCheck.rows[0]?.exists) {
    return { items: [], total: 0 };
  }

  const [eventsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, event_index, session_id, created_at, connection_id, sender, payload_json
       FROM "${SCHEMA}"."events"
       WHERE session_id = $1
       ORDER BY event_index ASC
       LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM "${SCHEMA}"."events" WHERE session_id = $1`,
      [sessionId],
    ),
  ]);

  return {
    items: eventsResult.rows.map((row) => ({
      id: row.id,
      eventIndex: Number(row.event_index),
      sessionId: row.session_id,
      createdAt: Number(row.created_at),
      connectionId: row.connection_id,
      sender: row.sender as "client" | "agent",
      payload: row.payload_json,
    })),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/** Driver-compatible event shape matching @sandbox-agent/persist-postgres schema. */
type DriverEvent = {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: string;
  payload: Record<string, unknown>;
};

const ENSURE_TABLE_SQL = `
  CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";
  CREATE TABLE IF NOT EXISTS "${SCHEMA}"."events" (
    id TEXT PRIMARY KEY,
    event_index BIGINT NOT NULL,
    session_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    connection_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    payload_json JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session_order
    ON "${SCHEMA}"."events"(session_id, event_index, id);
`;

let tableEnsured = false;

async function ensureEventsTable() {
  if (tableEnsured) return;
  await pool.query(ENSURE_TABLE_SQL);
  tableEnsured = true;
}

/**
 * Persist events received from the sandbox proxy's session_events callback.
 * Uses the exact schema from @sandbox-agent/persist-postgres for compatibility.
 * Idempotent via ON CONFLICT(id) DO NOTHING.
 */
export async function persistSessionEvents(events: DriverEvent[]) {
  if (events.length === 0) return;

  await ensureEventsTable();

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const event of events) {
    placeholders.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
    );
    values.push(
      event.id,
      event.eventIndex,
      event.sessionId,
      event.createdAt,
      event.connectionId,
      event.sender,
      JSON.stringify(event.payload),
    );
  }

  await pool.query(
    `INSERT INTO "${SCHEMA}"."events" (id, event_index, session_id, created_at, connection_id, sender, payload_json)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT(id) DO NOTHING`,
    values,
  );
}

/**
 * Get the highest event_index for a session. Used to compute nextEventIndex
 * for resumed prompts so event indexes remain monotonic across turns.
 */
export async function getMaxEventIndex(sessionId: string): Promise<number | null> {
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'events'
    )`,
    [SCHEMA],
  );
  if (!tableCheck.rows[0]?.exists) return null;

  const result = await pool.query(
    `SELECT MAX(event_index) as max_index FROM "${SCHEMA}"."events" WHERE session_id = $1`,
    [sessionId],
  );
  const val = result.rows[0]?.max_index;
  return val != null ? Number(val) : null;
}

/** Compute the next event index for a session (MAX + 1, or 0 if no events). */
export async function getNextEventIndex(sdkSessionId: string | null | undefined): Promise<number> {
  if (!sdkSessionId) return 0;
  const max = await getMaxEventIndex(sdkSessionId);
  return max != null ? max + 1 : 0;
}

export async function getSessionRecord(sessionId: string) {
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'sessions'
    )`,
    [SCHEMA],
  );

  if (!tableCheck.rows[0]?.exists) {
    return null;
  }

  const result = await pool.query(
    `SELECT id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, session_init_json
     FROM "${SCHEMA}"."sessions"
     WHERE id = $1`,
    [sessionId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id as string,
    agent: row.agent as string,
    agentSessionId: row.agent_session_id as string,
    createdAt: Number(row.created_at),
    destroyedAt: row.destroyed_at ? Number(row.destroyed_at) : undefined,
  };
}
