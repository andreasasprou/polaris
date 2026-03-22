"use client";

import type { DiffLine as DiffLineType } from "@/lib/diff/types";

const LINE_STYLES: Record<DiffLineType["type"], string> = {
  addition: "text-emerald-600 bg-emerald-500/5 dark:text-emerald-400",
  deletion: "text-red-600 bg-red-500/5 dark:text-red-400",
  hunk_header: "text-blue-500",
  context: "text-muted-foreground",
};

const GUTTER_STYLES: Record<DiffLineType["type"], string> = {
  addition: "text-emerald-400/60",
  deletion: "text-red-400/60",
  hunk_header: "text-blue-400/60",
  context: "text-muted-foreground/40",
};

function formatLineNo(lineNo: number | undefined): string {
  if (lineNo == null) return "";
  return String(lineNo);
}

export function DiffLine({ line }: { line: DiffLineType }) {
  const prefix =
    line.type === "addition"
      ? "+"
      : line.type === "deletion"
        ? "-"
        : line.type === "hunk_header"
          ? ""
          : " ";

  return (
    <div className={`flex font-mono text-xs leading-5 ${LINE_STYLES[line.type]}`}>
      {/* Line number gutter */}
      {line.type !== "hunk_header" && (
        <>
          <span
            className={`w-10 shrink-0 select-none text-right ${GUTTER_STYLES[line.type]}`}
          >
            {formatLineNo(line.oldLineNo)}
          </span>
          <span
            className={`w-10 shrink-0 select-none text-right ${GUTTER_STYLES[line.type]}`}
          >
            {formatLineNo(line.newLineNo)}
          </span>
        </>
      )}

      {/* Prefix (+/-/space) */}
      <span
        className={`w-5 shrink-0 select-none text-center ${GUTTER_STYLES[line.type]}`}
      >
        {prefix}
      </span>

      {/* Content */}
      <span className="min-w-0 whitespace-pre-wrap break-all pr-4">
        {line.content}
      </span>
    </div>
  );
}
