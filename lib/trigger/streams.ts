import { streams } from "@trigger.dev/sdk/v3";
import type { SessionMessage } from "./types";

/** Typed input stream for sending messages into interactive session tasks. */
export const sessionMessages = streams.input<SessionMessage>({
  id: "session-messages",
});
