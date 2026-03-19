/**
 * Centralized URL resolution for the Polaris app.
 *
 * In production, `NEXT_PUBLIC_APP_URL` or `VERCEL_URL` is set.
 * In local dev, `APP_BASE_URL` is set by the boot script (per-worktree),
 * falling back to `http://localhost:<PORT>` or `http://localhost:3001`.
 */

export function getAppBaseUrl(): string {
  // Production / preview: explicit app URL
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
  if (appUrl) {
    return appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
  }

  // Local dev: boot script sets APP_BASE_URL, or fall back to PORT / 3001
  return (
    process.env.APP_BASE_URL ??
    `http://localhost:${process.env.PORT || 3001}`
  );
}

export function getCallbackUrl(): string {
  return `${getAppBaseUrl()}/api/callbacks`;
}
