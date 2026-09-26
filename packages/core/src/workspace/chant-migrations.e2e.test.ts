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
 * That test runs the Machines API's running mode (#2831), so each release is
 * also checked over HTTP: the shipped tree serves, the migration's table is
 * there, and the rollback serves the first release's page again.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yaml from "js-yaml";
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
import { CHANT_MIGRATIONS } from "./chant-migrations";
import { CHUD_LEXICON_EXIT, chudLexiconExit, convertPoints } from "./chant-migrations/chud-lexicon-exit";
import { CHUD_LEXICON_EXIT_SHIP_INPUTS } from "./chant-migrations/chud-lexicon-exit-ship-inputs";
import { CHUD_LEXICON_EXIT_ROLLBACK } from "./chant-migrations/chud-lexicon-exit-rollback";
import { CHUD_LEXICON_EXIT_SHIP_POLICY } from "./chant-migrations/chud-lexicon-exit-ship-policy";
import { CHUD_LEXICON_EXIT_FLY_SITE, chudLexiconExitFlySite } from "./chant-migrations/chud-lexicon-exit-fly-site";
import { CHUD_LEXICON_EXIT_LIVE_NAMES } from "./chant-migrations/chud-lexicon-exit-live-names";
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

/** `paths` as 0.92.0's `chud-lexicon-exit` writes them over the project as it is now. */
function exitWrote(paths: string[]): Record<string, string> {
  const plan = chudLexiconExit.plan({ dir: proj, lineage: readLock(proj)?.scopes["."] ?? ({ migrations: [], files: {} } as never), chantVersion: readerVersion() })!;
  return Object.fromEntries(paths.map((p) => [p, plan.changes.find((c) => c.path === p)!.data!.toString("utf-8")]));
}
/** Put files back as a release left them, with the lock naming only `migrations`, and commit. */
function asReleased(files: Record<string, string>, migrations: string[]): void {
  for (const [p, text] of Object.entries(files)) put(proj, p, text);
  const lock = JSON.parse(read(proj, ".chant/workspace.lock.json")) as { scopes: Record<string, { migrations: string[] }> };
  lock.scopes["."].migrations = migrations;
  put(proj, ".chant/workspace.lock.json", JSON.stringify(lock, null, 2) + "\n");
  commit("as 0.92.0 migrated it");
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
    for (const gone of ["delivery/ops/chant-lexicon-chud", "delivery/ops/dispatch.op.ts", "delivery/ops/upgrade.op.ts", "delivery/deploy/site.ts", "delivery/deploy/fly-machine.ts", "delivery/.chant", "delivery/.npmrc", "delivery/decisions/points.yaml"]) {
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

    // The Fly site is the fly lexicon's FlySite composite, and the app component names it (#2809).
    const fly = read(proj, "delivery/deploy/fly.ts");
    expect(fly).toContain('import { Fly, FlySite } from "@intentius/chant-lexicon-fly";');
    expect(fly).toContain('import { appSlug } from "../app-name.ts";');
    expect(fly).toContain("export const flySite = FlySite({\n  app: appSlug,\n  org: Fly.OrgSlug,\n  region: \"iad\",\n  machine: \"web\",\n  image: \"node:22-slim\",\n  port: 8080,");
    expect(fly).toContain('volume: { name: "data", sizeGb: 1, path: "/data" },');
    expect(fly).toContain("secrets: { APP_SECRET: process.env.CHUD_FLY_APP_SECRET || undefined },");
    expect(read(proj, "delivery/deploy/app.component.ts")).toContain('composites: ["FlySite"],');

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
    // A repo migrated from chud gets every follow-on in the same upgrade.
    expect(lineage.migrations).toEqual(CHANT_MIGRATIONS.map((m) => m.id));
    // The ship gate's policy lets a person pass (#2810).
    expect(read(proj, "delivery/decisions/ship-skip.cedar.ts")).toContain("policies: [personApproves, agentSkipsOnTableYes]");
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

describe("chud-lexicon-exit-ship-inputs, over a repo chud-lexicon-exit migrated before it existed (#2811)", () => {
  const RELEASE = "delivery/ops/release.op.ts";
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const released = exitWrote([RELEASE]);
    await upgrade();
    const lock = readLock(proj)!.scopes["."].migrations.filter((id) => id !== CHUD_LEXICON_EXIT_SHIP_INPUTS);
    // As 0.92.0 wrote it: decide from the systemone lexicon (#2829 moved it into core since).
    const at092 = released[RELEASE]
      .replace("releasePlan, releaseRecord, decide } from \"@intentius/chant/op\";", "releasePlan, releaseRecord } from \"@intentius/chant/op\";")
      .replace('import { flyRelease } from "@intentius/chant-lexicon-fly";', 'import { decide } from "@intentius/chant-lexicon-systemone";\nimport { flyRelease } from "@intentius/chant-lexicon-fly";')
      .replace("through chant's `decide` activity, and", "through the systemone lexicon's `decide` activity, and");
    expect(at092).toContain('import { decide } from "@intentius/chant-lexicon-systemone";');
    asReleased({ [RELEASE]: at092 }, lock);
  });

  test("the dry run lists it; the upgrade passes the inputs and the lock records it; a second plans nothing", async () => {
    expect(read(proj, RELEASE)).toContain('const shipSkip = decide("ship-skip", { id: "shipSkip" });');
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const dry = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(dry.outcome).toBe("dry-run");
    expect(lines.join("\n")).toContain(`chant migration: ${CHUD_LEXICON_EXIT_SHIP_INPUTS} (applied)`);
    expect(lines.join("\n")).toContain(`write: ${RELEASE}`);

    await upgrade();
    const release = read(proj, RELEASE);
    expect(release).toContain('const shipSkip = decide("ship-skip", { id: "shipSkip", inputs });');
    expect(release).toContain('import { readReleaseLedger } from "@intentius/chant/lifecycle/release-ledger";');
    expect(release).toContain('const WORK: Array<{ dir: string; match: string }> = [{"dir":"work","match":"^W-[0-9]{3,}-.+\\\\.md$"}];');
    expect(release).toContain('const APP = "app";');
    expect(release).toContain("with\n *   the inputs it declares");
    expect(readLock(proj)!.scopes["."].migrations).toContain(CHUD_LEXICON_EXIT_SHIP_INPUTS);

    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
  });

  test("a release Op the project changed so the decide step is gone is left alone", async () => {
    put(proj, RELEASE, read(proj, RELEASE).replace('const shipSkip = decide("ship-skip", { id: "shipSkip" });', 'const shipSkip = decide("ship-skip", { id: "shipSkip", inputs: { "release.units": 0 } });'));
    commit("our own inputs");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(staged.chantMigrations.find((m) => m.id === CHUD_LEXICON_EXIT_SHIP_INPUTS)).toBeUndefined();
    } finally {
      staged.dispose();
    }
  });
});

describe("chud-lexicon-exit-ship-policy, over a repo chud-lexicon-exit migrated before it existed (#2810)", () => {
  const POLICY = "delivery/decisions/ship-skip.cedar.ts";
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const released = exitWrote([POLICY]);
    await upgrade();
    asReleased(released, readLock(proj)!.scopes["."].migrations.filter((id) => id !== CHUD_LEXICON_EXIT_SHIP_POLICY));
  });

  test("the dry run lists it; the upgrade adds the person's permit and the lock records it; a second plans nothing", async () => {
    expect(read(proj, POLICY)).not.toContain("personApproves");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const dry = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(dry.outcome).toBe("dry-run");
    const out = lines.join("\n");
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT_SHIP_POLICY} (applied)`);
    expect(out).toContain(`write: ${POLICY}`);

    await upgrade();
    const policy = read(proj, POLICY);
    expect(policy).toContain('import { DenyByDefaultSet, Policy, gatePolicy, GATE_AGENT_TYPE, GATE_HUMAN_TYPE, PASS_GATE_ACTION } from "@intentius/chant-lexicon-cedar";');
    expect(policy).toContain('export const personApproves = new Policy({\n  effect: "permit",\n  principal: { is: person },');
    expect(policy).toContain("policies: [personApproves, agentSkipsOnTableYes]");
    expect(policy).toContain('annotations: { id: "agents-never-skip-otherwise" }');
    expect(readLock(proj)!.scopes["."].migrations).toContain(CHUD_LEXICON_EXIT_SHIP_POLICY);

    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
  });

  test("a policy the project rewrote without the anchors is a conflict, and nothing is applied", async () => {
    put(proj, POLICY, read(proj, POLICY).replace("  policies: [agentSkipsOnTableYes],\n", "  policies: [agentSkipsOnTableYes, ours],\n"));
    commit("our own policy set");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      const m = staged.chantMigrations.find((x) => x.id === CHUD_LEXICON_EXIT_SHIP_POLICY);
      expect(m).toMatchObject({ applied: false, conflicts: [{ path: POLICY }] });
    } finally {
      staged.dispose();
    }
  });
});

describe("chud-lexicon-exit-fly-site, over a repo chud-lexicon-exit migrated before it existed (#2809)", () => {
  const FILES = ["delivery/deploy/fly.ts", "delivery/deploy/fly-machine.ts", "delivery/deploy/app.component.ts"];
  const RELEASE = "delivery/ops/release.op.ts";
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const released = exitWrote(FILES);
    await upgrade();
    // The release Op as the other follow-ons left it, with 0.92.0's line on where the Fly requests come from.
    released[RELEASE] = read(proj, RELEASE).replace("the FlySite composite in deploy/fly.ts, into dist/fly.json", "deploy/fly.ts and deploy/fly-machine.ts, into dist/fly.json");
    asReleased(released, readLock(proj)!.scopes["."].migrations.filter((id) => id !== CHUD_LEXICON_EXIT_FLY_SITE));
  });

  test("the dry run lists it; the upgrade declares the FlySite and the component names it; a second plans nothing", async () => {
    expect(read(proj, "delivery/deploy/fly.ts")).toContain("export const flyApp = new App(");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const dry = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(dry.outcome).toBe("dry-run");
    const out = lines.join("\n");
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT_FLY_SITE} (applied)`);
    expect(out).toContain("write: delivery/deploy/fly.ts");
    expect(out).toContain("delete: delivery/deploy/fly-machine.ts");

    await upgrade();
    expect(read(proj, "delivery/deploy/fly.ts")).toContain("export const flySite = FlySite({");
    expect(existsSync(join(proj, "delivery/deploy/fly-machine.ts"))).toBe(false);
    expect(read(proj, "delivery/deploy/app.component.ts")).toContain('composites: ["FlySite"],');
    expect(read(proj, "delivery/ops/release.op.ts")).toContain("the FlySite composite in deploy/fly.ts, into dist/fly.json");
    expect(readLock(proj)!.scopes["."].migrations).toContain(CHUD_LEXICON_EXIT_FLY_SITE);

    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
  });
});

describe("chud-lexicon-exit-live-names, over a repo chud-lexicon-exit migrated before it existed (#2833)", () => {
  const COMPONENT = "delivery/deploy/app.component.ts";
  beforeEach(async () => {
    await makeProject("dir");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const released = exitWrote([COMPONENT]);
    await upgrade();
    asReleased(released, readLock(proj)!.scopes["."].migrations.filter((id) => id !== CHUD_LEXICON_EXIT_LIVE_NAMES));
  });

  test("the dry run lists it; the upgrade adds liveNames and the lock records it; a second plans nothing", async () => {
    expect(read(proj, COMPONENT)).not.toContain("liveNames");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const dry = await upgradeCommand({ root: proj, to: target(), dryRun: true, runChant: passing });
    expect(dry.outcome).toBe("dry-run");
    const out = lines.join("\n");
    expect(out).toContain(`chant migration: ${CHUD_LEXICON_EXIT_LIVE_NAMES} (applied)`);
    expect(out).toContain(`write: ${COMPONENT}`);

    await upgrade();
    const component = read(proj, COMPONENT);
    expect(component).toContain('dependsOn: [],\n  liveNames: ["server"],\n');
    expect(component).toContain("Its live name is the Machine the release Op\n * ships to, the entity fly-machine.ts calls server (chant#2833)");
    expect(readLock(proj)!.scopes["."].migrations).toContain(CHUD_LEXICON_EXIT_LIVE_NAMES);

    const again = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(again.chantMigrations).toEqual([]);
      expect(again.changed).toBe(false);
    } finally {
      again.dispose();
    }
  });

  test("an app component the project rewrote without the anchor is a conflict, and nothing is applied", async () => {
    put(proj, COMPONENT, read(proj, COMPONENT).replace("  dependsOn: [],\n", ""));
    commit("our own component shape");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      const m = staged.chantMigrations.find((x) => x.id === CHUD_LEXICON_EXIT_LIVE_NAMES);
      expect(m).toMatchObject({ applied: false, conflicts: [{ path: COMPONENT }] });
    } finally {
      staged.dispose();
    }
  });

  test("a component that already declares liveNames is left alone", async () => {
    put(proj, COMPONENT, read(proj, COMPONENT).replace("  dependsOn: [],\n", '  dependsOn: [],\n  liveNames: ["web"],\n'));
    commit("our own liveNames");
    const staged = await stageUpgrade({ root: proj, to: target(), runChant: passing });
    try {
      expect(staged.chantMigrations.find((m) => m.id === CHUD_LEXICON_EXIT_LIVE_NAMES)).toBeUndefined();
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

  test("a Fly site the project changed keeps its resources, and the plan says it is not a composite instance (#2809)", async () => {
    put(proj, "delivery/deploy/fly-machine.ts", read(proj, "delivery/deploy/fly-machine.ts").replace('region: "iad",\n  config', 'region: "ord",\n  config'));
    commit("the Machine in another region");
    await upgrade();
    expect(read(proj, "delivery/deploy/fly.ts")).toContain("export const flyApp = new App(");
    expect(read(proj, "delivery/deploy/fly.ts")).not.toContain("FlySite");
    expect(read(proj, "delivery/deploy/fly-machine.ts")).toContain('region: "ord",');
    const component = read(proj, "delivery/deploy/app.component.ts");
    expect(component).toContain('composites: ["FlySite"],');
    expect(readLock(proj)!.scopes["."].migrations).toContain(CHUD_LEXICON_EXIT_FLY_SITE);
    // What its plan said: only the component is written, and the composite is not moved.
    put(proj, "delivery/deploy/app.component.ts", component.replace('  composites: ["FlySite"],\n', ""));
    const plan = chudLexiconExitFlySite.plan({ dir: proj, lineage: readLock(proj)!.scopes["."], chantVersion: readerVersion() })!;
    expect(plan.changes.map((c) => c.path)).toEqual(["delivery/deploy/app.component.ts"]);
    expect(plan.notMoved.map((n) => n.what)).toContain("the Fly site as a composite instance (delivery/deploy/fly.ts is not the template's, so its resources are kept as they are)");
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

  type FakeFlaps = {
    execs: Array<{ command: string[] }>;
    machines: Map<string, Array<{ name: string; config: Record<string, unknown> & { metadata?: Record<string, string> } }>>;
    endpoint(app: string, name: string): string | undefined;
    processes(): Array<{ pid: number | undefined }>;
  };
  /**
   * The fly lexicon's in-memory Machines API, served on a local port. With `run`, its running mode (#2831): each
   * started Machine's files are written under `run`, its start command runs, and its service answers over HTTP.
   */
  async function flaps(run?: string): Promise<{ endpoint: string; fake: FakeFlaps; close(): Promise<void> }> {
    if (run) {
      const { serveLocalMachines } = (await import(pathToFileURL(join(repoRoot, "lexicons/fly/src/op/activities/machines-local.ts")).href)) as {
        serveLocalMachines(o: { port: number; root: string; log: string }): Promise<{ url: string; machines: FakeFlaps; close(): Promise<void> }>;
      };
      const served = await serveLocalMachines({ port: 0, root: run, log: join(run, "machines.log") });
      return { endpoint: served.url, fake: served.machines, close: served.close };
    }
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
    const fly = await flaps(join(root, "fly"));
    const env = { FLY_FLAPS_BASE_URL: fly.endpoint, FLY_API_TOKEN: "test", CHUD_FLY_APP_SECRET: "s3cret", GITHUB_ACTOR: "releaser" };
    /** The Machine's app over HTTP, on the host port its service is published on. */
    const site = async (path: string) => {
      const [app] = [...fly.fake.machines.keys()];
      const url = fly.fake.endpoint(app, "web");
      expect(url, read(root, "fly/machines.log")).toBeDefined();
      const res = await fetch(`${url}${path}`);
      return { status: res.status, text: await res.text() };
    };
    try {
      const build = await chant(delivery, env, "build", "-o", join(root, "build.out"));
      expect(build.status, build.out).toBe(0);
      const lint = await chant(delivery, env, "lint");
      expect(lint.status, lint.out).toBe(0);
      // `npm run ci:check`: the committed workflow is what ci/ci.ts builds.
      const ci = await chant(delivery, env, "build", "ci", "--lexicon", "github", "-o", join(root, "ci.yml"));
      expect(ci.status, ci.out).toBe(0);
      expect(read(root, "ci.yml")).toBe(read(proj, ".github/workflows/ci.yml"));

      // The Fly site is a composite instance, deployed by the app component (#2809): what the studio smoke's checks 27, 28 and 55 read.
      const graph = await chant(proj, env, "workspace", "graph", "--composites", "--json");
      expect(graph.status, graph.out).toBe(0);
      const doc = JSON.parse(graph.out.slice(graph.out.indexOf("{"))) as { composites: Array<{ id: string; member: string; kinds: string[]; lexicons: string[]; components: Array<{ component: string; by: string; via: string }> }>; components: Array<{ id: string; archetype: string }>; reasons: unknown[] };
      expect(doc.reasons).toEqual([]);
      expect(doc.composites).toHaveLength(1);
      expect(doc.composites[0]).toMatchObject({ id: "delivery/flySite", member: "delivery", kinds: ["FlySite"], lexicons: ["fly"], components: [{ component: "delivery/app", by: "composites", via: "member" }] });
      expect(doc.components.find((c) => c.id === "delivery/app")?.archetype).toBe("service");
      // The plan a release ships with has the one Machine, with the resources fly.ts and fly-machine.ts declared.
      const flyPlan = await chant(delivery, env, "build", "deploy", "--lexicon", "fly", "-o", join(root, "fly.json"));
      expect(flyPlan.status, flyPlan.out).toBe(0);
      const requests = Object.values(JSON.parse(read(root, "fly.json")) as Record<string, { endpoint: string; body: Record<string, unknown> }>);
      const machines = requests.filter((r) => /\/machines$/.test(r.endpoint));
      expect(machines).toHaveLength(1);
      expect(machines[0].body).toMatchObject({
        name: "web",
        region: "iad",
        config: {
          image: "node:22-slim",
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
          mounts: [{ volume: "data", path: "/data" }],
          services: [{ protocol: "tcp", internal_port: 8080, ports: [{ port: 443, handlers: ["tls", "http"] }, { port: 80, handlers: ["http"] }] }],
          env: { PORT: "8080", APP_DATA: "/data" },
        },
      });
      expect(requests.map((r) => r.endpoint).sort()).toEqual(["/v1/apps", "/v1/apps/notes/ip_assignments", "/v1/apps/notes/machines", "/v1/apps/notes/secrets/APP_SECRET", "/v1/apps/notes/volumes"].sort());

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
      // The shipped tree runs (#2831): the app answers on its port, its page is the committed one, and /health reads
      // the table the migration created in the data Volume.
      const health = await site("/health");
      expect(health.status, health.text).toBe(200);
      expect(JSON.parse(health.text)).toMatchObject({ status: "healthy", services: { database: "healthy" } });
      expect((await site("/")).text).toBe(read(proj, "app/public/index.html"));
      const note = await site("/api/notes");
      expect(JSON.parse(note.text)).toEqual([]);
      const [{ pid: pidA }] = fly.fake.processes();
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
      const pageA = read(proj, "app/public/index.html");
      put(proj, "app/server.js", `${read(proj, "app/server.js")}// a change\n`);
      put(proj, "app/public/index.html", `${pageA}<!-- release B -->\n`);
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
      // B runs in a new process on the same port, over the same data.
      expect((await site("/")).text).toBe(read(proj, "app/public/index.html"));
      expect((await site("/")).text).not.toBe(pageA);
      expect((await site("/health")).status).toBe(200);
      const [{ pid: pidB }] = fly.fake.processes();
      expect(pidB).not.toBe(pidA);

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
      // Over HTTP: A's page again, from a new process.
      expect((await site("/")).text).toBe(pageA);
      expect((await site("/health")).status).toBe(200);
      expect(fly.fake.processes()[0].pid).not.toBe(pidB);
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

  test("asks ship-skip with the inputs the point declares, from the diff since the release the site serves (#2811)", { timeout: 1_200_000 }, async () => {
    await upgrade();
    // A row above the default: a release that is not the first and changes no work item may skip the gate.
    const pointsDoc = JSON.parse(read(proj, "decisions/points.json")) as { points: Record<string, { deciders: Array<{ kind: string; rows?: unknown[] }> }> };
    pointsDoc.points["ship-skip"].deciders[0].rows!.unshift({ when: { "release.first_release": false, "release.work_changed": false }, answer: true, note: "the app alone changed" });
    put(proj, "decisions/points.json", JSON.stringify(pointsDoc, null, 2) + "\n");
    commit("a ship-skip row for the test");
    const delivery = join(proj, "delivery");
    symlinkSync(join(repoRoot, "node_modules"), join(delivery, "node_modules"));
    writeFileSync(join(proj, ".git/info/exclude"), "node_modules\n");

    const seen = new Set<string>();
    /** The ship-skip answer record the last run wrote: its inputs, answer and table row. */
    const answered = (): { inputs: Record<string, unknown>; answer: unknown; decider: { kind: string; row: number } } => {
      const fresh = readdirSync(join(proj, "answers")).filter((f) => f.startsWith("ship-skip-") && !seen.has(f));
      expect(fresh).toHaveLength(1);
      seen.add(fresh[0]);
      return yaml.load(read(proj, `answers/${fresh[0]}`).split("---\n")[1]) as never;
    };
    const count = (text: string) => text.split("\n").filter(Boolean).length;
    const fly = await flaps();
    const env = { FLY_FLAPS_BASE_URL: fly.endpoint, FLY_API_TOKEN: "test", CHUD_FLY_APP_SECRET: "s3cret", GITHUB_ACTOR: "releaser" };
    try {
      const first = await chant(delivery, env, "run", "release");
      expect(first.status, first.out).toBe(3);
      // The first release: every file on HEAD counts.
      expect(answered()).toMatchObject({
        inputs: {
          "release.first_release": true,
          "release.new_migrations": 1,
          "release.files_changed": count(git(proj, ["ls-tree", "-r", "--name-only", "HEAD"])),
          "release.app_changed": true,
          "release.work_changed": true,
          "release.units": 0,
        },
        answer: false,
        decider: { kind: "table", row: 1 },
      });
      const approve = await chant(delivery, env, "approve", "release", "ship", "--approver", "alice");
      expect(approve.status, approve.out).toBe(0);
      const shipped = await chant(delivery, env, "run", "release");
      expect(shipped.status, shipped.out).toBe(0);
      const serving = git(proj, ["rev-parse", "HEAD"]);

      put(proj, "app/server.js", `${read(proj, "app/server.js")}// a change\n`);
      commit("change the app");
      const second = await chant(delivery, env, "run", "release");
      expect(second.status, second.out).toBe(3);
      // The app alone changed since the serving release: the row above the default answers yes.
      expect(answered()).toMatchObject({
        inputs: {
          "release.first_release": false,
          "release.new_migrations": 0,
          "release.files_changed": count(git(proj, ["diff", "--name-only", serving, "HEAD"])),
          "release.app_changed": true,
          "release.work_changed": false,
          "release.units": 0,
        },
        answer: true,
        decider: { kind: "table", row: 0 },
      });

      put(proj, "work/W-001-notes-search.md", "---\nid: W-001\n---\nSearch notes.\n");
      put(proj, "app/migrations/0002_search.sql", "-- search\n");
      commit("a work item and its migration");
      const third = await chant(delivery, env, "run", "release");
      expect(third.status, third.out).toBe(3);
      // A work item changed too, with a migration that would fire: the default row answers no.
      expect(answered()).toMatchObject({
        inputs: {
          "release.first_release": false,
          "release.new_migrations": 1,
          "release.files_changed": count(git(proj, ["diff", "--name-only", serving, "HEAD"])),
          "release.app_changed": true,
          "release.work_changed": true,
          "release.units": 1,
        },
        answer: false,
        decider: { kind: "table", row: 1 },
      });
    } finally {
      await fly.close();
    }
  });

  test("the ship gate's Cedar policy at enforce: a person's approval is allowed and passes the gate, an agent's is denied and does not (#2810)", { timeout: 1_200_000 }, async () => {
    await upgrade();
    const delivery = join(proj, "delivery");
    symlinkSync(join(repoRoot, "node_modules"), join(delivery, "node_modules"));
    writeFileSync(join(proj, ".git/info/exclude"), "node_modules\n");
    const policy = read(proj, "delivery/decisions/ship-skip.cedar.ts");
    expect(policy).toContain("principal: { is: person }");
    expect(policy).toContain("policies: [personApproves, agentSkipsOnTableYes]");
    const op = read(proj, "delivery/ops/release.op.ts");
    expect(op).toContain('mode: "log-only"');
    put(proj, "delivery/ops/release.op.ts", op.replace('mode: "log-only"', 'mode: "enforce"'));
    commit("the ship gate's policy at enforce");

    const fly = await flaps();
    const env = { FLY_FLAPS_BASE_URL: fly.endpoint, FLY_API_TOKEN: "test", CHUD_FLY_APP_SECRET: "s3cret", GITHUB_ACTOR: "releaser" };
    const decisions = () =>
      git(proj, ["show", "chant/lifecycle:_members/delivery/_gates/release.jsonl"])
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { kind?: string; resolvedBy?: string; approver?: { kind: string }; policyDecision?: { decision: string; determining: string[] } })
        .filter((r) => r.kind !== "pending");
    try {
      const gated = await chant(delivery, env, "run", "release");
      expect(gated.status, gated.out).toBe(3);

      // The agent's approval is recorded with the policy's deny, and does not count.
      const agent = await chant(delivery, env, "approve", "release", "ship", "--agent", "--approver", "release-bot");
      expect(agent.status, agent.out).toBe(0);
      expect(agent.out).toMatch(/Policy "ship-skip" \S+: deny \(agents-never-skip-otherwise\)/);
      expect(agent.out).toContain("An agent's approval does not count toward the quorum.");
      expect(decisions().at(-1)).toMatchObject({ resolvedBy: "release-bot", approver: { kind: "agent" }, policyDecision: { decision: "deny", determining: ["agents-never-skip-otherwise"] } });
      const stillGated = await chant(delivery, env, "run", "release");
      expect(stillGated.status, stillGated.out).toBe(3);
      expect(fly.fake.machines.size).toBe(0);

      // The person's is recorded with the policy's allow, and the next run passes the gate and ships.
      const person = await chant(delivery, env, "approve", "release", "ship", "--approver", "alice");
      expect(person.status, person.out).toBe(0);
      expect(person.out).toMatch(/Policy "ship-skip" \S+: allow \(a-person-approves\)/);
      expect(decisions().at(-1)).toMatchObject({ resolvedBy: "alice", approver: { kind: "human" }, policyDecision: { decision: "allow", determining: ["a-person-approves"] } });
      const shipped = await chant(delivery, env, "run", "release");
      expect(shipped.status, shipped.out).toBe(0);
      expect([...fly.fake.machines.values()].flat().map((m) => m.name)).toEqual(["web"]);
    } finally {
      await fly.close();
    }
  });
});
