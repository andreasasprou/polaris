export class BodyTooLargeError extends Error {
  constructor(
    public readonly maxBytes: number,
    public readonly actualBytes?: number,
  ) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readRequestBody(
  req: Request,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes, contentLength);
    }
  }

  if (!req.body) {
    return "";
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes, totalBytes);
    }

    body += decoder.decode(value, { stream: true });
  }

  body += decoder.decode();
  return body;
}
