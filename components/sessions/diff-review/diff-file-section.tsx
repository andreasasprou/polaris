"use client";

import { useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import type { FileChange } from "@/lib/diff/types";

const MAX_DISPLAY_LINES = 5000;

/** Map common file extensions to highlight.js language identifiers. */
function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    mdx: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    toml: "toml",
    xml: "xml",
    svg: "xml",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
  };
  return map[ext] ?? "";
}

export function DiffFileSection({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);
  const { resolvedTheme } = useTheme();

  const fileName = file.path.split("/").pop() ?? file.path;
  const lang = langFromPath(file.path);
  const diffTheme = resolvedTheme === "dark" ? "dark" : "light";
  const tooLarge = file.parsedLines.length > MAX_DISPLAY_LINES;

  const diffData = useMemo(
    () => ({
      oldFile: { fileName: file.path, fileLang: lang, content: "" },
      newFile: { fileName: file.path, fileLang: lang, content: "" },
      hunks: [file.diff],
    }),
    [file.path, file.diff, lang],
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50">
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        />

        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {fileName}
        </span>

        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/50">
          {file.path}
        </span>

        <Badge variant="outline" className="ml-auto shrink-0 text-[10px] px-1.5 py-0">
          {file.action}
        </Badge>

        {file.additions > 0 && (
          <span className="shrink-0 font-mono text-xs text-emerald-600 dark:text-emerald-400">
            +{file.additions}
          </span>
        )}

        {file.deletions > 0 && (
          <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">
            -{file.deletions}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1 overflow-hidden rounded-md border border-border">
          {tooLarge ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Diff too large to display ({file.parsedLines.length.toLocaleString()} lines)
            </div>
          ) : (
            <DiffView
              data={diffData}
              diffViewMode={DiffModeEnum.Unified}
              diffViewTheme={diffTheme}
              diffViewHighlight
              diffViewWrap
              diffViewFontSize={12}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
