import {
  isValidUrl,
  safeFetch,
  safeStreamingFetch,
  validateServerFetchUrl,
} from "./url-validation";
import type { McpDiscoveredTool } from "./types";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "polaris", version: "0.0.1" };

type JsonRpcId = number;
type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

type StreamableHttpResponse = {
  sessionId: string | null;
  messages: JsonRpcMessage[];
};

function isLocalDevUrl(url: URL) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

async function validateRuntimeUrl(
  url: string,
  { allowLocalDev = true }: { allowLocalDev?: boolean } = {},
): Promise<string> {
  if (!isValidUrl(url, { allowLocalDev })) {
    throw new Error(`Invalid MCP server URL: ${url}`);
  }

  const parsed = new URL(url);
  if (allowLocalDev && isLocalDevUrl(parsed)) return url;

  const validated = await validateServerFetchUrl(url);
  if (!validated) {
    throw new Error(`Blocked unsafe MCP server URL: ${url}`);
  }
  return validated;
}

async function runtimeFetch(
  url: string,
  init: RequestInit,
  options?: { allowLocalDev?: boolean },
): Promise<Response> {
  const validated = await validateRuntimeUrl(url, options);
  const parsed = new URL(validated);
  if (isLocalDevUrl(parsed)) {
    return fetch(validated, init);
  }
  return safeFetch(validated, init);
}

async function runtimeStreamingFetch(
  url: string,
  init: RequestInit,
  options?: { allowLocalDev?: boolean },
): Promise<Response> {
  const validated = await validateRuntimeUrl(url, options);
  const parsed = new URL(validated);
  if (isLocalDevUrl(parsed)) {
    return fetch(validated, init);
  }
  return safeStreamingFetch(validated, init);
}

function normalizeHeaders(headers?: Record<string, string>) {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized.set(name, value);
  }
  return normalized;
}

function parseSsePayload(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const normalized = text.replace(/\r\n/g, "\n");

  for (const block of normalized.split("\n\n")) {
    if (!block.trim()) continue;

    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").trimStart();

      if (field === "event") {
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (eventName !== "message" || dataLines.length === 0) continue;

    try {
      const parsed = JSON.parse(dataLines.join("\n")) as JsonRpcMessage;
      messages.push(parsed);
    } catch {
      // Ignore malformed server noise.
    }
  }

  return messages;
}

async function parseStreamableHttpResponse(
  response: Response,
): Promise<StreamableHttpResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const sessionId = response.headers.get("mcp-session-id");

  if (response.status === 202) {
    await response.body?.cancel();
    return { sessionId, messages: [] };
  }

  if (contentType.includes("application/json")) {
    const json = (await response.json()) as JsonRpcMessage | JsonRpcMessage[];
    return {
      sessionId,
      messages: Array.isArray(json) ? json : [json],
    };
  }

  if (contentType.includes("text/event-stream")) {
    return {
      sessionId,
      messages: parseSsePayload(await response.text()),
    };
  }

  throw new Error(`Unexpected MCP response content type: ${contentType || "unknown"}`);
}

function findRpcResponse(messages: JsonRpcMessage[], requestId: JsonRpcId) {
  const message = messages.find((entry) => entry.id === requestId);
  if (!message) {
    throw new Error(`MCP server did not return a response for request ${requestId}`);
  }
  if (message.error) {
    throw new Error(message.error.message || "MCP server returned an error");
  }
  return message;
}

function normalizeTools(result: Record<string, unknown> | undefined): McpDiscoveredTool[] {
  const rawTools = Array.isArray(result?.tools) ? result.tools : [];
  return rawTools
    .filter(
      (tool): tool is Record<string, unknown> =>
        !!tool && typeof tool === "object" && typeof tool.name === "string",
    )
    .map((tool) => ({
      name: tool.name as string,
      description:
        typeof tool.description === "string" ? tool.description : null,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : null,
    }));
}

async function sendStreamableHttpMessage(
  serverUrl: string,
  headers: Record<string, string> | undefined,
  message: JsonRpcMessage,
  options: { sessionId?: string | null; protocolVersion?: string; expectResponse?: boolean } = {},
) {
  const requestHeaders = normalizeHeaders(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("accept", "application/json, text/event-stream");
  if (options.sessionId) {
    requestHeaders.set("mcp-session-id", options.sessionId);
  }
  if (options.protocolVersion) {
    requestHeaders.set("mcp-protocol-version", options.protocolVersion);
  }

  const response = await runtimeFetch(serverUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `MCP request failed with ${response.status}`);
  }

  const parsed = await parseStreamableHttpResponse(response);
  if (options.expectResponse === false) {
    return { sessionId: parsed.sessionId ?? options.sessionId ?? null };
  }

  const rpcResponse = findRpcResponse(parsed.messages, message.id as JsonRpcId);
  return {
    sessionId: parsed.sessionId ?? options.sessionId ?? null,
    result: rpcResponse.result,
  };
}

type SseReader = {
  next: () => Promise<{ event: string; data: string; id?: string } | null>;
  close: () => Promise<void>;
};

function createSseReader(response: Response): SseReader {
  if (!response.body) {
    throw new Error("SSE response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function next() {
    while (true) {
      buffer = buffer.replace(/\r\n/g, "\n");
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex >= 0) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        let event = "message";
        let id: string | undefined;
        const dataLines: string[] = [];

        for (const line of chunk.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const [field, ...rest] = line.split(":");
          const value = rest.join(":").trimStart();
          if (field === "event") event = value;
          if (field === "id") id = value;
          if (field === "data") dataLines.push(value);
        }

        return { event, data: dataLines.join("\n"), id };
      }

      const { value, done } = await reader.read();
      if (done) {
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return {
    next,
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function waitForRpcResponse(
  reader: SseReader,
  requestId: JsonRpcId,
): Promise<Record<string, unknown>> {
  while (true) {
    const event = await reader.next();
    if (!event) {
      throw new Error("SSE stream closed before MCP response arrived");
    }

    if (!event.data) continue;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(event.data) as JsonRpcMessage;
    } catch {
      continue;
    }

    if (message.id !== requestId) continue;
    if (message.error) {
      throw new Error(message.error.message || "MCP server returned an error");
    }
    return message.result ?? {};
  }
}

async function sendSseMessage(
  endpointUrl: string,
  headers: Record<string, string> | undefined,
  message: JsonRpcMessage,
  options?: { allowLocalDev?: boolean },
) {
  const requestHeaders = normalizeHeaders(headers);
  requestHeaders.set("content-type", "application/json");

  const response = await runtimeFetch(endpointUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  }, options);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Legacy SSE MCP request failed with ${response.status}`);
  }

  await response.body?.cancel();
}

async function testLegacySseServer(
  serverUrl: string,
  headers?: Record<string, string>,
): Promise<McpDiscoveredTool[]> {
  const allowLocalDev = isLocalDevUrl(new URL(serverUrl));
  const response = await runtimeStreamingFetch(serverUrl, {
    method: "GET",
    headers: {
      ...Object.fromEntries(normalizeHeaders(headers).entries()),
      Accept: "text/event-stream",
    },
    signal: AbortSignal.timeout(10_000),
  }, { allowLocalDev });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Legacy SSE MCP connection failed with ${response.status}`);
  }

  const reader = createSseReader(response);

  try {
    let endpointUrl: string | null = null;
    while (!endpointUrl) {
      const event = await reader.next();
      if (!event) {
        throw new Error("Legacy SSE MCP server closed before publishing endpoint");
      }
      if (event.event === "endpoint" && event.data) {
        endpointUrl = new URL(event.data, serverUrl).toString();
      }
    }

    const initializeId = 1;
    await sendSseMessage(endpointUrl, headers, {
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    }, { allowLocalDev });
    await waitForRpcResponse(reader, initializeId);

    await sendSseMessage(endpointUrl, headers, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, { allowLocalDev });

    const toolsListId = 2;
    await sendSseMessage(endpointUrl, headers, {
      jsonrpc: "2.0",
      id: toolsListId,
      method: "tools/list",
      params: {},
    }, { allowLocalDev });

    return normalizeTools(await waitForRpcResponse(reader, toolsListId));
  } finally {
    await reader.close();
  }
}

async function testStreamableHttpServer(
  serverUrl: string,
  headers?: Record<string, string>,
): Promise<McpDiscoveredTool[]> {
  const initialize = await sendStreamableHttpMessage(
    serverUrl,
    headers,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
  );

  const sessionId = initialize.sessionId;
  const protocolVersion =
    typeof initialize.result?.protocolVersion === "string"
      ? initialize.result.protocolVersion
      : MCP_PROTOCOL_VERSION;

  await sendStreamableHttpMessage(
    serverUrl,
    headers,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { sessionId, protocolVersion, expectResponse: false },
  );

  const listTools = await sendStreamableHttpMessage(
    serverUrl,
    headers,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    { sessionId, protocolVersion },
  );

  return normalizeTools(listTools.result);
}

export async function testMcpServerConnection(input: {
  serverUrl: string;
  transport: string;
  headers?: Record<string, string>;
}): Promise<McpDiscoveredTool[]> {
  if (input.transport === "sse") {
    return testLegacySseServer(input.serverUrl, input.headers);
  }
  return testStreamableHttpServer(input.serverUrl, input.headers);
}
