import crypto from "crypto";

/**
 * Generate a random HMAC key for a job.
 * Stored in jobs.hmac_key (dedicated column, never in payload).
 */
export function generateJobHmacKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Sign a callback payload with HMAC-SHA256.
 * The signature goes in the X-Callback-Signature header.
 */
export function signCallback(
  payload: Record<string, unknown>,
  hmacKey: string,
): string {
  return crypto
    .createHmac("sha256", hmacKey)
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Verify a callback signature against the expected HMAC.
 * Returns true if the signature matches.
 */
export function verifyCallback(
  payload: Record<string, unknown>,
  signature: string,
  hmacKey: string,
): boolean {
  const expected = signCallback(payload, hmacKey);
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}
