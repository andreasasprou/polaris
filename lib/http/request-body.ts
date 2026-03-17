const textDecoder = new TextDecoder();

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
  let totalBytes = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new BodyTooLargeError(maxBytes, totalBytes);
    }

    body += textDecoder.decode(value, { stream: true });
  }

  body += textDecoder.decode();
  return body;
}
