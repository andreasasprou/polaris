/**
 * Interactive setup script for the Polaris test GitHub App.
 *
 * Uses the GitHub App Manifest flow:
 * 1. Starts a local HTTP server to handle the callback
 * 2. Opens your browser to GitHub with a pre-filled manifest
 * 3. GitHub redirects back with a code
 * 4. Exchanges the code for app credentials (ID, private key, webhook secret)
 * 5. Writes the credentials to .env
 *
 * Usage:
 *   pnpm tsx scripts/setup-github-app.ts
 *
 * Docs: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = 3456;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;

// Detect the portless URL (e.g., https://polaris.localhost:1355)
// Falls back to localhost:3001 if portless is not running
function getAppUrl(): string {
  try {
    const result = execSync("portless get polaris 2>/dev/null", { encoding: "utf-8" }).trim();
    if (result) return result;
  } catch {}
  return "http://localhost:3001";
}

const APP_URL = getAppUrl();
console.log(`Using app URL: ${APP_URL}\n`);

// The manifest defines the GitHub App's configuration
const manifest = {
  name: "polaris-test-dev",
  url: APP_URL,
  description: "Polaris local development & testing GitHub App",
  public: false,
  hook_attributes: {
    url: `${APP_URL}/api/webhooks/github`,
    active: false, // Webhooks disabled by default for local dev
  },
  redirect_url: CALLBACK_URL,
  callback_urls: [`${APP_URL}/api/integrations/github/callback`],
  setup_url: `${APP_URL}/api/integrations/github/callback`,
  setup_on_update: true,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "write",
    metadata: "read",
    members: "read",
  },
  default_events: ["pull_request", "push"],
};

async function main() {
  console.log("🔧 Polaris GitHub App Setup\n");
  console.log("This will create a GitHub App for local development.");
  console.log("You'll be redirected to GitHub to confirm.\n");

  // Start a temporary server that:
  // 1. Serves a page with a form that POSTs the manifest to GitHub
  // 2. Handles the callback after GitHub creates the app
  const { code, cleanup, localUrl } = await startCallbackServer();

  console.log("Opening browser...\n");
  openBrowser(localUrl);
  console.log("If the browser didn't open, go to:");
  console.log(`  ${localUrl}\n`);
  console.log("Waiting for GitHub redirect...\n");

  // Wait for the code from the callback
  const codeValue = await code;
  cleanup();

  // Exchange the code for credentials
  console.log("Exchanging code for credentials...");
  const response = await fetch(
    `https://api.github.com/app-manifests/${codeValue}/conversions`,
    { method: "POST", headers: { Accept: "application/json" } },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Failed to exchange code: ${response.status} ${error}`);
    process.exit(1);
  }

  const app = (await response.json()) as {
    id: number;
    slug: string;
    pem: string;
    webhook_secret: string;
    name: string;
  };

  console.log(`\n✅ GitHub App created: "${app.name}" (ID: ${app.id})\n`);

  // Base64-encode the private key
  const pemB64 = Buffer.from(app.pem).toString("base64");

  // Write to .env
  const envPath = ".env";
  const envVars = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_PRIVATE_KEY_B64: pemB64,
    GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret,
    GITHUB_APP_SLUG: app.slug,
  };

  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, "utf-8");

    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    writeFileSync(envPath, envContent);
    console.log("✅ Updated .env with GitHub App credentials\n");
  } else {
    const content = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(envPath, content + "\n");
    console.log("✅ Created .env with GitHub App credentials\n");
  }

  console.log("Next steps:");
  console.log(`  1. Install the app on a test repo:`);
  console.log(`     https://github.com/apps/${app.slug}/installations/new`);
  console.log(`  2. Run: pnpm dev`);
  console.log(`  3. Sign up at http://localhost:3001/login\n`);
}

function startCallbackServer(): Promise<{
  code: Promise<string>;
  cleanup: () => void;
  localUrl: string;
}> {
  return new Promise((resolveSetup) => {
    let resolveCode: (code: string) => void;
    const codePromise = new Promise<string>((r) => (resolveCode = r));

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);

      if (url.pathname === "/" || url.pathname === "/setup") {
        // Serve an HTML page that auto-submits the manifest to GitHub via POST
        const manifestJson = JSON.stringify(manifest);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body style="font-family: system-ui; text-align: center; padding: 60px;">
            <h2>Creating Polaris Test GitHub App...</h2>
            <p>Redirecting to GitHub...</p>
            <form id="manifest-form" action="https://github.com/settings/apps/new" method="post">
              <input type="hidden" name="manifest" value='${manifestJson.replace(/'/g, "&#39;")}' />
            </form>
            <script>document.getElementById('manifest-form').submit();</script>
          </body>
          </html>
        `);
        return;
      }

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="font-family: system-ui; text-align: center; padding: 60px;">
              <h1>✅ GitHub App created!</h1>
              <p>You can close this tab. The CLI is finishing setup...</p>
            </body></html>
          `);
          resolveCode(code);
        } else {
          res.writeHead(400);
          res.end("Missing code parameter");
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(PORT, () => {
      resolveSetup({
        code: codePromise,
        cleanup: () => server.close(),
        localUrl: `http://localhost:${PORT}/setup`,
      });
    });
  });
}

function openBrowser(url: string) {
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open "${url}"`);
    else if (platform === "linux") execSync(`xdg-open "${url}"`);
    else if (platform === "win32") execSync(`start "" "${url}"`);
  } catch {
    // Browser open failed — user can copy URL manually
  }
}

main().catch((err) => {
  console.error("❌ Setup failed:", err);
  process.exit(1);
});
