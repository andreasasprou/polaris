import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import importPlugin from "eslint-plugin-import-x";

// ── Layer Architecture ──
//
// L0 Foundation: lib/http/, lib/metrics/, lib/config/
// L1 Schema:     lib/db/, lib/errors/
// L2 Domain:     lib/auth/, lib/credentials/, lib/secrets/, lib/integrations/,
//                lib/automations/, lib/sandbox/, lib/sandbox-agent/,
//                lib/sandbox-proxy/, lib/sandbox-env/, lib/sessions/,
//                lib/jobs/, lib/reviews/, lib/routing/
// L3 Orchestration: lib/orchestration/
// L4 Presentation:  hooks/, components/, app/
//
// Rule: imports flow downward. No upward imports (e.g., L1 → L2 is forbidden).

const L3_ORCHESTRATION = "lib/orchestration/**";
const L2_DOMAIN_DIRS = [
  "lib/auth/**",
  "lib/credentials/**",
  "lib/secrets/**",
  "lib/integrations/**",
  "lib/automations/**",
  "lib/sandbox/**",
  "lib/sandbox-agent/**",
  "lib/sandbox-proxy/**",
  "lib/sandbox-env/**",
  "lib/sessions/**",
  "lib/jobs/**",
  "lib/reviews/**",
  "lib/routing/**",
];
const L1_SCHEMA_DIRS = ["lib/db/**", "lib/errors/**"];
const L0_FOUNDATION_DIRS = ["lib/http/**", "lib/metrics/**", "lib/config/**"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // ── Domain Boundary Rules ──
  {
    files: ["lib/**/*.ts"],
    plugins: {
      "import-x": importPlugin,
    },
    rules: {
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            // L0 Foundation cannot import from any other lib/ layer
            {
              target: L0_FOUNDATION_DIRS,
              from: [...L1_SCHEMA_DIRS, ...L2_DOMAIN_DIRS, L3_ORCHESTRATION],
              message:
                "Foundation modules (L0) cannot import from higher layers. " +
                "If you need domain logic here, move it to the appropriate domain module.",
            },
            // L1 Schema cannot import from L2 Domain or L3 Orchestration
            {
              target: L1_SCHEMA_DIRS,
              from: [...L2_DOMAIN_DIRS, L3_ORCHESTRATION],
              message:
                "Schema modules (L1) cannot import from Domain (L2) or Orchestration (L3). " +
                "If you need domain logic here, the code belongs in a higher layer.",
            },
            // L2 Domain cannot import from L3 Orchestration
            {
              target: L2_DOMAIN_DIRS,
              from: [L3_ORCHESTRATION],
              message:
                "Domain modules (L2) cannot import from Orchestration (L3). " +
                "If you need orchestration logic from a domain module, " +
                "this is a sign the logic should be moved to lib/orchestration/.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
