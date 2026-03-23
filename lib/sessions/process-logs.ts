export type ProcessLogStream = "stdout" | "stderr" | "combined" | "pty";

export type ProcessInfoForLogs = {
  tty: boolean;
};

export type ProcessLogEntry = {
  sequence: number;
  stream: string;
  timestampMs: number;
  data: string;
  encoding: string;
};

export function parseFollowLogs(value: string | null): boolean {
  return value === "1" || value === "true";
}

const VALID_PROCESS_LOG_STREAMS = new Set<ProcessLogStream>([
  "stdout",
  "stderr",
  "combined",
  "pty",
]);

export function parseProcessLogStream(
  value: string | null,
): ProcessLogStream | null {
  if (!value) return null;
  return VALID_PROCESS_LOG_STREAMS.has(value as ProcessLogStream)
    ? (value as ProcessLogStream)
    : null;
}

export function resolveProcessLogStream(
  requestedStream: ProcessLogStream | null,
  process: ProcessInfoForLogs | null,
): ProcessLogStream {
  if (requestedStream) return requestedStream;
  return process?.tty ? "pty" : "combined";
}

export function decodeProcessLogEntries(
  entries: ProcessLogEntry[],
): ProcessLogEntry[] {
  return entries.map((entry) => {
    if (entry.encoding !== "base64") return entry;

    return {
      ...entry,
      data: Buffer.from(entry.data, "base64").toString("utf8"),
      encoding: "utf8",
    };
  });
}
