import { db } from "@/lib/db";
import { eventDeliveries } from "./schema";

/**
 * Atomically claim an event delivery. Returns true if claimed (not a duplicate),
 * false if the dedupeKey already exists. This replaces the old isDuplicate() +
 * recordDelivery() pattern which had a TOCTOU race.
 */
export async function claimDelivery(input: {
  source: string;
  externalEventId?: string;
  sourceDeliveryId?: string;
  dedupeKey: string;
  organizationId: string;
}): Promise<boolean> {
  const result = await db
    .insert(eventDeliveries)
    .values({
      ...input,
      processedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: eventDeliveries.id });
  return result.length > 0;
}
