export function normalizeActiveInlineReviewIds(input: {
  activeInlineReviewIds?: number[] | null;
  lastInlineReviewId?: number | null;
}): number[] {
  const ids = input.activeInlineReviewIds?.length
    ? input.activeInlineReviewIds
    : input.lastInlineReviewId != null
      ? [input.lastInlineReviewId]
      : [];

  return Array.from(
    new Set(
      ids.filter(
        (reviewId): reviewId is number =>
          Number.isInteger(reviewId) && reviewId > 0,
      ),
    ),
  );
}

export function buildInlineReviewTrackingState(activeInlineReviewIds: number[]) {
  return {
    activeInlineReviewIds,
    lastInlineReviewId:
      activeInlineReviewIds[activeInlineReviewIds.length - 1] ?? null,
  };
}
