import { describe, it, expect } from "vitest";
import {
  FILE_PATH_REGEX,
  parseFilePath,
} from "@/lib/markdown/file-path-pattern";

function matches(input: string): string[] {
  // Reset global regex state
  FILE_PATH_REGEX.lastIndex = 0;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_REGEX.exec(input)) !== null) {
    results.push(m[0]);
  }
  return results;
}

describe("FILE_PATH_REGEX", () => {
  describe("true positives", () => {
    it("matches a basic file path", () => {
      expect(matches("Look at src/foo/bar.tsx")).toEqual(["src/foo/bar.tsx"]);
    });

    it("matches a relative path with ./", () => {
      expect(matches("Check ./relative/path.ts")).toEqual([
        "./relative/path.ts",
      ]);
    });

    it("matches a path with line number", () => {
      expect(matches("See lib/utils.ts:42")).toEqual(["lib/utils.ts:42"]);
    });

    it("matches a path with line range", () => {
      expect(matches("See lib/utils.ts:42-50")).toEqual(["lib/utils.ts:42-50"]);
    });

    it("matches Next.js route group paths", () => {
      expect(matches("Modified app/(dashboard)/page.tsx")).toEqual([
        "app/(dashboard)/page.tsx",
      ]);
    });

    it("matches deeply nested paths", () => {
      expect(matches("In lib/sandbox-agent/event-types.ts")).toEqual([
        "lib/sandbox-agent/event-types.ts",
      ]);
    });

    it("matches paths with multiple extensions", () => {
      expect(matches("See config/db.config.ts")).toEqual([
        "config/db.config.ts",
      ]);
    });

    it("matches common extensions", () => {
      expect(matches("file at src/styles/main.css")).toEqual([
        "src/styles/main.css",
      ]);
      expect(matches("file at config/data.json")).toEqual([
        "config/data.json",
      ]);
      expect(matches("file at scripts/run.sh")).toEqual(["scripts/run.sh"]);
      expect(matches("file at src/main.py")).toEqual(["src/main.py"]);
      expect(matches("file at src/main.go")).toEqual(["src/main.go"]);
      expect(matches("file at src/main.rs")).toEqual(["src/main.rs"]);
      expect(matches("file at src/query.sql")).toEqual(["src/query.sql"]);
      expect(matches("file at templates/index.html")).toEqual([
        "templates/index.html",
      ]);
    });

    it("matches multiple paths in one string", () => {
      expect(
        matches("Changed src/foo.ts and lib/bar.tsx"),
      ).toEqual(["src/foo.ts", "lib/bar.tsx"]);
    });

    it("matches path at start of string", () => {
      expect(matches("src/foo/bar.ts is the file")).toEqual(["src/foo/bar.ts"]);
    });

    it("matches path at end of string", () => {
      expect(matches("The file is src/foo/bar.ts")).toEqual(["src/foo/bar.ts"]);
    });
  });

  describe("true negatives", () => {
    it("does not match URLs", () => {
      expect(matches("Visit https://github.com/foo/bar.ts")).toEqual([]);
    });

    it("does not match http URLs", () => {
      expect(matches("See http://example.com/path/file.ts")).toEqual([]);
    });

    it("does not match package names without slash", () => {
      expect(matches("Install react-markdown")).toEqual([]);
    });

    it("does not match abbreviations", () => {
      expect(matches("For e.g. this case")).toEqual([]);
      expect(matches("That is i.e. something")).toEqual([]);
    });

    it("does not match dotfiles without slash", () => {
      expect(matches("Edit .env")).toEqual([]);
    });

    it("does not match scoped packages without extension", () => {
      expect(matches("Install @scope/package")).toEqual([]);
    });

    it("does not match words with dots but no slash", () => {
      expect(matches("Check some.thing")).toEqual([]);
    });

    it("does not match version strings", () => {
      expect(matches("Use version 2.0.1")).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("matches versioned directory paths", () => {
      expect(matches("See v1.0/notes.md")).toEqual(["v1.0/notes.md"]);
    });

    it("does not match partial component-like names without slash", () => {
      expect(matches("Use path/to/file.component")).toEqual([]);
    });

    it("handles path in parentheses", () => {
      expect(matches("(see src/foo.ts)")).toEqual(["src/foo.ts"]);
    });

    it("handles path after comma", () => {
      expect(matches("files src/a.ts, lib/b.tsx")).toEqual([
        "src/a.ts",
        "lib/b.tsx",
      ]);
    });

    it("handles path in backticks (raw regex, no AST ignore)", () => {
      // The regex itself will match; the remark plugin's ignore list handles this
      expect(matches("`src/foo.ts`")).toEqual(["src/foo.ts"]);
    });
  });
});

describe("parseFilePath", () => {
  it("parses a plain path", () => {
    expect(parseFilePath("src/foo/bar.tsx")).toEqual({
      path: "src/foo/bar.tsx",
    });
  });

  it("parses a path with line number", () => {
    expect(parseFilePath("lib/utils.ts:42")).toEqual({
      path: "lib/utils.ts",
      line: 42,
    });
  });

  it("parses a path with line range", () => {
    expect(parseFilePath("lib/utils.ts:42-50")).toEqual({
      path: "lib/utils.ts",
      line: 42,
      lineEnd: 50,
    });
  });

  it("parses a relative path", () => {
    expect(parseFilePath("./relative/path.ts")).toEqual({
      path: "./relative/path.ts",
    });
  });
});
