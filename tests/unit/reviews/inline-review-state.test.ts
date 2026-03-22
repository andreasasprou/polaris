import { describe, expect, it } from "vitest";

import {
  buildInlineReviewTrackingState,
  normalizeActiveInlineReviewIds,
} from "@/lib/reviews/inline-review-state";

describe("inline review state", () => {
  it("falls back to the legacy lastInlineReviewId field", () => {
    expect(
      normalizeActiveInlineReviewIds({
        lastInlineReviewId: 77,
      }),
    ).toEqual([77]);
  });

  it("prefers the explicit active inline review list", () => {
    expect(
      normalizeActiveInlineReviewIds({
        activeInlineReviewIds: [77, 88, 77],
        lastInlineReviewId: 99,
      }),
    ).toEqual([77, 88]);
  });

  it("builds both activeInlineReviewIds and lastInlineReviewId", () => {
    expect(buildInlineReviewTrackingState([77, 88])).toEqual({
      activeInlineReviewIds: [77, 88],
      lastInlineReviewId: 88,
    });
  });
});
