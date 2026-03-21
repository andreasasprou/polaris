---
title: Inline File Reference Pills
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, markdown]
---

# 16 — Inline File Reference Pills

## Problem Statement

When the agent mentions files in messages, they appear as plain text. Cursor Glass renders file references as clickable pills. This would improve scannability and navigation.

## Design Decision: Remark Plugin

**Remark plugin (chosen)** over React-level text scanning:
- Operates at MDAST level where markdown structure is well-defined
- `ignore` option skips code blocks, links, images at AST level
- No risk of breaking markdown structure
- Follows principle: "Data produces correct state; UI just renders"

## Implementation

### Step 1: File Path Detection

**Create `lib/markdown/file-path-pattern.ts`**

Regex pattern requiring:
- At least one `/` separator (eliminates false positives like `e.g.`, package names)
- File extension (`.ts`, `.tsx`, `.js`, `.css`, `.json`, `.md`, `.py`, `.go`, etc.)
- Optional line number: `file.ts:42` or `file.ts:42-50`
- Negative lookbehind excludes URLs (preceded by `://`)

```
/(?<![a-zA-Z0-9:\/])(?:\.\/)?(?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z]{1,10}(?::(\d+)(?:-(\d+))?)?(?![a-zA-Z0-9\/])/g
```

Export: `FILE_PATH_REGEX`, `parseFilePath(match) → { path, line?, lineEnd? }`

**Tests:** Create `lib/markdown/__tests__/file-path-pattern.test.ts` with test cases for: true positives (`src/foo/bar.tsx`, `./relative/path.ts`, `lib/utils.ts:42`, `lib/utils.ts:42-50`), true negatives (`https://github.com`, `react-markdown`, `e.g.`, `i.e.`, `.env`, `@scope/package`), and edge cases (`v1.0/notes.md`, `@scope/package.ts`). The regex is the highest-risk part — test it thoroughly.

### Step 2: Remark Plugin

**Create `lib/markdown/remark-file-refs.ts`**

**Explicit dependency:** `mdast-util-find-and-replace` is a transitive dependency via `remark-gfm` but NOT importable with pnpm's strict isolation. Run `pnpm add mdast-util-find-and-replace` to add it as an explicit dependency.

Uses `mdast-util-find-and-replace`:
1. Find file paths in text nodes
2. Replace with custom `fileRef` MDAST nodes
3. `data.hName = "file-ref"` + `data.hProperties` for remark-rehype passthrough
4. `ignore: ['link', 'linkReference', 'code', 'inlineCode']`

### Step 3: FileRefPill Component

**Create `components/sessions/file-ref-pill.tsx`**

```tsx
<button className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-[12px]">
  <FileCodeIcon className="size-3" />
  <span>{fileName}{lineLabel}</span>
</button>
```

- `inline-flex` + `align-baseline` for natural text flow
- Tooltip shows full path on hover
- Click: no expansion in v1 (future: show code snippet)

**Visual distinction from inline code:** Plan 19 defines `.text-code` with nearly identical styling (mono, muted bg, small text). The FileRefPill MUST be visually distinct. Use: a left border in `--status-info` color, or a distinct background (`bg-status-info/5`), or both. The pill should read as 'interactive element' not 'code snippet'.

### Step 4: Markdown Renderer Integration

**Modify `components/sessions/markdown-renderer.tsx`**

1. Add `remarkFileRefs` to `remarkPlugins` array
2. Add `"file-ref": FileRefPill` to `components` prop

### Step 5: Type Safety

**Type safety alternative:** Instead of the fragile `types/jsx.d.ts` intrinsic element declaration, type the `components` prop mapping directly using react-markdown's `Components` type with a type assertion on the `file-ref` key. This avoids global JSX augmentation.

## File Summary

| Action | File |
|--------|------|
| Create | `lib/markdown/file-path-pattern.ts` |
| Create | `lib/markdown/__tests__/file-path-pattern.test.ts` |
| Create | `lib/markdown/remark-file-refs.ts` |
| Create | `components/sessions/file-ref-pill.tsx` |
| Modify | `components/sessions/markdown-renderer.tsx` |
| Run    | `pnpm add mdast-util-find-and-replace` |

## Future: Click-to-Expand

Add `SessionFileContext` (React Context) built from tool call `locations` and `content`. FileRefPill consumes it to show relevant code on click.

## Risks

- **False positives**: Mitigated by requiring `/` separator + extension; validated by dedicated test suite
- **`mdast-util-find-and-replace` import**: Resolved by adding as explicit dependency (`pnpm add`)
- **Inline code paths**: `ignore: ['inlineCode']` means backtick paths stay as code (desirable)
