/**
 * behold's two closed member kinds, read through chant's workspace (#2545).
 *
 * Both ship from the terraform lexicon's `./workspace-kinds` subpath, since
 * a choudoufu estate is a Terraform root the lexicon's choudoufu mode reads.
 * A workspace that pins the lexicon lists members of either kind through
 * `chant workspace ls --json`, with the kinds behold gave the same
 * directories, and reading the kinds never imports the lexicon.
 *
 * The installed package is the repo's own: its package.json and kinds file
 * are copied as they ship, and every code entry its `exports` names is
 * replaced by a module that leaves a marker file when it is imported.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { runDeclarationChecks } from "./checks";
import { loadKindRegistry, resolveKind } from "./kinds";
import { runWorkspaceLs, type LsDocument } from "./ls";
import { workingTree } from "./tree";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const TERRAFORM = join(REPO, "lexicons", "terraform");
const FIXTURES = join(TERRAFORM, "src", "__fixtures__");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const version = (dir: string): string => (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version: string }).version;

const MARKER = `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./IMPORTED", import.meta.url), "");\n(globalThis as { __chantKindsImported?: boolean }).__chantKindsImported = true;\n`;

/**
 * Install the package in `from` under `root/node_modules`: its package.json
 * and kinds file as they are, and a marker module at every code target its
 * exports name, the `./*` pattern's target for `workspace-kinds` included.
 */
function install(root: string, from: string): string {
  const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf-8")) as { name: string; exports: Record<string, unknown> };
  const dir = join(root, "node_modules", ...manifest.name.split("/"));
  mkdirSync(dir, { recursive: true });
  cpSync(join(from, "package.json"), join(dir, "package.json"));
  cpSync(join(from, "workspace-kinds.json"), join(dir, "workspace-kinds.json"));
  const targets = new Set<string>(["./index.js"]);
  const collect = (entry: unknown): void => {
    if (typeof entry === "string") targets.add(entry.replace("*", "workspace-kinds"));
    else if (entry && typeof entry === "object") for (const v of Object.values(entry)) collect(v);
  };
  for (const [key, entry] of Object.entries(manifest.exports)) if (key !== "./workspace-kinds") collect(entry);
  for (const t of targets) {
    if (!/\.(ts|js|mjs)$/.test(t)) continue;
    mkdirSync(dirname(join(dir, t)), { recursive: true });
    writeFileSync(join(dir, t), MARKER);
  }
  return dir;
}

function workspace(): { root: string; installed: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-behold-kinds-")));
  scratch.push(root);
  const installed = [install(root, TERRAFORM)];
  // Estates in the shapes behold serves: a stock root, a choudoufu root with
  // the sidecar, one with the live block, and a chant project beside .tf files.
  cpSync(join(FIXTURES, "no-backend"), join(root, "estates", "stock"), { recursive: true });
  cpSync(join(FIXTURES, "live-estate"), join(root, "estates", "sidecar"), { recursive: true });
  cpSync(join(FIXTURES, "live"), join(root, "estates", "inline"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "chant.config.ts"), "export default {};\n");
  writeFileSync(join(root, "app", "main.tf"), 'resource "null_resource" "x" {}\n');
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify(
      {
        name: "estate",
        schema: 1,
        pins: [
          { package: "@intentius/chant-lexicon-terraform", version: version(TERRAFORM) },
        ],
        members: [
          { name: "stock", dir: "estates/stock", kind: "terraform" },
          { name: "sidecar", dir: "estates/sidecar", kind: "choudoufu" },
          { name: "inline", dir: "estates/inline", kind: "choudoufu" },
          { name: "app", dir: "app", kind: "chant" },
        ],
      },
      null,
      2,
    ),
  );
  return { root, installed };
}

describe("behold's member kinds from their packages (#2545)", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  test("chant workspace ls --json lists terraform and choudoufu members, readable, and never imports the lexicon", async () => {
    const { root, installed } = workspace();
    const code = await runWorkspaceLs({ args: parseArgs(["workspace", "ls", root, "--json"]), plugins: [] } as never);
    expect(code).toBe(0);
    const doc = JSON.parse(out.join("\n")) as Extract<LsDocument, { members: unknown }>;
    expect(doc.members.map((m) => [m.name, m.kind, m.readable])).toEqual([
      ["stock", "terraform", true],
      ["sidecar", "choudoufu", true],
      ["inline", "choudoufu", true],
      ["app", "chant", true],
    ]);
    for (const dir of installed) expect(existsSync(join(dir, "IMPORTED")), dir).toBe(false);
    expect(existsSync(join(installed[0], "src", "IMPORTED"))).toBe(false);
    expect((globalThis as { __chantKindsImported?: boolean }).__chantKindsImported).toBeUndefined();
  });

  test("each directory's kind is the one behold gave it: chant over choudoufu over terraform", () => {
    const { root } = workspace();
    const pins = [
      { package: "@intentius/chant-lexicon-terraform", version: version(TERRAFORM), path: null },
    ];
    const { registry, problems } = loadKindRegistry(pins, root);
    expect(problems).toEqual([]);
    expect(registry.get("terraform")).toMatchObject({ source: "@intentius/chant-lexicon-terraform", precedence: 400 });
    expect(registry.get("choudoufu")).toMatchObject({ source: "@intentius/chant-lexicon-terraform", precedence: 450 });
    const tree = workingTree(root);
    const winner = (dir: string) => resolveKind(registry, tree, dir).winner?.name;
    expect(winner("estates/stock")).toBe("terraform");
    expect(winner("estates/sidecar")).toBe("choudoufu");
    expect(winner("estates/inline")).toBe("choudoufu");
    expect(winner("app")).toBe("chant");
    expect(resolveKind(registry, tree, "estates/inline").claims.map((k) => k.name)).toEqual(["choudoufu", "terraform"]);
  });

  test("chant workspace check passes with no error: no member is outranked, and no probes tie", async () => {
    const { root } = workspace();
    const report = await runDeclarationChecks(root);
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("without the pins, the same members are an unknown kind, and the message names the known ones", async () => {
    const { root } = workspace();
    const file = join(root, "chant.workspace.json");
    const decl = JSON.parse(readFileSync(file, "utf-8")) as { pins?: unknown };
    delete decl.pins;
    writeFileSync(file, JSON.stringify(decl));
    await runWorkspaceLs({ args: parseArgs(["workspace", "ls", root, "--json"]), plugins: [] } as never);
    const doc = JSON.parse(out.join("\n")) as Extract<LsDocument, { members: unknown }>;
    expect(doc.members.map((m) => m.reason?.code ?? null)).toEqual(["unknown-kind", "unknown-kind", "unknown-kind", null]);
    expect(doc.members[0].reason?.message).toMatch(/known kinds: chant, other, workspace$/);
  });
});
