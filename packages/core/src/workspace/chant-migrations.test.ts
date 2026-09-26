/**
 * chant #2737 — `chud-lexicon-exit`, the migration `chant workspace upgrade`
 * ships for repos made from chud's template, run over the studio kit's copy
 * of it (arugula-salad/studio 84c8b21 `template/`, the fixture). It covers the
 * two sources such repos are made from: a directory, as the kit's
 * provisioning does, and a git repository at a ref, as `chant init --from
 * jhgaylor/chud@<ref>#template` did.
 *
 * The last test builds, lints and runs the migrated delivery project with
 * this checkout's chant: to the ship gate, then, once the plan is approved,
 * through Ship to the fly lexicon's in-memory Machines API and Record (#2782);
 * then a second release, and the rollback Op back to the first (#2800).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { WORKSPACE_UPGRADE_GATE_OP } from "../op/gate-name";
import { CHUD_LEXICON_EXIT, convertPoints } from "./chant-migrations/chud-lexicon-exit";
import { CHUD_LEXICON_EXIT_ROLLBACK } from "./chant-migrations/chud-lexicon-exit-rollback";
import { readerVersion } from "./declaration";
import { runChecks } from "./lineage-check";
import { initFromCommand } from "./lineage-init";
import { readLock } from "./lineage-lock";
import { stageUpgrade, type ChantRunner } from "./lineage-upgrade";
import { upgradeCommand } from "./lineage-upgrade-cli";
import { parsePoints } from "./points";
import { readReleaseLedger } from "../lifecycle/release-ledger";
import { readReleasePlan } from "../lifecycle/plan-ledger";

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
    expect(out).toMatch(/not moved: signing the release archive.* -> INTENTIUS\/chant#2515/);
    expect(out).toMatch(/not moved: chud's rollback Op \(ops\/rollback\.op\.ts\) -> chant's rollback Op, which the migration chud-lexicon-exit-rollback writes/);
    // The rollback Op is planned after the exit, from the tree the exit left (#2800).
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT_ROLLBACK} (applied)`);
    expect(out).toContain("write: delivery/ops/rollback.op.ts");
    expect(out).not.toContain("not moved: the release's steps after the ship gate");
    // #2805: the plan lists README.md, CLAUDE.md and design/CLAUDE.md as
    // changed, not silently left describing what the migration just deleted.
    expect(out).toContain("write: README.md");
    expect(out).toContain("write: CLAUDE.md");
    expect(out).toContain("write: design/CLAUDE.md");
    expect(read(proj, "delivery/package.json")).toContain("@intentius/chud-runtime");
    expect(git(proj, ["status", "--porcelain"])).toBe("");
  });

  test("takes the repo off the chud packages, and the lock records it", async () => {
    await upgrade();

    const imports = sources(proj).filter((f) => CHUD_IMPORT.test(read(proj, f)));
    expect(imports).toEqual([]);
    for (const gone of ["delivery/ops/chant-lexicon-chud", "delivery/ops/dispatch.op.ts", "delivery/ops/upgrade.op.ts", "delivery/deploy/site.ts", "delivery/.chant", "delivery/.npmrc", "delivery/decisions/points.yaml"]) {
      expect(existsSync(join(proj, gone)), gone).toBe(false);
    }

    const pkg = JSON.parse(read(proj, "delivery/package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@intentius/chud-runtime");
    expect(Object.keys(pkg.dependencies)).not.toContain("@intentius/chant-lexicon-chud");
    // delivery/ takes the chant doing the upgrade, and nothing holds it below that.
    expect(pkg.dependencies["@intentius/chant"]).toBe(`^${readerVersion()}`);
    expect(pkg.dependencies["@intentius/chant-lexicon-fly"]).toBe(`^${readerVersion()}`);
    // decide is chant's own (#2828): no package joins for it.
    expect(Object.keys(pkg.dependencies).filter((d) => /lexicon-systemone/.test(d))).toEqual([]);
    expect(pkg.scripts.release).toBe("chant run release");
    expect(pkg.scripts["build:fly"]).toBe("chant build deploy --lexicon fly -o dist/fly.json");
    const release = read(proj, "delivery/ops/release.op.ts");
    for (const step of ["sourceArchive(", "releasePlan(", "plan: plan.out.digest", "flyRelease(", "releaseRecord("]) expect(release).toContain(step);
    expect(release).not.toContain("#2800");
    expect(release).toContain("ops/rollback.op.ts rolls the site back to the\n * previous release.");
    expect(pkg.scripts.rollback).toBe("chant run rollback");
    const rollback = read(proj, "delivery/ops/rollback.op.ts");
    for (const step of ["releaseRollbackPlan(", 'gate("rollback"', "plan: plan.out.digest", "flyRollback(", "to: plan.out.to", "releaseRollbackRecord("]) expect(rollback).toContain(step);
    expect(CHUD_IMPORT.test(rollback)).toBe(false);
    expect(read(proj, "README.md")).toContain("npm run rollback     # chant run rollback");
    expect(read(proj, "README.md")).toContain("and the rollback Op,");
    expect(read(proj, "CLAUDE.md")).toContain("`ops/` (the release and rollback Ops),");
    expect(pkg.scripts.check).toBe("npm --prefix ../app test --silent");
    expect(pkg.scripts).not.toHaveProperty("dispatch");
    expect(Object.values(pkg.scripts).join("\n")).not.toMatch(/--on chud|\bchud (dev|design)\b/);

    const config = read(proj, "delivery/chant.config.ts");
    expect(config).toContain('lexicons: ["fountain", "fly", "cedar", "github"]');
    expect(release).toContain('import { Op, phase, gate, shell, build, sourceArchive, releasePlan, releaseRecord, decide } from "@intentius/chant/op";');
    expect(sources(proj).filter((f) => read(proj, f).includes("chant-lexicon-systemone"))).toEqual([]);
    expect(config).not.toMatch(/CHUD00[12]|write-scope\.ts|const sizing/);
    // The template's parameters stay where they were.
    expect(config).toContain('issue: "acme/notes#1"');

    const points = parsePoints(read(proj, "decisions/points.json"), "decisions/points.json");
    expect(Object.keys(points["ship-skip"].inputs)).toContain("release.work_changed");
    expect(points["ship-skip"].question.type).toBe("noul");
    expect(Object.keys(points["slice-tier"].inputs)).toContain("work-item.fits_small");
    // #2805: the slice-tier point no longer sends its decider to the `lint`
    // block this migration just removed from chant.config.ts.
    expect(points["slice-tier"].question.instructions).not.toMatch(/lint\.rules|chant\.config\.ts/);
    expect(points["slice-tier"].question.instructions).toContain("studio kit");
    const decl = JSON.parse(read(proj, "chant.workspace.json")) as { records: Array<{ kind: string }> };
    expect(decl.records.map((r) => r.kind)).toContain("answers/answer.kind.mjs");

    // #2805: README.md, CLAUDE.md and design/CLAUDE.md no longer describe
    // chud's runtime, `--on chud`, or the Ops and paths this migration deleted
    // as though they were still live.
    for (const doc of ["README.md", "CLAUDE.md", "design/CLAUDE.md"]) {
      const text = read(proj, doc);
      expect(text, doc).not.toMatch(/--on chud|is the machinery|`chud design`|rollback, upgrade and dispatch Ops|chud's runtime package/);
    }
    expect(read(proj, "README.md")).toContain("off chud");
    expect(read(proj, "CLAUDE.md")).toContain("studio kit's now");
    // CLAUDE.md drops the dead path outright; design/CLAUDE.md keeps it only
    // to say the package (and the path) are gone.
    expect(read(proj, "CLAUDE.md")).not.toContain("chud-runtime/schemas");
    expect(read(proj, "design/CLAUDE.md")).toContain("hud's chant views now");
    expect(read(proj, "design/CLAUDE.md")).toMatch(/chud-runtime\/design\/`\. That package is\ngone/);

    const lineage = readLock(proj)!.scopes["."];
    expect(lineage.migrations).toEqual([CHUD_LEXICON_EXIT, CHUD_LEXICON_EXIT_ROLLBACK]);
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

describe("chud-lexicon-exit-rollback, over a repo chud-lexicon-exit migrated before it existed", () => {
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // What 0.92.0's upgrade left: the exit applied, no rollback Op, and the lock naming the exit alone.
    await upgrade();
    const released = read(proj, "delivery/ops/release.op.ts").replace(
      "). ops/rollback.op.ts rolls the site back to the\n * previous release. ",
      "), and rolling the site back to the previous\n * release (INTENTIUS/chant#2800). ",
    );
    put(proj, "delivery/ops/release.op.ts", released);
    rmSync(join(proj, "delivery/ops/rollback.op.ts"));
    put(proj, "README.md", read(proj, "README.md").replace(" and the rollback Op,", ",").replace(/npm run rollback {5}# chant run rollback[^\n]*\n/, ""));
    put(proj, "CLAUDE.md", read(proj, "CLAUDE.md").replace("`ops/` (the release and rollback Ops),", "`ops/` (the release Op),"));
    const pkg = JSON.parse(read(proj, "delivery/package.json")) as { scripts: Record<string, string> };
    delete pkg.scripts.rollback;
    put(proj, "delivery/package.json", JSON.stringify(pkg, null, 2) + "\n");
    const lock = JSON.parse(read(proj, ".chant/workspace.lock.json")) as { scopes: Record<string, { migrations: string[] }> };
    lock.scopes["."].migrations = [CHUD_LEXICON_EXIT];
    put(proj, ".chant/workspace.lock.json", JSON.stringify(lock, null, 2) + "\n");
    commit("as 0.92.0 migrated it");
  });

  test("the dry run lists it; the upgrade writes the rollback Op and the lock records it; a second plans nothing", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const dry = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(dry.outcome).toBe("dry-run");
    const out = lines.join("\n");
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT_ROLLBACK} (applied)`);
    expect(out).not.toContain(`chant migration: ${CHUD_LEXICON_EXIT} `);
    expect(out).toContain("write: delivery/ops/rollback.op.ts");
    expect(out).toContain("write: delivery/ops/release.op.ts");
    expect(out).toContain("write: delivery/package.json");
    expect(out).toContain("write: README.md");
    expect(out).toContain("write: CLAUDE.md");
    expect(existsSync(join(proj, "delivery/ops/rollback.op.ts"))).toBe(false);

    await upgrade();
    expect(read(proj, "delivery/ops/rollback.op.ts")).toContain("flyRollback(");
    expect(read(proj, "delivery/ops/release.op.ts")).not.toContain("#2800");
    expect((JSON.parse(read(proj, "delivery/package.json")) as { scripts: Record<string, string> }).scripts.rollback).toBe("chant run rollback");
    expect(readLock(proj)!.scopes["."].migrations).toEqual([CHUD_LEXICON_EXIT, CHUD_LEXICON_EXIT_ROLLBACK]);

    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
  });

  test("a rollback Op of the project's own is a conflict, and nothing is applied", async () => {
    put(proj, "delivery/ops/rollback.op.ts", "export default {};\n");
    commit("our own rollback");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      const [m] = staged.chantMigrations;
      expect(m).toMatchObject({ id: CHUD_LEXICON_EXIT_ROLLBACK, applied: false, conflicts: [{ path: "delivery/ops/rollback.op.ts" }] });
    } finally {
      staged.dispose();
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
  /** Run this checkout's chant without blocking the event loop, so the in-process flaps below can answer it. */
  function chant(cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(
        process.execPath,
        ["--import", pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href, join(repoRoot, "packages/core/src/cli/main.ts"), ...args],
        { cwd, env: { ...process.env, NO_COLOR: "1", ...env } },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 240_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        done({ status, out });
      });
    });
  }

  /** The fly lexicon's in-memory Machines API, served on a local port. */
  async function flaps(): Promise<{ endpoint: string; fake: { execs: Array<{ command: string[] }>; machines: Map<string, Array<{ name: string; config: Record<string, unknown> & { metadata?: Record<string, string> } }>> }; close(): Promise<void> }> {
    const { createMachinesFake } = (await import(pathToFileURL(join(repoRoot, "lexicons/fly/src/op/activities/machines-fake.ts")).href)) as {
      createMachinesFake(): { http(method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> } & Record<string, never>;
    };
    const fake = createMachinesFake();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        void fake.http(req.method ?? "GET", `http://flaps${req.url}`, text ? JSON.parse(text) : undefined).then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(r.text);
        });
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as AddressInfo;
    return { endpoint: `http://127.0.0.1:${port}`, fake: fake as never, close: () => new Promise((ok) => server.close(() => ok())) };
  }

  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("builds, lints, rebuilds its CI, stops at the ship gate, ships each approved plan to Fly and records it once, and rolls back to the previous release", { timeout: 1_800_000 }, async () => {
    await upgrade();
    const delivery = join(proj, "delivery");
    symlinkSync(join(repoRoot, "node_modules"), join(delivery, "node_modules"));
    writeFileSync(join(proj, ".git/info/exclude"), "node_modules\n");
    const fly = await flaps();
    const env = { FLY_FLAPS_BASE_URL: fly.endpoint, FLY_API_TOKEN: "test", CHUD_FLY_APP_SECRET: "s3cret", GITHUB_ACTOR: "releaser" };
    try {
      const build = await chant(delivery, env, "build", "-o", join(root, "build.out"));
      expect(build.status, build.out).toBe(0);
      const lint = await chant(delivery, env, "lint");
      expect(lint.status, lint.out).toBe(0);
      // `npm run ci:check`: the committed workflow is what ci/ci.ts builds.
      const ci = await chant(delivery, env, "build", "ci", "--lexicon", "github", "-o", join(root, "ci.yml"));
      expect(ci.status, ci.out).toBe(0);
      expect(read(root, "ci.yml")).toBe(read(proj, ".github/workflows/ci.yml"));

      // Check (the app's tests), Build, Plan with the ship-skip point through decide, then the gate on the plan.
      const gated = await chant(delivery, env, "run", "release");
      expect(gated.status, gated.out).toBe(3);
      expect(gated.out).toContain(`gated on "ship"`);
      const answers = readdirSync(join(proj, "answers")).filter((f) => f.startsWith("ship-skip-"));
      expect(answers).toHaveLength(1);
      expect(read(proj, `answers/${answers[0]}`)).toMatch(/state: "answered"\nanswer: false/);
      const plans = readdirSync(join(delivery, "dist/plans"));
      expect(plans).toHaveLength(1);
      const plan = JSON.parse(read(delivery, `dist/plans/${plans[0]}`)) as { digest: string; gitSha: string; artifact: { digest: string } };
      expect(plan).toMatchObject({ component: "app", env: "fly", gitSha: git(proj, ["rev-parse", "HEAD"]), shipSkip: { answer: false, decider: "table" } });
      expect(fly.fake.machines.size).toBe(0);

      const approve = await chant(delivery, env, "approve", "release", "ship", "--plan", plan.digest, "--approver", "alice");
      expect(approve.status, approve.out).toBe(0);

      // Ship: the approved tree on the Machine, the migration run once inside it, then Record.
      const shipped = await chant(delivery, env, "run", "release");
      expect(shipped.status, shipped.out).toBe(0);
      const [machine] = [...fly.fake.machines.values()].flat();
      expect(machine.name).toBe("web");
      expect(machine.config.metadata?.["chant-release-digest"]).toBe(plan.digest);
      expect(machine.config.metadata?.["chant-release-git-sha"]).toBe(plan.gitSha);
      const files = (machine.config.files as Array<{ guest_path: string; raw_value: string }>).map((f) => f.guest_path);
      expect(files).toEqual(expect.arrayContaining(["/srv/app/server.js", "/srv/app/migrate.js", "/srv/app/migrations/0001_init.sql"]));
      expect(Buffer.from((machine.config.files as Array<{ guest_path: string; raw_value: string }>).find((f) => f.guest_path === "/srv/app/server.js")!.raw_value, "base64").toString()).toBe(read(proj, "app/server.js"));
      expect((machine.config.init as { cmd: string[] }).cmd).toEqual(["sh", "-c", "cd /srv/app && exec node --disable-warning=ExperimentalWarning server.js"]);
      expect(fly.fake.execs.map((e) => e.command.join(" "))).toEqual(["sh -c cd /srv/app && node --disable-warning=ExperimentalWarning migrate.js 0001_init.sql"]);
      const ledger = await readReleaseLedger("fly", { cwd: delivery });
      expect(ledger.records).toHaveLength(1);
      expect(ledger.records[0]).toMatchObject({ component: "app", env: "fly", digest: plan.digest, gitSha: plan.gitSha, actor: "releaser", approver: "alice" });
      expect(await readReleasePlan(plan.digest, { cwd: delivery })).toMatchObject({ digest: plan.digest, artifact: { digest: plan.artifact.digest } });

      // A retry: the same plan, still approved; the Machine is left as it is, the migration's receipt matches, and nothing more is recorded.
      const again = await chant(delivery, env, "run", "release");
      expect(again.status, again.out).toBe(0);
      expect(fly.fake.execs).toHaveLength(1);
      expect((await readReleaseLedger("fly", { cwd: delivery })).records).toHaveLength(1);

      // A new commit is a new tree, so a new plan digest: the approval of the old one does not pass it (#2808).
      put(proj, "app/server.js", `${read(proj, "app/server.js")}// a change\n`);
      commit("change the app");
      const changed = await chant(delivery, env, "run", "release");
      expect(changed.status, changed.out).toBe(3);
      expect(changed.out).toContain(`gated on "ship"`);
      const next = readdirSync(join(delivery, "dist/plans")).filter((f) => f !== plans[0]);
      expect(next).toHaveLength(1);
      const nextPlan = JSON.parse(read(delivery, `dist/plans/${next[0]}`)) as { digest: string };
      expect(nextPlan.digest).not.toBe(plan.digest);
      expect(changed.out).toContain(nextPlan.digest);
      expect(machine.config.metadata?.["chant-release-digest"]).toBe(plan.digest);
      expect(fly.fake.execs).toHaveLength(1);
      expect((await readReleaseLedger("fly", { cwd: delivery })).records).toHaveLength(1);

      // Release B: that plan approved and shipped.
      const served = () => [...fly.fake.machines.values()].flat()[0];
      const servedFile = (path: string) =>
        Buffer.from((served().config.files as Array<{ guest_path: string; raw_value: string }>).find((f) => f.guest_path === path)!.raw_value, "base64").toString();
      const serverA = read(proj, "app/server.js").replace("// a change\n", "");
      const approveB = await chant(delivery, env, "approve", "release", "ship", "--plan", nextPlan.digest, "--approver", "alice");
      expect(approveB.status, approveB.out).toBe(0);
      const shippedB = await chant(delivery, env, "run", "release");
      expect(shippedB.status, shippedB.out).toBe(0);
      expect(served().config.metadata?.["chant-release-digest"]).toBe(nextPlan.digest);
      expect(servedFile("/srv/app/server.js")).toBe(read(proj, "app/server.js"));
      expect((await readReleaseLedger("fly", { cwd: delivery })).records).toHaveLength(2);

      // Roll back (#2800): the rollback Op plans release A again, its tree archived again from its commit, and stops at its gate.
      const plansBefore = new Set(readdirSync(join(delivery, "dist/plans")));
      const gatedBack = await chant(delivery, env, "run", "rollback");
      expect(gatedBack.status, gatedBack.out).toBe(3);
      expect(gatedBack.out).toContain(`gated on "rollback"`);
      const rollbackPlans = readdirSync(join(delivery, "dist/plans")).filter((f) => !plansBefore.has(f));
      expect(rollbackPlans).toHaveLength(1);
      const rollbackPlan = JSON.parse(read(delivery, `dist/plans/${rollbackPlans[0]}`)) as { digest: string; gitSha: string; rollback: { to: string; from: string }; artifact: { digest: string } };
      expect(rollbackPlan).toMatchObject({ gitSha: plan.gitSha, rollback: { to: plan.digest, from: nextPlan.digest }, artifact: { digest: plan.artifact.digest } });
      expect(served().config.metadata?.["chant-release-digest"]).toBe(nextPlan.digest);

      const approveBack = await chant(delivery, env, "approve", "rollback", "rollback", "--plan", rollbackPlan.digest, "--approver", "carol");
      expect(approveBack.status, approveBack.out).toBe(0);
      const back = await chant(delivery, env, "run", "rollback");
      expect(back.status, back.out).toBe(0);
      // The Machine serves A: its digest, its commit and its files. Migrations are not run again.
      expect(served().config.metadata?.["chant-release-digest"]).toBe(plan.digest);
      expect(served().config.metadata?.["chant-release-git-sha"]).toBe(plan.gitSha);
      expect(servedFile("/srv/app/server.js")).toBe(serverA);
      expect(fly.fake.execs).toHaveLength(1);
      const afterBack = (await readReleaseLedger("fly", { cwd: delivery })).records;
      expect(afterBack).toHaveLength(3);
      expect(afterBack[2]).toMatchObject({
        component: "app",
        env: "fly",
        digest: plan.digest,
        gitSha: plan.gitSha,
        actor: "releaser",
        approver: "carol",
        restores: { env: "fly", runId: afterBack[0].runId, timestamp: afterBack[0].timestamp },
      });

      // Again: the same rollback plan, still approved; the Machine is left as it is and nothing more is recorded.
      const backAgain = await chant(delivery, env, "run", "rollback");
      expect(backAgain.status, backAgain.out).toBe(0);
      expect(served().config.metadata?.["chant-release-digest"]).toBe(plan.digest);
      expect((await readReleaseLedger("fly", { cwd: delivery })).records).toHaveLength(3);
    } finally {
      await fly.close();
    }
  });
});
