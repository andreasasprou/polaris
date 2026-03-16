/**
 * Sandbox REST Proxy — Build Script
 *
 * Bundles all proxy modules + dependencies into a single proxy.js file
 * that can be written into the sandbox filesystem.
 *
 * Usage: npx tsx lib/sandbox-proxy/build.ts
 *
 * Output: lib/sandbox-proxy/dist/proxy.js
 */

import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENTRY = path.resolve(import.meta.dirname, "index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, "dist");

async function main() {
  // Ensure output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: path.join(OUT_DIR, "proxy.js"),
    platform: "node",
    target: "node22",
    format: "esm",
    // Bundle everything — the proxy runs standalone inside the sandbox
    // with no node_modules. Mark nothing as external.
    external: [],
    // Handle dynamic imports
    splitting: false,
    // Source maps for debugging
    sourcemap: true,
    // Minify for smaller bundle
    minify: true,
    // Define NODE_ENV
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    // Banner to make it executable
    banner: {
      js: "// Polaris Sandbox REST Proxy — bundled at " + new Date().toISOString(),
    },
    // Log level
    logLevel: "info",
  });

  if (result.errors.length > 0) {
    console.error("Build failed:", result.errors);
    process.exit(1);
  }

  const stats = fs.statSync(path.join(OUT_DIR, "proxy.js"));
  console.log(
    `\nProxy bundle created: dist/proxy.js (${(stats.size / 1024).toFixed(1)} KB)`,
  );
}

main().catch((err) => {
  console.error("Build error:", err);
  process.exit(1);
});
