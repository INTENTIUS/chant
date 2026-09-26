/**
 * chant #2737 — `chud-lexicon-exit`, the migration `chant workspace upgrade`
 * ships for repos made from chud's template, run over the studio kit's copy
 * of it (arugula-salad/studio 84c8b21 `template/`, the fixture). It covers the
 * two sources such repos are made from: a directory, as the kit's
 * provisioning does, and a git repository at a ref, as `chant init --from
 * jhgaylor/chud@<ref>#template` did.
 *
 * The last test builds, lints and runs the migrated delivery project with
 * this checkout's chant, up to the ship gate.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { WORKSPACE_UPGRADE_GATE_OP } from "../op/gate-name";
import { CHUD_LEXICON_EXIT, convertPoints } from "./chant-migrations/chud-lexicon-exit";
import { readerVersion } from "./declaration";
import { runChecks } from "./lineage-check";
import { initFromCommand } from "./lineage-init";
import { readLock } from "./lineage-lock";
import { stageUpgrade, type ChantRunner } from "./lineage-upgrade";
import { upgradeCommand } from "./lineage-upgrade-cli";
import { parsePoints } from "./points";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/studio-template-84c8b21.json"), "utf-8")) as {
  files: Record<string, string>;
};
const CHUD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@intentius\/(?:chant-lexicon-chud|chud-runtime)/;

let root: string;
let tpl: string;
let proj: string;
let source: "dir" | "git";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}
function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), "utf-8");
}
function commit(message: string): void {
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-q", "-m", message]);
}
/** Every source file under `dir`, skipping node_modules and .git. */
function sources(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    if (name === "node_modules" || name === ".git") continue;
    const path = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) out.push(...sources(dir, path));
    else if (/\.(?:[cm]?[jt]s)$/.test(name)) out.push(path);
  }
  return out;
}
/** The `--to` an upgrade to the same template version takes. */
const target = (): string => (source === "dir" ? `${tpl}#template` : "main");

function ledger(): GateLedgerPort & { approve(digest: string): void } {
  const pending: PendingGateRecord[] = [];
  const resolutions: GateResolutionRecord[] = [];
  return {
    approve(digest) {
      resolutions.push({ version: 1, op: WORKSPACE_UPGRADE_GATE_OP, gate: ".", resolvedBy: "alice", timestamp: "2026-09-25T00:00:00Z", planDigest: digest });
    },
    async read() {
      return { resolutions: [...resolutions], pending: [...pending] };
    },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      return { record, pushed: true };
    },
  };
}

const passing: ChantRunner = async () => ({ exitCode: 0, output: "" });

/** Stage, approve and apply the upgrade, and commit it. */
async function upgrade(): Promise<void> {
  const l = ledger();
  const first = await upgradeCommand({ root: proj, to: target(), runChant: passing, ledger: l, now: "2026-09-25T00:00:00Z" });
  expect(first.outcome).toBe("gated");
  l.approve(first.staged!.digest);
  const second = await upgradeCommand({ root: proj, to: target(), runChant: passing, ledger: l, now: "2026-09-25T00:00:00Z" });
  expect(second.outcome).toBe("applied");
  commit("chud-lexicon-exit");
}

async function makeProject(from: "dir" | "git"): Promise<void> {
  source = from;
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-chud-exit-")));
  tpl = join(root, "studio");
  proj = join(root, "app-repo");
  for (const [path, content] of Object.entries(FIXTURE.files)) put(tpl, `template/${path}`, content);
  git(tpl, ["init", "-q", "-b", "main"]);
  git(tpl, ["add", "-A"]);
  git(tpl, ["commit", "-q", "-m", "template"]);
  const made = await initFromCommand({ from: from === "dir" ? `${tpl}#template` : `${tpl}@main#template`, path: proj, params: { name: "Notes", issue: "acme/notes#1" } });
  expect(made.error).toBeUndefined();
  git(proj, ["init", "-q", "-b", "main"]);
  commit("init from the studio kit's template");
}

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe.each(["dir", "git"] as const)("chud-lexicon-exit, from a %s source", (from) => {
  beforeEach(async () => {
    await makeProject(from);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("the dry run shows the plan and leaves the tree alone", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const result = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(result.outcome).toBe("dry-run");
    const out = lines.join("\n");
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT} (applied)`);
    expect(out).toContain("delete: delivery/ops/chant-lexicon-chud/index.ts");
    expect(out).toContain("write: delivery/ops/release.op.ts");
    expect(out).toContain("write: decisions/points.json");
    expect(out).toMatch(/not moved: the dispatch Op .* -> the studio kit \(arugula-salad\/studio, template\/\)/);
    expect(out).toContain("not moved: the release's steps after the ship gate");
    expect(out).toContain("INTENTIUS/chant#2782");
    expect(read(proj, "delivery/package.json")).toContain("@intentius/chud-runtime");
    expect(git(proj, ["status", "--porcelain"])).toBe("");
  });

  test("takes the repo off the chud packages, and the lock records it", async () => {
    await upgrade();

    const imports = sources(proj).filter((f) => CHUD_IMPORT.test(read(proj, f)));
    expect(imports).toEqual([]);
    for (const gone of ["delivery/ops/chant-lexicon-chud", "delivery/ops/dispatch.op.ts", "delivery/ops/rollback.op.ts", "delivery/ops/upgrade.op.ts", "delivery/deploy/site.ts", "delivery/.chant", "delivery/.npmrc", "delivery/decisions/points.yaml"]) {
      expect(existsSync(join(proj, gone)), gone).toBe(false);
    }

    const pkg = JSON.parse(read(proj, "delivery/package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@intentius/chud-runtime");
    expect(Object.keys(pkg.dependencies)).not.toContain("@intentius/chant-lexicon-chud");
    // delivery/ takes the chant doing the upgrade, and nothing holds it below that.
    expect(pkg.dependencies["@intentius/chant"]).toBe(`^${readerVersion()}`);
    expect(pkg.dependencies["@intentius/chant-lexicon-fly"]).toBe(`^${readerVersion()}`);
    expect(pkg.dependencies["@intentius/chant-lexicon-systemone"]).toBe(`^${readerVersion()}`);
    expect(pkg.scripts.release).toBe("chant run release");
    expect(pkg.scripts.check).toBe("npm --prefix ../app test --silent");
    expect(pkg.scripts).not.toHaveProperty("dispatch");
    expect(Object.values(pkg.scripts).join("\n")).not.toMatch(/--on chud|\bchud (dev|design)\b/);

    const config = read(proj, "delivery/chant.config.ts");
    expect(config).toContain('lexicons: ["fountain", "fly", "cedar", "github", "systemone"]');
    expect(config).not.toMatch(/CHUD00[12]|write-scope\.ts|const sizing/);
    // The template's parameters stay where they were.
    expect(config).toContain('issue: "acme/notes#1"');

    const points = parsePoints(read(proj, "decisions/points.json"), "decisions/points.json");
    expect(Object.keys(points["ship-skip"].inputs)).toContain("release.work_changed");
    expect(points["ship-skip"].question.type).toBe("noul");
    expect(Object.keys(points["slice-tier"].inputs)).toContain("work-item.fits_small");
    const decl = JSON.parse(read(proj, "chant.workspace.json")) as { records: Array<{ kind: string }> };
    expect(decl.records.map((r) => r.kind)).toContain("answers/answer.kind.mjs");

    const lineage = readLock(proj)!.scopes["."];
    expect(lineage.migrations).toContain(CHUD_LEXICON_EXIT);
    expect(lineage.manualSteps).toEqual([]);

    // chant workspace check is clean: the lock, the declaration and the points file.
    const check = await runChecks(proj);
    expect("error" in check).toBe(false);
    if (!("error" in check)) {
      expect(check.findings).toEqual([]);
      expect(check.declaration?.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(check.ok).toBe(true);
    }
  });

  test("is idempotent: a second upgrade plans nothing and changes nothing", async () => {
    await upgrade();
    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
    // Without the lock's record, the plan finds nothing left to move either.
    const lock = JSON.parse(read(proj, ".chant/workspace.lock.json")) as { scopes: Record<string, { migrations: string[] }> };
    lock.scopes["."].migrations = [];
    put(proj, ".chant/workspace.lock.json", JSON.stringify(lock, null, 2) + "\n");
    commit("forget the migration");
    const fresh = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(fresh.chantMigrations).toEqual([]);
    } finally {
      fresh.dispose();
    }
  });
});

describe("chud-lexicon-exit, with the project's own edits", () => {
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("keeps the box's port edits in chant.config.ts, and marks a replaced Op that was edited", async () => {
    put(proj, "delivery/chant.config.ts", read(proj, "delivery/chant.config.ts").replace("default: 3000, env: \"CHUD_DEV_PORT\"", "default: 4312, env: \"CHUD_DEV_PORT\""));
    put(proj, "delivery/ops/release.op.ts", read(proj, "delivery/ops/release.op.ts") + "// ours\n");
    commit("the box's ports, and an edit");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      const [m] = staged.chantMigrations;
      expect(m.applied).toBe(true);
      expect(m.changes.find((c) => c.path === "delivery/ops/release.op.ts")?.edited).toBe(true);
      expect(read(staged.worktreeProject, "delivery/chant.config.ts")).toContain('default: 4312, env: "CHUD_DEV_PORT"');
      expect(read(staged.worktreeProject, "delivery/ops/release.op.ts")).not.toContain("// ours");
    } finally {
      staged.dispose();
    }
  });

  test("a file it does not know that imports chud is a conflict: nothing is applied, and the checks fail", async () => {
    put(proj, "delivery/deploy/extra.ts", 'import { config } from "@intentius/chud-runtime/release";\nexport const port = config.ports.prod;\n');
    commit("our own chud import");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const result = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(result.outcome).toBe("checks-failed");
    expect(lines.join("\n")).toMatch(/conflict: delivery\/deploy\/extra\.ts: imports the chud packages/);
    expect(result.staged!.chantMigrations[0].applied).toBe(false);
    expect(result.staged!.migrations).not.toContain(CHUD_LEXICON_EXIT);
    expect(git(proj, ["status", "--porcelain"])).toBe("");
  });

  test("a point of the project's own, whose inputs have no read-contract output, is a conflict", async () => {
    const yaml = read(proj, "delivery/decisions/points.yaml");
    put(proj, "delivery/decisions/points.yaml", `${yaml}\n  our-point:\n    title: Ours\n    question: { type: boolean, instructions: Ours?, criteria: { "true": yes, "false": no } }\n    inputs: { size: how big }\n    deciders:\n      - kind: quorum\n        count: 1\n`);
    commit("our point");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(staged.checksOk).toBe(false);
      expect(staged.chantMigrations[0].conflicts[0]).toMatchObject({ path: "delivery/decisions/points.yaml" });
      expect(staged.chantMigrations[0].conflicts[0].reason).toContain("our-point");
      expect(existsSync(join(staged.worktreeProject, "delivery/ops/chant-lexicon-chud"))).toBe(true);
    } finally {
      staged.dispose();
    }
  });
});

describe("convertPoints", () => {
  test("keeps an input already named for its output, and refuses one with none", () => {
    const ok = convertPoints("points:\n  ours:\n    title: t\n    question: { type: boolean, instructions: i, criteria: { \"true\": a, \"false\": b } }\n    inputs: { work-item.size: s }\n    deciders:\n      - kind: table\n        rows: [{ when: { work-item.size: 1 }, answer: true }]\n      - kind: quorum\n        count: 1\n", "p.json");
    expect("json" in ok).toBe(true);
    const bad = convertPoints("points:\n  ours:\n    title: t\n    question: { type: boolean, instructions: i, criteria: { \"true\": a, \"false\": b } }\n    inputs: { size: s }\n    deciders:\n      - kind: quorum\n        count: 1\n", "p.json");
    expect("error" in bad && bad.error).toContain("ours");
  });
});

describe("the migrated delivery project, with this checkout's chant", () => {
  function chant(cwd: string, ...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args],
      { cwd, encoding: "utf-8", timeout: 120_000, env: { ...process.env, NO_COLOR: "1" } },
    );
  }

  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("builds, lints, rebuilds its CI, and runs the release Op to the ship gate", { timeout: 300_000 }, async () => {
    await upgrade();
    const delivery = join(proj, "delivery");
    symlinkSync(join(repoRoot, "node_modules"), join(delivery, "node_modules"));
    writeFileSync(join(proj, ".git/info/exclude"), "node_modules\n");

    const build = chant(delivery, "build", "-o", join(root, "build.out"));
    expect(build.status, build.stderr).toBe(0);
    const lint = chant(delivery, "lint");
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    // `npm run ci:check`: the committed workflow is what ci/ci.ts builds.
    const ci = chant(delivery, "build", "ci", "--lexicon", "github", "-o", join(root, "ci.yml"));
    expect(ci.status, ci.stderr).toBe(0);
    expect(read(root, "ci.yml")).toBe(read(proj, ".github/workflows/ci.yml"));

    // Check (the app's tests), the ship-skip point through decide, then the gate.
    const run = chant(delivery, "run", "release");
    expect(run.status, run.stdout + run.stderr).toBe(3);
    expect(run.stdout + run.stderr).toContain(`gated on "ship"`);
    const answers = readdirSync(join(proj, "answers")).filter((f) => f.startsWith("ship-skip-"));
    expect(answers).toHaveLength(1);
    expect(read(proj, `answers/${answers[0]}`)).toMatch(/state: "answered"\nanswer: false/);
  });
});
