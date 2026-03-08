import { Pool } from "pg";

const SCHEMA = "sandbox_agent";

/**
 * Query the SDK's persisted events directly from Postgres.
 * The SDK's persist-postgres driver stores events in sandbox_agent.events.
 */
export async function getSessionEvents(
  sessionId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  try {
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
  } finally {
    await pool.end();
  }
}

export async function getSessionRecord(sessionId: string) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

  try {
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
  } finally {
    await pool.end();
  }
}
