/**
 * AI-Generated Metadata
 *
 * Uses Haiku to generate descriptive branch names, commit messages,
 * and PR titles. 5-second timeout on all calls, never throws —
 * always falls back to formulaic defaults.
 */

type MetadataCtx = {
  apiKey: string;
  provider: string;
};

function isUsableApiKey(ctx: MetadataCtx): boolean {
  return ctx.provider === "anthropic" && !ctx.apiKey.startsWith("sk-ant-oat");
}

async function callHaiku(
  system: string,
  user: string,
  apiKey: string,
  maxTokens: number,
): Promise<string | null> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function generateBranchName(
  title: string,
  prompt: string,
  ctx: MetadataCtx,
): Promise<string> {
  const fallback = `agent/${Date.now()}`;

  if (!isUsableApiKey(ctx)) return fallback;

  const raw = await callHaiku(
    "Generate a 3-5 word branch name slug from the given task. Lowercase, hyphens only, no prefix. Respond with ONLY the slug, nothing else.",
    `Title: ${title}\n\nPrompt: ${prompt.slice(0, 500)}`,
    ctx.apiKey,
    30,
  );

  if (!raw) return fallback;

  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  if (!slug) return fallback;

  const suffix = Date.now().toString(36).slice(-6);
  return `agent/${slug}-${suffix}`;
}

export async function generateCommitMessage(
  title: string,
  diffSummary: string,
  filesChanged: string[],
  ctx: MetadataCtx,
): Promise<string> {
  const fallback = `fix: ${title}`;

  if (!isUsableApiKey(ctx)) return fallback;

  const diffContext = [
    `Diff stat:\n${diffSummary}`,
    `Files changed:\n${filesChanged.join("\n")}`,
  ]
    .join("\n\n")
    .slice(0, 2000);

  const raw = await callHaiku(
    "Write a single-line conventional commit message (fix/feat/refactor/chore/docs/test prefix) for the given changes. Respond with ONLY the commit message, nothing else.",
    `Task: ${title}\n\n${diffContext}`,
    ctx.apiKey,
    100,
  );

  if (!raw) return fallback;

  const line = raw.split("\n")[0].trim().slice(0, 200);
  return line || fallback;
}

export async function generatePrTitle(
  title: string,
  diffSummary: string,
  ctx: MetadataCtx,
): Promise<string> {
  if (!isUsableApiKey(ctx)) return title;

  const raw = await callHaiku(
    "Write a concise PR title (no prefix like 'PR:') for the given changes. Respond with ONLY the title, nothing else.",
    `Task: ${title}\n\nDiff stat:\n${diffSummary}`,
    ctx.apiKey,
    60,
  );

  if (!raw) return title;

  const line = raw.split("\n")[0].trim().slice(0, 100);
  return line || title;
}
