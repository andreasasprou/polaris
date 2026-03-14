import type { AgentType } from "./types";

/**
 * Build environment variables for the sandbox-agent server process
 * based on agent type and API key format.
 *
 * Credentials are passed as env vars to the server process — agents inherit them.
 */
export function buildSessionEnv(
  agentType: AgentType,
  apiKey: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...extra };

  switch (agentType) {
    case "claude": {
      // sk-ant-oat01- = OAuth token (consumer), sk-ant-api03- = API key
      const isOAuthToken = apiKey.startsWith("sk-ant-oat");
      if (isOAuthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
      } else {
        env.ANTHROPIC_API_KEY = apiKey;
      }
      break;
    }

    case "codex": {
      if (apiKey.startsWith("sk-")) {
        env.OPENAI_API_KEY = apiKey;
      }
      // Base64-encoded auth.json is handled separately (written to filesystem)
      break;
    }

    case "opencode": {
      // OpenCode supports multiple providers — pass both if available
      if (apiKey.startsWith("sk-ant-")) {
        env.ANTHROPIC_API_KEY = apiKey;
      } else if (apiKey.startsWith("sk-")) {
        env.OPENAI_API_KEY = apiKey;
      } else {
        env.ANTHROPIC_API_KEY = apiKey;
      }
      break;
    }

    case "amp": {
      env.ANTHROPIC_API_KEY = apiKey;
      break;
    }
  }

  return env;
}
