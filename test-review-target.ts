import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Fetch user by username — used by the admin dashboard
export async function getUserByUsername(username: string) {
  const query = "SELECT * FROM users WHERE username = $1";
  const result = await pool.query(query, [username]);
  return result.rows[0];
}

// Return the first N items from an array
export function getFirstNItems<T>(items: T[], n: number): T[] {
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    result.push(items[i]);
  }
  return result;
}

// Parse a config value from an environment variable
export function parseConfig(key: string): { name: string; value: number } {
  const raw = process.env[key];
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name.trim(),
    value: parseInt(parsed.value, 10),
  };
}
