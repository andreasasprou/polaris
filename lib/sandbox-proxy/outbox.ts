/**
 * Sandbox REST Proxy — Durable Callback Outbox
 *
 * Each callback is a JSON file in /tmp/polaris-proxy/outbox/.
 * Atomic writes via rename prevent partial writes on crash.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { OutboxEntry, OutboxEntryStatus, CallbackType } from "./types";

const OUTBOX_DIR = "/tmp/polaris-proxy/outbox";

export function ensureOutboxDir(): void {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
}

export function generateCallbackId(): string {
  return crypto.randomUUID();
}

/**
 * Write an outbox entry atomically (write to .tmp then rename).
 */
export function writeOutboxEntry(entry: OutboxEntry): void {
  const finalPath = path.join(OUTBOX_DIR, `${entry.callbackId}.json`);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Create and write a new outbox entry.
 */
export function createOutboxEntry(params: {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
}): OutboxEntry {
  const entry: OutboxEntry = {
    callbackId: generateCallbackId(),
    jobId: params.jobId,
    attemptId: params.attemptId,
    epoch: params.epoch,
    callbackType: params.callbackType,
    payload: params.payload,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  writeOutboxEntry(entry);
  return entry;
}

/**
 * Read all outbox entries (all statuses).
 */
export function readAllEntries(): OutboxEntry[] {
  if (!fs.existsSync(OUTBOX_DIR)) return [];

  const files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".json"));
  const entries: OutboxEntry[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(OUTBOX_DIR, file), "utf-8");
      entries.push(JSON.parse(content) as OutboxEntry);
    } catch {
      // Skip corrupt files
    }
  }

  return entries;
}

/**
 * Read pending/failed entries (for delivery retry and GET /outbox).
 */
export function readPendingEntries(): OutboxEntry[] {
  return readAllEntries().filter(
    (e) => e.status === "pending" || e.status === "failed",
  );
}

/**
 * Update the status of an outbox entry.
 */
function updateEntryStatus(
  callbackId: string,
  status: OutboxEntryStatus,
  extra?: Partial<OutboxEntry>,
): void {
  const filePath = path.join(OUTBOX_DIR, `${callbackId}.json`);
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entry = JSON.parse(content) as OutboxEntry;
    entry.status = status;
    if (extra) Object.assign(entry, extra);
    writeOutboxEntry(entry);
  } catch {
    // Best-effort update
  }
}

export function markDelivered(callbackId: string): void {
  updateEntryStatus(callbackId, "delivered");
}

export function markFailed(callbackId: string): void {
  updateEntryStatus(callbackId, "failed", {
    lastAttemptAt: new Date().toISOString(),
  });
}

export function incrementAttempts(callbackId: string): void {
  const filePath = path.join(OUTBOX_DIR, `${callbackId}.json`);
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entry = JSON.parse(content) as OutboxEntry;
    entry.attempts += 1;
    entry.lastAttemptAt = new Date().toISOString();
    writeOutboxEntry(entry);
  } catch {
    // Best-effort
  }
}

/**
 * Delete old delivered entries (cleanup).
 */
export function pruneDelivered(olderThanMs: number = 60 * 60 * 1000): void {
  const entries = readAllEntries();
  const cutoff = Date.now() - olderThanMs;

  for (const entry of entries) {
    if (entry.status === "delivered" && new Date(entry.createdAt).getTime() < cutoff) {
      const filePath = path.join(OUTBOX_DIR, `${entry.callbackId}.json`);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
