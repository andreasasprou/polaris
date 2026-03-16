/**
 * Sandbox REST Proxy — Callback Delivery
 *
 * HMAC-SHA256 signing and HTTP POST with retry.
 * Every callback is written to outbox BEFORE delivery attempt.
 */

import crypto from "node:crypto";
import type { CallbackBody, CallbackType, OutboxEntry } from "./types";
import {
  createOutboxEntry,
  markDelivered,
  markFailed,
  incrementAttempts,
  readPendingEntries,
} from "./outbox";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 4s, 16s

/**
 * Sign a callback body with HMAC-SHA256.
 */
function signPayload(body: CallbackBody, hmacKey: string): string {
  return crypto
    .createHmac("sha256", hmacKey)
    .update(JSON.stringify(body))
    .digest("hex");
}

/**
 * Deliver a single callback via HTTP POST with retry.
 */
async function deliverEntry(
  entry: OutboxEntry,
  callbackUrl: string,
  hmacKey: string,
): Promise<boolean> {
  const body: CallbackBody = {
    jobId: entry.jobId,
    attemptId: entry.attemptId,
    epoch: entry.epoch,
    callbackId: entry.callbackId,
    callbackType: entry.callbackType,
    payload: entry.payload,
  };

  const signature = signPayload(body, hmacKey);
  const jsonBody = JSON.stringify(body);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BACKOFF_BASE_MS * Math.pow(4, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }

    incrementAttempts(entry.callbackId);

    try {
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Callback-Signature": signature,
        },
        body: jsonBody,
        signal: AbortSignal.timeout(30_000),
      });

      // 200 or 409 = delivered (no retry needed)
      if (res.ok || res.status === 409) {
        markDelivered(entry.callbackId);
        return true;
      }

      // 4xx (non-409) = permanent failure, don't retry
      if (res.status >= 400 && res.status < 500) {
        console.error(
          `[proxy] Callback ${entry.callbackId} rejected with ${res.status}`,
        );
        markFailed(entry.callbackId);
        return false;
      }

      // 5xx = retry
      console.warn(
        `[proxy] Callback ${entry.callbackId} delivery attempt ${attempt + 1} failed: ${res.status}`,
      );
    } catch (err) {
      console.warn(
        `[proxy] Callback ${entry.callbackId} delivery attempt ${attempt + 1} error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // All retries exhausted
  markFailed(entry.callbackId);
  return false;
}

/**
 * Create a callback, write to outbox, and deliver.
 * Returns the outbox entry (check .status for delivery result).
 */
export async function emitCallback(params: {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
  callbackUrl: string;
  hmacKey: string;
}): Promise<OutboxEntry> {
  // Write to outbox first (durable before delivery attempt)
  const entry = createOutboxEntry({
    jobId: params.jobId,
    attemptId: params.attemptId,
    epoch: params.epoch,
    callbackType: params.callbackType,
    payload: params.payload,
  });

  // Attempt delivery (non-blocking on failure — sweeper picks up later)
  await deliverEntry(entry, params.callbackUrl, params.hmacKey);

  return entry;
}

/**
 * Replay all pending/failed outbox entries.
 * Called on proxy startup and periodically.
 */
export async function replayPendingCallbacks(
  callbackUrl: string,
  hmacKey: string,
): Promise<void> {
  const entries = readPendingEntries();
  if (entries.length === 0) return;

  console.log(`[proxy] Replaying ${entries.length} pending callbacks`);

  for (const entry of entries) {
    await deliverEntry(entry, callbackUrl, hmacKey);
  }
}
