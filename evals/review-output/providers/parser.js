/**
 * Promptfoo provider that calls parseReviewOutput() directly.
 * Writes input to a temp file to avoid shell escaping issues.
 */
const { execSync } = require("child_process");
const { writeFileSync, unlinkSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../..");

class ParserProvider {
  constructor(options) {
    this.options = options;
  }

  id() {
    return "parser-unit";
  }

  async callApi(prompt) {
    const tmpInput = path.join(tmpdir(), `promptfoo-parser-${Date.now()}.txt`);
    const tmpScript = path.join(tmpdir(), `promptfoo-parser-${Date.now()}.ts`);

    try {
      // Write input to temp file to avoid shell escaping
      writeFileSync(tmpInput, prompt, "utf-8");

      // Write script that reads from file
      writeFileSync(tmpScript, `
        import { readFileSync } from "fs";
        import { parseReviewOutput } from "${ROOT}/lib/reviews/output-parser.ts";
        const input = readFileSync("${tmpInput}", "utf-8");
        const result = parseReviewOutput(input);
        console.log(JSON.stringify(result));
      `, "utf-8");

      const result = execSync(`npx tsx ${tmpScript}`, {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      return { output: result };
    } catch (err) {
      return { output: "null", error: err.stderr || err.message };
    } finally {
      try { unlinkSync(tmpInput); } catch {}
      try { unlinkSync(tmpScript); } catch {}
    }
  }
}

module.exports = ParserProvider;
