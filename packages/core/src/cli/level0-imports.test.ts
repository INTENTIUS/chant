/**
 * Level 0 loads no workspace module (#2525 rule 2). The level-0 goldens check
 * it at run time on the example projects; this checks the static import graph
 * of what those commands load, so a new static import that reaches workspace
 * code fails in the unit suite too (#5219). Only static imports count: an
 * `import()` loads when the code that calls it runs.
 *
 * A workspace module is what test/level0-goldens/harness.ts counts: anything
 * under core's src/workspace/, and any chant module whose file name starts
 * with `workspace`.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const SRC = import.meta.dirname;
const LEXICONS = join(SRC, "../../../../lexicons");

// The handlers of build, lint, graph, run (list), audit (in misc) and init, and
// the plugins of the lexicons the goldens' example projects load.
const ENTRIES: Record<string, string> = {
  ...Object.fromEntries(["build", "lint", "graph", "run", "misc", "init"].map((h) => [`cli/handlers/${h}.ts`, join(SRC, "handlers", `${h}.ts`)])),
  ...Object.fromEntries(["aws", "helm", "k8s", "otel", "pulumi", "sql", "terraform"].map((l) => [`lexicons/${l}/src/plugin.ts`, join(LEXICONS, l, "src", "plugin.ts")])),
};

const result = await build({
  entryPoints: Object.values(ENTRIES),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  metafile: true,
  write: false,
  outdir: "level0-imports-out",
  logLevel: "silent",
});
const inputs = result.metafile.inputs;

function isWorkspaceModule(path: string): boolean {
  return /packages\/core\/src\/workspace\//.test(path) || /(^|\/)workspace[^/]*$/.test(path) || /^@intentius\/chant[^/]*\/workspace/.test(path);
}

/** Each workspace module `entry` reaches by static imports, with the chain that reaches it. */
function workspaceChains(entry: string): string[] {
  const start = Object.keys(inputs).find((k) => entry.endsWith(k))!;
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const from = queue.shift()!;
    for (const im of inputs[from]?.imports ?? []) {
      if (im.kind !== "import-statement" || parent.has(im.path)) continue;
      parent.set(im.path, from);
      if (!im.external) queue.push(im.path);
    }
  }
  return [...parent.keys()].filter(isWorkspaceModule).map((k) => {
    const chain: string[] = [];
    for (let c: string | null | undefined = k; c; c = parent.get(c)) chain.unshift(c.replace(/^(\.\.\/)*/, ""));
    return chain.join(" -> ");
  });
}

describe("level 0 imports no workspace module statically (#5219)", () => {
  for (const [name, entry] of Object.entries(ENTRIES)) {
    test(name, () => {
      expect(Object.keys(inputs).some((k) => entry.endsWith(k)), `${name} is in the build`).toBe(true);
      expect(workspaceChains(entry)).toEqual([]);
    });
  }
});
