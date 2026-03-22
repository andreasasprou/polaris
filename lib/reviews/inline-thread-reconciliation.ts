import type { ChangedLineIndex } from "./diff";
import type { InlineAnchor, TrackedInlineThread } from "./types";

function rangeStart(input: { startLine?: number; line: number }) {
  return input.startLine ?? input.line;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function threadOverlapsChangedLines(
  thread: TrackedInlineThread,
  ranges: Array<{ start: number; end: number }>,
) {
  const start = rangeStart(thread);
  return ranges.some((range) => rangesOverlap(start, thread.line, range.start, range.end));
}

function anchorOverlapsThread(
  anchor: InlineAnchor,
  thread: TrackedInlineThread,
) {
  if (anchor.file !== thread.file) return false;
  return rangesOverlap(
    rangeStart(anchor),
    anchor.line,
    rangeStart(thread),
    thread.line,
  );
}

export function dedupeTrackedInlineThreads(
  threads: TrackedInlineThread[],
) {
  const deduped = new Map<string, TrackedInlineThread>();

  for (const thread of threads) {
    deduped.set(thread.threadId, thread);
  }

  return Array.from(deduped.values());
}

export function buildInlineCommentMapFromTrackedThreads(
  threads: TrackedInlineThread[],
) {
  const map: Record<string, number> = {};

  for (const thread of threads) {
    if (!thread.issueId || !Number.isInteger(thread.commentId) || thread.commentId <= 0) continue;
    map[thread.issueId] = thread.commentId;
  }

  return map;
}

export function reconcileInlineThreads(input: {
  priorThreads: TrackedInlineThread[];
  changedLineIndex: ChangedLineIndex;
  currentInlineAnchors: InlineAnchor[];
}) {
  const carryForward: TrackedInlineThread[] = [];
  const autoResolve: TrackedInlineThread[] = [];
  const overlapBlocked: TrackedInlineThread[] = [];

  for (const thread of input.priorThreads) {
    const changedRanges = input.changedLineIndex.get(thread.file);
    if (!changedRanges || changedRanges.length === 0) {
      carryForward.push(thread);
      continue;
    }

    if (!threadOverlapsChangedLines(thread, changedRanges)) {
      carryForward.push(thread);
      continue;
    }

    const hasOverlappingAnchor = input.currentInlineAnchors.some((anchor) =>
      anchorOverlapsThread(anchor, thread),
    );

    if (hasOverlappingAnchor) {
      overlapBlocked.push(thread);
      continue;
    }

    autoResolve.push(thread);
  }

  return {
    carryForward,
    autoResolve,
    overlapBlocked,
  };
}
