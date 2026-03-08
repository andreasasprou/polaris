import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { eventDeliveries } from "./schema";

/**
 * Check if an event has already been processed.
 * Returns true if this is a duplicate.
 */
export async function isDuplicate(dedupeKey: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: eventDeliveries.id })
    .from(eventDeliveries)
    .where(eq(eventDeliveries.dedupeKey, dedupeKey))
    .limit(1);
  return !!existing;
}

/**
 * Record that an event has been delivered.
 */
export async function recordDelivery(input: {
  source: string;
  externalEventId?: string;
  sourceDeliveryId?: string;
  dedupeKey: string;
  organizationId: string;
}) {
  await db
    .insert(eventDeliveries)
    .values({
      ...input,
      processedAt: new Date(),
    })
    .onConflictDoNothing();
}
