type ValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Validate a secret value before persisting (format checks only).
 * Called on both create and update to prevent corrupted credentials.
 */
export function validateSecretValue({
  provider,
  value,
}: {
  provider: string;
  value: string;
}): ValidationResult {
  const trimmed = value.trim();

  if (!trimmed) {
    return { valid: false, error: "Value cannot be empty" };
  }

  switch (provider) {
    case "anthropic": {
      if (!trimmed.startsWith("sk-ant-")) {
        return {
          valid: false,
          error: "Anthropic API keys must start with sk-ant-",
        };
      }
      return { valid: true };
    }

    case "openai": {
      if (trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-")) {
        return { valid: true };
      }
      // Treat as base64-encoded Codex auth.json
      return validateCodexAuthBase64(trimmed);
    }

    default:
      return { valid: false, error: `Unsupported provider: ${provider}` };
  }
}

/**
 * Validate credentials against the provider's API.
 * Call after format validation passes.
 */
export async function validateSecretLive({
  provider,
  value,
}: {
  provider: string;
  value: string;
}): Promise<ValidationResult> {
  const trimmed = value.trim();

  switch (provider) {
    case "anthropic":
      return validateAnthropicKeyLive(trimmed);

    case "openai": {
      if (trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-")) {
        return validateOpenAIKeyLive(trimmed);
      }
      return validateCodexAuthLive(trimmed);
    }

    default:
      return { valid: true };
  }
}

async function validateAnthropicKeyLive(
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { valid: true };
    if (res.status === 401) {
      return { valid: false, error: "Anthropic API key is invalid or revoked." };
    }
    // Non-auth errors (rate limit, server error) — don't block saving
    return { valid: true };
  } catch {
    // Network errors — don't block saving
    return { valid: true };
  }
}

async function validateOpenAIKeyLive(
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { valid: true };
    if (res.status === 401) {
      return { valid: false, error: "OpenAI API key is invalid or revoked." };
    }
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

async function validateCodexAuthLive(
  base64Value: string,
): Promise<ValidationResult> {
  let accessToken: string;
  try {
    const decoded = Buffer.from(base64Value, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    accessToken = parsed.tokens?.access_token;
  } catch {
    // Format validation should have caught this — skip live check
    return { valid: true };
  }

  if (!accessToken) return { valid: true };

  // Check JWT expiration offline first
  try {
    const [, payloadB64] = accessToken.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8"),
    );
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return {
        valid: false,
        error:
          'ChatGPT OAuth token has expired. Re-run "codex auth" and re-export.',
      };
    }
  } catch {
    // Can't decode JWT — fall through to live check
  }

  // Verify token works against OpenAI
  try {
    const res = await fetch("https://api.openai.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { valid: true };
    if (res.status === 401) {
      return {
        valid: false,
        error:
          'ChatGPT OAuth token is invalid or expired. Re-run "codex auth" and re-export.',
      };
    }
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

function validateCodexAuthBase64(
  value: string,
): { valid: true } | { valid: false; error: string } {
  let decoded: string;
  try {
    const buf = Buffer.from(value, "base64");
    decoded = buf.toString("utf-8");
  } catch {
    return {
      valid: false,
      error:
        "Invalid base64 encoding. Run the base64 command and paste the full output.",
    };
  }

  // Node's Buffer.from is lenient — check that it actually decoded to something meaningful
  if (!decoded || decoded.length < 2) {
    return {
      valid: false,
      error:
        "Invalid base64 encoding. Run the base64 command and paste the full output.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {
      valid: false,
      error:
        "Decoded value is not valid JSON. Ensure you're encoding the correct auth.json file.",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      valid: false,
      error:
        "Decoded value is not a JSON object. Ensure you're encoding the correct auth.json file.",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const tokens = obj.tokens as Record<string, unknown> | undefined;

  if (!tokens || typeof tokens !== "object") {
    return {
      valid: false,
      error:
        'auth.json is missing the "tokens" field. Re-run "codex auth" and try again.',
    };
  }

  if (!tokens.access_token) {
    return {
      valid: false,
      error:
        'auth.json is missing "tokens.access_token". Re-run "codex auth" and try again.',
    };
  }

  if (!tokens.refresh_token) {
    return {
      valid: false,
      error:
        'auth.json is missing "tokens.refresh_token". Re-run "codex auth" and try again.',
    };
  }

  return { valid: true };
}
