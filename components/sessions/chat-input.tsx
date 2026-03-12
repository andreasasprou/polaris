"use client";

import {
  useRef,
  useState,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
} from "react";
import {
  ArrowUpIcon,
  PaperclipIcon,
  XIcon,
  ImageIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePromptHistory } from "@/hooks/use-prompt-history";
import { Spinner } from "./spinner";

// ── Types ──

export type ChatInputProps = {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  /** Called when user requests to stop the agent (Escape while working). */
  onStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Show the "Agent is working..." state with stop affordance. */
  working?: boolean;
  className?: string;
};

export type Attachment = {
  id: string;
  file: File;
  preview?: string;
};

const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"];
const MAX_HEIGHT = 240;

// ── Component ──

export function ChatInput({
  onSubmit,
  onStop,
  placeholder = "Send a message...",
  disabled = false,
  loading = false,
  working = false,
  className,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const history = usePromptHistory();
  const dragCountRef = useRef(0);

  const canSend =
    !disabled &&
    !loading &&
    (value.trim().length > 0 || attachments.length > 0);
  const isWorking = working && !disabled;

  // ── Auto-resize textarea ──

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  // Focus textarea on mount (when enabled)
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  // ── Submit ──

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    const text = value.trim();
    history.push(text);
    onSubmit(text, attachments);
    setValue("");
    setAttachments([]);
    history.reset();

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.focus();
      }
    });
  }, [canSend, value, attachments, onSubmit, history]);

  // ── Keyboard handling ──

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;

      // Enter to submit (without Shift)
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      // Escape — stop agent if working, otherwise clear input or blur
      if (e.key === "Escape") {
        e.preventDefault();
        if (isWorking && onStop) {
          onStop();
        } else if (value.length > 0) {
          setValue("");
        } else {
          textareaRef.current?.blur();
        }
        return;
      }

      // Arrow Up — navigate history when cursor is at position 0
      if (e.key === "ArrowUp") {
        const el = textareaRef.current;
        if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
          const prev = history.up(value);
          if (prev !== null) {
            e.preventDefault();
            setValue(prev);
            requestAnimationFrame(() => {
              if (el) {
                el.selectionStart = el.selectionEnd = prev.length;
              }
            });
          }
        }
        return;
      }

      // Arrow Down — navigate history when cursor is at end
      if (e.key === "ArrowDown") {
        const el = textareaRef.current;
        if (
          el &&
          el.selectionStart === value.length &&
          el.selectionEnd === value.length
        ) {
          const next = history.down();
          if (next !== null) {
            e.preventDefault();
            setValue(next);
            requestAnimationFrame(() => {
              if (el) {
                el.selectionStart = el.selectionEnd = next.length;
              }
            });
          }
        }
        return;
      }

      // Ctrl+U / Cmd+U — attach files
      if (e.key === "u" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        fileInputRef.current?.click();
        return;
      }
    },
    [isComposing, handleSubmit, history, value, isWorking, onStop],
  );

  // ── File handling ──

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const valid = arr.filter((f) => ACCEPTED_FILE_TYPES.includes(f.type));
    if (valid.length === 0) return;

    const newAttachments: Attachment[] = valid.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: ACCEPTED_IMAGE_TYPES.includes(file.type)
        ? URL.createObjectURL(file)
        : undefined,
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // ── Paste handling ──

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (
          item.kind === "file" &&
          ACCEPTED_IMAGE_TYPES.includes(item.type)
        ) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  // ── Drag and drop ──
  // Use a counter to handle nested drag events correctly

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (dragCountRef.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragging(false);

      if (e.dataTransfer?.files?.length) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  // Cleanup attachment URLs on unmount
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click container to focus textarea
  const handleContainerClick = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const showPlaceholder = isWorking ? "Agent is working..." : placeholder;

  return (
    <div
      ref={containerRef}
      onClick={handleContainerClick}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "relative cursor-text rounded-xl border bg-card transition-all duration-150",
        isFocused
          ? "border-ring/60 shadow-[0_0_0_1px_var(--ring)]"
          : "border-border hover:border-border/80",
        isDragging && "border-primary/50 bg-primary/5",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/5 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-background/80 px-4 py-2 text-sm font-medium text-primary shadow-sm">
            <ImageIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="group/att relative flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted/60"
            >
              {att.preview ? (
                <img
                  src={att.preview}
                  alt={att.file.name}
                  className="size-6 rounded object-cover"
                />
              ) : (
                <PaperclipIcon className="size-3.5 text-muted-foreground" />
              )}
              <span className="max-w-[140px] truncate text-xs text-muted-foreground">
                {att.file.name}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttachment(att.id);
                }}
                className="ml-0.5 rounded-full p-0.5 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="flex items-end gap-2 px-3 pb-2 pt-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={showPlaceholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none bg-transparent text-sm leading-relaxed text-foreground",
            "placeholder:text-muted-foreground/50",
            "outline-none",
            "scrollbar-none",
            "disabled:cursor-not-allowed",
          )}
          style={{
            minHeight: "24px",
            maxHeight: `${MAX_HEIGHT}px`,
          }}
          aria-label={showPlaceholder}
          aria-multiline="true"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />

        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          {/* Attach button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            disabled={disabled}
            className={cn(
              "rounded-lg p-1.5 text-muted-foreground/50 transition-colors",
              "hover:bg-muted hover:text-muted-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
            title="Attach files (Ctrl+U)"
          >
            <PaperclipIcon className="size-4" />
          </button>

          {/* Submit / Stop button */}
          {isWorking && onStop ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              className={cn(
                "flex size-7 items-center justify-center rounded-lg transition-colors",
                "bg-destructive/10 text-destructive hover:bg-destructive/20",
              )}
              title="Stop (Escape)"
            >
              <SquareIcon className="size-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSubmit();
              }}
              disabled={!canSend}
              className={cn(
                "flex size-7 items-center justify-center rounded-lg transition-all duration-150",
                canSend
                  ? "bg-foreground text-background hover:bg-foreground/90 active:scale-95"
                  : "bg-muted text-muted-foreground/30",
                "disabled:pointer-events-none",
              )}
              title="Send (Enter)"
            >
              {loading ? (
                <Spinner className="size-3.5" />
              ) : (
                <ArrowUpIcon className="size-4" strokeWidth={2.5} />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            addFiles(e.target.files);
            e.target.value = "";
          }
        }}
      />

      {/* Footer hint bar */}
      <div className="flex items-center justify-between border-t border-border/40 px-3 py-1.5">
        <div className="flex items-center gap-3">
          {isWorking && (
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-500" />
              <span className="text-[11px] text-muted-foreground/50">
                Working
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/35">
          {isWorking && onStop ? (
            <span>
              <kbd className="rounded border border-border/50 px-1 py-px font-mono text-[10px]">
                Esc
              </kbd>{" "}
              stop
            </span>
          ) : (
            <>
              <span>
                <kbd className="rounded border border-border/50 px-1 py-px font-mono text-[10px]">
                  Enter
                </kbd>{" "}
                send
              </span>
              <span>
                <kbd className="rounded border border-border/50 px-1 py-px font-mono text-[10px]">
                  Shift+Enter
                </kbd>{" "}
                newline
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
