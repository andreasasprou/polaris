"use client";

import { useRef, type ReactNode, type ComponentType } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import remarkFileRefs from "@/lib/markdown/remark-file-refs";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { FileRefPill } from "./file-ref-pill";

interface MarkdownRendererProps {
  children: string;
  className?: string;
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractTextContent).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const el = node as { props?: { children?: ReactNode } };
    return extractTextContent(el.props?.children);
  }
  return "";
}

function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);

  const textContent = extractTextContent(children);

  return (
    <div className="group/code relative my-2">
      <pre
        ref={ref}
        className={cn(
          "overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-[13px]",
          className,
        )}
      >
        {children}
      </pre>
      {textContent.length > 0 && (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover/code:opacity-100">
          <CopyButton text={textContent} />
        </div>
      )}
    </div>
  );
}

export function MarkdownRenderer({ children, className }: MarkdownRendererProps) {
  return (
    <div className={cn("min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFileRefs]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          ...(({
            "file-ref": (props: Record<string, unknown>) => (
              <FileRefPill
                path={props.path as string}
                fileName={props.fileName as string}
                line={props.line as string | undefined}
                lineEnd={props.lineEnd as string | undefined}
              >
                {props.children as ReactNode}
              </FileRefPill>
            ),
          }) as Record<string, ComponentType<Record<string, unknown>>>),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="rounded-[3px] bg-muted px-1.5 py-0.5 font-mono text-[13px] break-all"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-[13px]", className)} {...props}>
                {children}
              </code>
            );
          },
          p: ({ children }) => (
            <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => (
            <h1 className="mb-3 mt-4 text-base font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2 text-sm font-medium first:mt-0">{children}</h3>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-primary underline underline-offset-2 hover:text-primary/80"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-md border border-border">
              <table className="min-w-full text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted/50 px-3 py-1.5 text-left text-xs font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border px-3 py-1.5 text-sm last:border-b-0">
              {children}
            </td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
