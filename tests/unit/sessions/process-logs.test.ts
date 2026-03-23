import { describe, expect, it } from "vitest";
import {
  decodeProcessLogEntries,
  parseFollowLogs,
  parseProcessLogStream,
  resolveProcessLogStream,
} from "@/lib/sessions/process-logs";

describe("process log helpers", () => {
  it("auto-selects pty for tty processes", () => {
    expect(resolveProcessLogStream(null, { tty: true })).toBe("pty");
    expect(resolveProcessLogStream(null, { tty: false })).toBe("combined");
  });

  it("preserves an explicit stream selection", () => {
    expect(resolveProcessLogStream("stderr", { tty: true })).toBe("stderr");
  });

  it("parses supported stream values", () => {
    expect(parseProcessLogStream("pty")).toBe("pty");
    expect(parseProcessLogStream("combined")).toBe("combined");
    expect(parseProcessLogStream("invalid")).toBeNull();
    expect(parseProcessLogStream(null)).toBeNull();
  });

  it("parses live follow flags", () => {
    expect(parseFollowLogs("true")).toBe(true);
    expect(parseFollowLogs("1")).toBe(true);
    expect(parseFollowLogs("false")).toBe(false);
    expect(parseFollowLogs(null)).toBe(false);
  });

  it("decodes base64-encoded log entries", () => {
    expect(
      decodeProcessLogEntries([
        {
          sequence: 1,
          stream: "pty",
          timestampMs: 1,
          data: Buffer.from("hello\n", "utf8").toString("base64"),
          encoding: "base64",
        },
        {
          sequence: 2,
          stream: "stdout",
          timestampMs: 2,
          data: "already decoded",
          encoding: "utf8",
        },
      ]),
    ).toEqual([
      {
        sequence: 1,
        stream: "pty",
        timestampMs: 1,
        data: "hello\n",
        encoding: "utf8",
      },
      {
        sequence: 2,
        stream: "stdout",
        timestampMs: 2,
        data: "already decoded",
        encoding: "utf8",
      },
    ]);
  });
});
