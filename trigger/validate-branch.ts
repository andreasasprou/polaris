import { task } from "@trigger.dev/sdk/v3";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const validateBranch = task({
  id: "validate-branch",
  run: async (input: { repoUrl: string; branchName: string }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-validate-"));

    await execa("git", [
      "clone",
      "--depth=1",
      "--branch",
      input.branchName,
      input.repoUrl,
      dir,
    ]);

    const pkgPath = path.join(dir, "package.json");
    if (!(await exists(pkgPath))) {
      return { ok: true, checks: [] as string[] };
    }

    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const checks: string[] = [];

    if (pkg.scripts?.typecheck) {
      await execa("npm", ["run", "typecheck"], { cwd: dir });
      checks.push("typecheck");
    }
    if (pkg.scripts?.lint) {
      await execa("npm", ["run", "lint"], { cwd: dir });
      checks.push("lint");
    }
    if (pkg.scripts?.test) {
      await execa("npm", ["test", "--", "--runInBand"], { cwd: dir });
      checks.push("test");
    }

    return { ok: true, checks };
  },
});
