import { Pool } from "pg";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

type AccountTokenRow = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
};

function looksEncrypted(value: string) {
  return value.startsWith("$ba$")
    || (value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value));
}

async function ensureEncrypted(value: string, secret: string) {
  if (looksEncrypted(value)) {
    try {
      await symmetricDecrypt({ key: secret, data: value });
      return value;
    } catch {
    }
  }

  return symmetricEncrypt({ key: secret, data: value });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query<AccountTokenRow>(
      `select id, access_token, refresh_token, id_token from account`,
    );

    let updatedRows = 0;
    for (const row of rows) {
      const nextAccessToken = row.access_token
        ? await ensureEncrypted(row.access_token, betterAuthSecret)
        : null;
      const nextRefreshToken = row.refresh_token
        ? await ensureEncrypted(row.refresh_token, betterAuthSecret)
        : null;
      const nextIdToken = row.id_token
        ? await ensureEncrypted(row.id_token, betterAuthSecret)
        : null;

      if (
        nextAccessToken === row.access_token
        && nextRefreshToken === row.refresh_token
        && nextIdToken === row.id_token
      ) {
        continue;
      }

      await client.query(
        `update account
         set access_token = $2,
             refresh_token = $3,
             id_token = $4
         where id = $1`,
        [row.id, nextAccessToken, nextRefreshToken, nextIdToken],
      );
      updatedRows += 1;
    }

    await client.query("COMMIT");
    console.log(
      `[backfill-oauth-token-encryption] Updated ${updatedRows} account row(s).`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "[backfill-oauth-token-encryption] Failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
