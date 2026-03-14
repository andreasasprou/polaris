/**
 * Validate a secret value before persisting.
 * Called on both create and update to prevent corrupted credentials.
 */
export function validateSecretValue({
  provider,
  value,
}: {
  provider: string;
  value: string;
}): { valid: true } | { valid: false; error: string } {
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
      if (trimmed.startsWith("sk-")) {
        return { valid: true };
      }
      // Treat as base64-encoded Codex auth.json
      return validateCodexAuthBase64(trimmed);
    }

    default:
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
