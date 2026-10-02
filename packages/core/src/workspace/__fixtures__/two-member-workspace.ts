/**
 * A throwaway git repository holding a workspace with two members (api and
 * web), optionally a root member, and an example group with one match. Used
 * by the per-member pipeline tests (#2542).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A git repository holding a workspace with two members, a root member and an example group. */
export function twoMemberWorkspace(options: { root?: boolean; prefix?: string } = {}): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "chant-member-pipeline-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const ws = options.prefix ? join(repo, options.prefix) : repo;
  const members: unknown[] = [
    { name: "api", dir: "services/api", kind: "chant" },
    { name: "web", dir: "apps/web", kind: "chant" },
    { name: "samples", kind: "examples", glob: "examples/*" },
  ];
  if (options.root) members.unshift({ name: "platform", dir: ".", kind: "chant" });
  const files: Record<string, string> = {
    "chant.workspace.json": JSON.stringify({ name: "shop", schema: 1, members }, null, 2),
    "services/api/chant.config.ts": "export default {};\n",
    "services/api/src/infra.ts": "\n",
    "apps/web/chant.config.ts": "export default {};\n",
    "examples/demo/chant.config.ts": "export default {};\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), text);
  }
  return repo;
}
