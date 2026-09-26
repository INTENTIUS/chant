/**
 * The read contract for `chant workspace status --json` (#2544, #2524 D15,
 * D19): the output schema is a valid draft 2020-12 document, its closed code
 * lists match the code, and real output validates against it, for workspaces
 * built here with a `chant/lifecycle` branch holding member ledgers in both
 * layouts, and for the chant repo's own declaration (#2557).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../cli/registry";
import { listWorkspace } from "./ls";
import {
  formatStatus,
  runWorkspaceStatus,
  STATUS_CONTRACT_VERSION,
  STATUS_ERROR_CODES,
  STATUS_GATE_REASON_CODES,
  STATUS_OUTPUT_SCHEMA_ID,
  STATUS_REASON_CODES,
  STATUS_STEWARD_REASON_CODES,
  workspaceStatus,
  type StatusDocument,
} from "./status";
import schema from "./status.schema.json";
import { appendRunRecord } from "../lifecycle/run-ledger";
import { acquireStewardLease } from "../op/operator";
import { stewardWorkHolder } from "../op/work-lease-run";
import { claimWorkLease } from "../lifecycle/work-lease";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

function expectValid(doc: StatusDocument): void {
  const ok = validate(doc);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function result(doc: StatusDocument): Extract<StatusDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    input,
    env: { ...process.env, ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

/** A git repository holding `files`, committed. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-status-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

/**
 * Write `files` as the whole tree of a `chant/lifecycle` commit, the way the
 * lifecycle code stores ledgers, without touching the working tree or index.
 */
function lifecycle(root: string, files: Record<string, string>): string {
  const index = join(root, ".git", "status-test-index");
  const env = { GIT_INDEX_FILE: index };
  rmSync(index, { force: true });
  for (const [path, text] of Object.entries(files)) {
    const blob = git(root, ["hash-object", "-w", "--stdin"], env, text);
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
  }
  const tree = git(root, ["write-tree"], env);
  const commit = git(root, ["commit-tree", tree, "-m", "ledger"], env);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", commit]);
  rmSync(index, { force: true });
  return commit;
}

let n = 0;
/** One ledger line. */
function release(component: string, env: string, digest: string, gitSha: string, extra: Record<string, string> = {}): string {
  n++;
  return JSON.stringify({
    version: 1,
    component,
    env,
    digest,
    gitSha,
    runId: `run-${n}`,
    timestamp: `2026-09-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`,
    actor: "ci",
    ...extra,
  });
}
const jsonl = (...lines: string[]) => lines.join("\n") + "\n";

const D = (c: string) => `sha256:${c.repeat(64)}`;

const declaration = (members: unknown[]) => JSON.stringify({ name: "acme", schema: 1, members }, null, 2);

/** web has moved to _members/ (#2538); api and the root member still read the flat ledger. */
function twoLayouts(): string {
  const root = repo({
    "chant.workspace.json": declaration([
      { name: "site", dir: ".", kind: "other", because: "the root project" },
      { name: "web", dir: "apps/web", kind: "chant" },
      { name: "api", dir: "apps/api", kind: "chant" },
      { name: "examples", kind: "examples", glob: "examples/*" },
    ]),
    "apps/web/chant.config.ts": "",
    "apps/api/chant.config.ts": "",
  });
  lifecycle(root, {
    "_members/web/staging/releases.jsonl": jsonl(release("web", "staging", D("0"), "0".repeat(40)), release("web", "staging", D("a"), "a".repeat(40))),
    "_members/web/prod/releases.jsonl": jsonl(release("web", "prod", D("a"), "a".repeat(40))),
    "staging/releases.jsonl": jsonl(
      release("api", "staging", D("b"), "b".repeat(40)),
      release("worker", "staging", D("d"), "d".repeat(40)),
    ),
    "prod/releases.jsonl": jsonl(release("api", "prod", D("c"), "c".repeat(40))),
  });
  return root;
}

describe("status output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.$id).toBe(STATUS_OUTPUT_SCHEMA_ID);
    expect(STATUS_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the reason and error codes the code can return", () => {
    expect(schema.$defs.environment.properties.reason.oneOf[1].properties!.code.enum).toEqual([...STATUS_REASON_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...STATUS_ERROR_CODES]);
    expect(schema.$defs.gateLedger.properties.reason.oneOf[1].properties!.code.enum).toEqual([...STATUS_GATE_REASON_CODES]);
    expect(schema.$defs.member.properties.stewardReasons.items.properties.code.enum).toEqual([...STATUS_STEWARD_REASON_CODES]);
  });
});

describe("chant workspace status on built workspaces", () => {
  test("lists each member's latest release per environment, from _members/ and from the flat layout", async () => {
    const root = twoLayouts();
    const doc = result(await workspaceStatus({ cwd: join(root, "apps", "web"), env: "staging" }));
    expectValid(doc);
    expect(doc.lifecycle.commit).toBe(git(root, ["rev-parse", "chant/lifecycle"]));
    expect(doc.members.map((m) => m.name)).toEqual(["site", "web", "api"]);
    const [site, web, api] = doc.members;
    expect(web.environments).toHaveLength(1);
    expect(web.environments[0].ledger).toEqual({ layout: "members", path: "_members/web/staging/releases.jsonl", shared: false });
    // The later of the two records wins.
    expect(web.environments[0].releases.map((r) => [r.component, r.digest, r.gitSha])).toEqual([["web", D("a"), "a".repeat(40)]]);
    // No plan was ever written for these digests (ws-055, #2733): the field is present, and null.
    expect(web.environments[0].releases.map((r) => r.plan)).toEqual([null]);
    // api has no _members/api/ yet, so it falls back to the flat ledger, which the root member reads too.
    expect(api.environments[0].ledger).toEqual({ layout: "flat", path: "staging/releases.jsonl", shared: true });
    expect(site.environments[0].ledger).toEqual({ layout: "flat", path: "staging/releases.jsonl", shared: true });
    expect(api.environments[0].releases.map((r) => r.component)).toEqual(["api", "worker"]);
    expect(web.compare).toBeNull();
    expect(doc.summary).toEqual({ members: 3, released: 3, unreadable: 0, differing: null });
  });

  test("--compare-to shows both environments and marks the members whose digests differ", async () => {
    const root = twoLayouts();
    const doc = result(await workspaceStatus({ cwd: root, env: "staging", compareTo: "prod" }));
    expectValid(doc);
    const web = doc.members.find((m) => m.name === "web")!;
    const api = doc.members.find((m) => m.name === "api")!;
    expect(web.environments.map((e) => [e.env, e.ledger.path])).toEqual([
      ["staging", "_members/web/staging/releases.jsonl"],
      ["prod", "_members/web/prod/releases.jsonl"],
    ]);
    expect(web.compare).toEqual({ differs: false, components: [{ component: "web", state: "same", digest: D("a"), compareDigest: D("a") }] });
    expect(api.compare).toEqual({
      differs: true,
      components: [
        { component: "api", state: "differs", digest: D("b"), compareDigest: D("c") },
        { component: "worker", state: "only-env", digest: D("d"), compareDigest: null },
      ],
    });
    expect(doc.summary).toEqual({ members: 3, released: 3, unreadable: 0, differing: 2 });

    const text = formatStatus(doc);
    expect(text).toContain("acme  staging compared to prod  (chant/lifecycle at ");
    expect(text).toMatch(/web\s+web\s+sha256:aaaaaaaaaaaa aaaaaaaa\s+sha256:aaaaaaaaaaaa aaaaaaaa\n/);
    expect(text).toMatch(/api\s+api\s+sha256:bbbbbbbbbbbb bbbbbbbb\s+sha256:cccccccccccc cccccccc\s+differs/);
    expect(text).toMatch(/api\s+worker\s+sha256:dddddddddddd dddddddd\s+-\s+only-env/);
    expect(text).toContain("3 members, 3 with a release in staging, 2 differ from prod, 0 unreadable");
  });

  test("resolves a release's plan from _plans/<digest>.json, member-scoped per #2524 D7 (ws-055, #2733)", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "site", dir: ".", kind: "other", because: "the root project" },
        { name: "web", dir: "apps/web", kind: "chant" },
      ]),
      "apps/web/chant.config.ts": "",
    });
    const webPlan = { digest: D("a"), release: "r-web", units: [{ id: "w-1" }] };
    const apiPlan = { digest: D("b"), release: "r-api", units: [] };
    lifecycle(root, {
      "_members/web/staging/releases.jsonl": jsonl(release("web", "staging", D("a"), "a".repeat(40))),
      [`_members/web/_plans/sha256_${"a".repeat(64)}.json`]: JSON.stringify(webPlan),
      "staging/releases.jsonl": jsonl(release("api", "staging", D("b"), "b".repeat(40)), release("worker", "staging", D("c"), "c".repeat(40))),
      [`_plans/sha256_${"b".repeat(64)}.json`]: JSON.stringify(apiPlan),
    });
    const doc = result(await workspaceStatus({ cwd: root, env: "staging" }));
    expectValid(doc);
    const web = doc.members.find((m) => m.name === "web")!;
    const site = doc.members.find((m) => m.name === "site")!;
    expect(web.environments[0].releases[0].plan).toEqual(webPlan);
    const byComponent = new Map(site.environments[0].releases.map((r) => [r.component, r]));
    expect(byComponent.get("api")?.plan).toEqual(apiPlan);
    // worker has no plan stored under its digest: reads null, not an error.
    expect(byComponent.get("worker")?.plan).toBeNull();
  });

  test("compares on the input digest when a release has one", async () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "chart", dir: "chart", kind: "other", because: "helm" }]) });
    lifecycle(root, {
      "staging/releases.jsonl": jsonl(release("chart", "staging", D("1"), "1".repeat(40), { inputDigest: D("9") })),
      "prod/releases.jsonl": jsonl(release("chart", "prod", D("2"), "1".repeat(40), { inputDigest: D("9") })),
    });
    const doc = result(await workspaceStatus({ cwd: root, env: "staging", compareTo: "prod" }));
    expectValid(doc);
    expect(doc.members[0].compare?.components[0]).toMatchObject({ state: "same", digest: D("1"), compareDigest: D("2") });
    expect(doc.members[0].environments[0].ledger.shared).toBe(false);
  });

  test("a member whose ledger can't be read is listed with a reason code, and the read still succeeds", async () => {
    const root = twoLayouts();
    lifecycle(root, {
      "_members/web/staging/releases.jsonl": jsonl(release("web", "staging", D("a"), "a".repeat(40)), "{not json", JSON.stringify({ component: "web" })),
      "staging/releases.jsonl": jsonl(release("api", "staging", D("b"), "b".repeat(40))),
    });
    const doc = result(
      await workspaceStatus({
        cwd: root,
        env: "staging",
        compareTo: "prod",
        readLedger: async (path, cwd) => {
          if (path === "prod/releases.jsonl") throw new Error("fatal: bad object\nmore");
          const { readReleaseLedger } = await import("../lifecycle/release-ledger");
          return readReleaseLedger(path.slice(0, -"/releases.jsonl".length), { cwd });
        },
      }),
    );
    expectValid(doc);
    const web = doc.members.find((m) => m.name === "web")!;
    const api = doc.members.find((m) => m.name === "api")!;
    expect(web.readable).toBe(false);
    expect(web.environments[0].reason).toEqual({
      code: "ledger-malformed",
      message: "_members/web/staging/releases.jsonl: 2 lines are not a release record and were skipped",
    });
    expect(web.environments[0].releases.map((r) => r.digest)).toEqual([D("a")]);
    expect(api.environments[1].reason).toEqual({ code: "ledger-unreadable", message: "prod/releases.jsonl: fatal: bad object" });
    expect(api.environments[1].releases).toEqual([]);
    expect(doc.summary.unreadable).toBe(3);
    expect(formatStatus(doc)).toContain("  ledger-unreadable: prod/releases.jsonl: fatal: bad object");
  });

  test("a checkout with no chant/lifecycle branch lists every member with no release", async () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "web", dir: "web", kind: "chant" }]) });
    const doc = result(await workspaceStatus({ cwd: root, env: "prod" }));
    expectValid(doc);
    expect(doc.lifecycle.commit).toBeNull();
    expect(doc.members[0].environments[0]).toMatchObject({ releases: [], reason: null, ledger: { layout: "flat", shared: false } });
    expect(formatStatus(doc)).toContain("web     -          no release");
  });

  test("each member lists its box block: the capability, its broker and its scope (#2726)", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "web", dir: "web", kind: "chant" },
        {
          name: "box",
          dir: "box",
          kind: "other",
          because: "the box's declarations",
          box: { capabilities: [{ name: "fountain", broker: "lobby", scope: ["agent", "vault", "conversations", "sandboxes"] }, { name: "inference" }] },
        },
      ]),
    });
    const doc = result(await workspaceStatus({ cwd: root, env: "prod" }));
    expectValid(doc);
    expect(doc.members.map((m) => m.box)).toEqual([
      null,
      {
        capabilities: [
          { name: "fountain", broker: "lobby", scope: ["agent", "vault", "conversations", "sandboxes"] },
          { name: "inference", broker: null, scope: [] },
        ],
        isolation: null,
        intent: null,
      },
    ]);
  });

  test("every failure validates with its code", async () => {
    const empty = repo({});
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "chant-status-nogit-")));
    scratch.push(outside);
    writeFileSync(join(outside, "chant.workspace.json"), declaration([]));
    const broken = repo({ "chant.workspace.json": '{ "name": "acme", "schema": 1 "members": [] }' });
    const ok = repo({ "chant.workspace.json": declaration([]) });
    const docs = [
      await workspaceStatus({ cwd: empty, env: "prod" }),
      await workspaceStatus({ cwd: outside, env: "prod" }),
      await workspaceStatus({ cwd: broken, env: "prod" }),
      await workspaceStatus({ cwd: ok, env: "_members" }),
      await workspaceStatus({ cwd: ok, env: "prod", compareTo: "../x" }),
    ];
    for (const doc of docs) expectValid(doc);
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual([
      "declaration-missing",
      "not-a-git-repository",
      "declaration-unparseable",
      "environment-invalid",
      "environment-invalid",
    ]);
  });

  test("the command needs an environment, refuses --live, and exits 0 with unreadable members", async () => {
    const root = twoLayouts();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const run = (args: Record<string, unknown>) => runWorkspaceStatus({ args: { extraPositional2: root, ...args } } as unknown as CommandContext);
      expect(await run({})).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain("needs an environment");
      expect(await run({ extraPositional: "prod", compareTo: "--live" })).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain("doesn't read live state yet");
      expect(await run({ extraPositional: "prod", compareTo: "staging", json: true })).toBe(0);
      const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as StatusDocument;
      expectValid(printed);
      expect(await run({ extraPositional: "../prod", json: true })).toBe(1);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});

/** One pending fact, as a run records it. */
const pending = (op: string, gate: string, timestamp: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: "pending", op, gate, timestamp, expiresAt: "2026-12-31T00:00:00.000Z", origin: "cli", ...extra });

/** One approval, as `chant approve` records it. */
const approval = (op: string, gate: string, resolvedBy: string, timestamp: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: "resolution", op, gate, resolvedBy, timestamp, origin: "cli", approver: { kind: "human" }, ...extra });

const NOW = "2026-09-24T00:00:00.000Z";

/**
 * web writes _members/web/, api and the root member read the flat _gates/.
 * Each gate is in one state: approved, pending with part of a quorum,
 * expired, superseded, and an Op gate that records no environment.
 */
function gated(): string {
  const root = twoLayouts();
  lifecycle(root, {
    "_members/web/staging/releases.jsonl": jsonl(release("web", "staging", D("a"), "a".repeat(40))),
    "_members/web/_gates/web.jsonl": jsonl(
      pending("web", "deploy", "2026-09-20T00:00:00.000Z", { environment: "staging", planDigest: D("1") }),
      approval("web", "deploy", "alice", "2026-09-20T01:00:00.000Z", { environment: "staging", planDigest: D("1") }),
      pending("web", "deploy", "2026-09-21T00:00:00.000Z", { environment: "prod", planDigest: D("2") }),
      pending("web", "deploy", "2026-09-21T00:00:00.000Z", { environment: "qa", planDigest: D("3") }),
      // chant approve --expire writes a line with no environment; a run ignores it for an environment-bound gate.
      pending("web", "deploy", "2026-09-22T00:00:00.000Z", { expiresAt: "2026-09-22T00:00:00.000Z" }),
      pending("web", "review", "2026-09-20T00:00:00.000Z", { environment: "staging", planDigest: D("4"), approval: { mode: "log-only", quorum: { count: 2 } } }),
      approval("web", "review", "bob", "2026-09-20T02:00:00.000Z", { environment: "staging", planDigest: D("4") }),
      approval("web", "review", "unattested", "2026-09-20T03:00:00.000Z", { environment: "staging", planDigest: D("4"), origin: "mcp", approver: { kind: "agent" } }),
    ),
    "staging/releases.jsonl": jsonl(release("api", "staging", D("b"), "b".repeat(40))),
    "_gates/api.jsonl": jsonl(
      pending("api", "deploy", "2026-09-10T00:00:00.000Z", { environment: "staging", planDigest: D("5"), expiresAt: "2026-09-12T00:00:00.000Z" }),
      pending("api", "smoke", "2026-09-20T00:00:00.000Z", { environment: "staging", planDigest: D("6") }),
      approval("api", "smoke", "carol", "2026-09-20T05:00:00.000Z", { environment: "staging", planDigest: D("7") }),
      "{not json",
    ),
    "_gates/nightly.jsonl": jsonl(pending("nightly", "confirm", "2026-09-23T00:00:00.000Z"), approval("nightly", "confirm", "dave", "2026-09-23T01:00:00.000Z")),
  });
  return root;
}

describe("gate state in chant workspace status --json (#2674)", () => {
  test("each member lists its gates with state, approvals, quorum and the approve line", async () => {
    const doc = result(await workspaceStatus({ cwd: gated(), env: "staging", compareTo: "prod", now: NOW }));
    expectValid(doc);
    const [site, web, api] = doc.members;
    expect(web.gateLedger).toEqual({ layout: "members", path: "_members/web/_gates", shared: false, malformed: 0, reason: null });
    expect(web.gates).toEqual([
      {
        component: "web",
        name: "deploy",
        env: "staging",
        planDigest: D("1"),
        state: "approved",
        recordedAt: "2026-09-20T00:00:00.000Z",
        expiresAt: "2026-12-31T00:00:00.000Z",
        approvals: [{ principal: "alice", channel: "cli", at: "2026-09-20T01:00:00.000Z" }],
        needed: 1,
        approve: `chant approve web deploy --env staging --plan ${D("1")}`,
      },
      {
        component: "web",
        name: "deploy",
        env: "prod",
        planDigest: D("2"),
        state: "pending",
        recordedAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-12-31T00:00:00.000Z",
        approvals: [],
        needed: 1,
        approve: `chant approve web deploy --env prod --plan ${D("2")}`,
      },
      {
        component: "web",
        name: "review",
        env: "staging",
        planDigest: D("4"),
        state: "pending",
        recordedAt: "2026-09-20T00:00:00.000Z",
        expiresAt: "2026-12-31T00:00:00.000Z",
        // The agent's approval doesn't count toward the quorum.
        approvals: [{ principal: "bob", channel: "cli", at: "2026-09-20T02:00:00.000Z" }],
        needed: 2,
        approve: `chant approve web review --env staging --plan ${D("4")}`,
      },
    ]);
    // api and the root member both read the flat _gates/.
    expect(api.gateLedger).toEqual({ layout: "flat", path: "_gates", shared: true, malformed: 1, reason: null });
    expect(site.gates).toEqual(api.gates);
    expect(api.gates.map((g) => [g.component, g.name, g.env, g.state, g.approve])).toEqual([
      ["api", "deploy", "staging", "expired", `chant approve api deploy --env staging --plan ${D("5")}`],
      ["api", "smoke", "staging", "superseded", `chant approve api smoke --env staging --plan ${D("6")}`],
      ["nightly", "confirm", null, "approved", "chant approve nightly confirm"],
    ]);
    // The superseding approval named another plan, so it isn't listed as one that counts.
    expect(api.gates[1].approvals).toEqual([]);
    expect(api.gates[2]).toMatchObject({ planDigest: null, approvals: [{ principal: "dave", channel: "cli" }] });
    // Gate reasons and gate states don't change readable or the summary.
    expect(doc.summary.unreadable).toBe(0);
  });

  test("only the environments asked for are listed, and the text view doesn't change", async () => {
    const root = gated();
    const doc = result(await workspaceStatus({ cwd: root, env: "prod", now: NOW }));
    expectValid(doc);
    const web = doc.members.find((m) => m.name === "web")!;
    expect(web.gates.map((g) => [g.name, g.env])).toEqual([["deploy", "prod"]]);
    const plain = { ...doc, members: doc.members.map((m) => ({ ...m, gates: [], gateLedger: { ...m.gateLedger, reason: null } })) };
    expect(formatStatus(doc)).toBe(formatStatus(plain));
    expect(formatStatus(doc)).not.toContain("deploy");
  });

  test("a member with no gate ledger, a checkout with no branch, and an unreadable ledger each carry a reason", async () => {
    const root = twoLayouts();
    const none = result(await workspaceStatus({ cwd: root, env: "staging", now: NOW }));
    expectValid(none);
    expect(none.members.map((m) => [m.name, m.gateLedger.reason?.code, m.gates.length])).toEqual([
      ["site", "gates-no-gate-ledger", 0],
      ["web", "gates-no-gate-ledger", 0],
      ["api", "gates-no-gate-ledger", 0],
    ]);
    expect(none.members[1].gateLedger.reason!.message).toBe("_members/web/_gates does not exist on chant/lifecycle: no run has reached a gate");

    const bare = repo({ "chant.workspace.json": declaration([{ name: "web", dir: "web", kind: "chant" }]) });
    const noBranch = result(await workspaceStatus({ cwd: bare, env: "prod", now: NOW }));
    expectValid(noBranch);
    expect(noBranch.members[0].gateLedger).toMatchObject({ layout: "flat", path: "_gates", reason: { code: "gates-no-ledger" } });

    const broken = result(
      await workspaceStatus({
        cwd: gated(),
        env: "staging",
        now: NOW,
        readGates: async (dir) => {
          if (dir === "_members/web/_gates") throw new Error("fatal: bad object\nmore");
          return null;
        },
      }),
    );
    expectValid(broken);
    const web = broken.members.find((m) => m.name === "web")!;
    expect(web.gateLedger.reason).toEqual({ code: "gates-ledger-unreadable", message: "_members/web/_gates: fatal: bad object" });
    expect(web.gates).toEqual([]);
    expect(web.readable).toBe(true);
  });

  test("the JSON the command prints carries the gates", async () => {
    const root = gated();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runWorkspaceStatus({ args: { extraPositional: "staging", extraPositional2: root, json: true } } as unknown as CommandContext)).toBe(0);
      const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as StatusDocument;
      expectValid(printed);
      expect(result(printed).members.find((m) => m.name === "web")!.gates.map((g) => g.approve)).toContain(`chant approve web deploy --env staging --plan ${D("1")}`);
    } finally {
      log.mockRestore();
    }
  });
});

describe("stewards in chant workspace status --json (#2731)", () => {
  const op = (name: string, cron?: string) => ({
    name,
    overview: name,
    phases: [{ name: "Run", steps: [{ kind: "activity", fn: "noop", args: {} }] }],
    ...(cron ? { schedule: { cron, overlap: "skip" } } : {}),
  });

  /** A box member declaring one steward, local by default and fountain on fountain-k3d. */
  function stewarded(): string {
    const steward = {
      kind: "Chant::Steward",
      name: "box-steward",
      ops: [
        op("box-converge", "* * * * *"),
        op("box-release"),
        { ...op("box-dispatch", "*/5 * * * *"), workLease: { item: ["W-1", "W-2"] }, changesCheckout: true },
      ],
      form: { default: "local", environments: { "fountain-k3d": "fountain" } },
      capabilities: ["fountain", "inference"],
      vault: null,
    };
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "box", dir: "box", kind: "chant", box: { capabilities: [{ name: "fountain", broker: "lobby", scope: ["agent", "vault"] }] } },
        { name: "notes", dir: "notes", kind: "other", because: "prose" },
      ]),
      "box/chant.config.ts": "export default {};\n",
      "box/ops/steward.op.ts": `export const steward = ${JSON.stringify(steward)};\n`,
      "notes/README.md": "notes\n",
    });
    lifecycle(root, { "README": "ledger\n" });
    return root;
  }

  test("names the steward, its form in the environment asked for, its Ops, schedules, last runs and lease", async () => {
    const root = stewarded();
    const box = join(root, "box");
    await appendRunRecord(
      { op: "box-converge", env: "local", started: "2026-09-25T10:00:00.000Z", ended: "2026-09-25T10:00:05.000Z", status: "ok", labels: {}, outcomes: {}, phases: [] },
      { cwd: box },
    );
    expect((await acquireStewardLease("box-steward", "box-host:1:abc", { cwd: box, now: () => new Date("2026-09-25T10:00:00.000Z") })).acquired).toBe(true);
    // #2748: the dispatch turn holds W-1; someone else holds W-2.
    const turn = await claimWorkLease("W-1", stewardWorkHolder("box-steward", "box-dispatch", "box-host:1:abc"), { cwd: box, ttlMs: 600_000, now: () => new Date("2026-09-25T10:00:30.000Z") });
    expect(turn.ok).toBe(true);
    expect((await claimWorkLease("W-2", "someone-else", { cwd: box, ttlMs: 600_000, now: () => new Date("2026-09-25T10:00:30.000Z") })).ok).toBe(true);

    const doc = result(await workspaceStatus({ cwd: root, env: "minimal", now: "2026-09-25T10:01:00.000Z" }));
    expectValid(doc);
    const [boxMember, notes] = doc.members;
    expect(notes.stewards).toEqual([]);
    expect(boxMember.stewardReasons).toEqual([]);
    expect(boxMember.stewards).toHaveLength(1);
    const s = boxMember.stewards[0];
    expect(s).toMatchObject({
      name: "box-steward",
      file: "ops/steward.op.ts",
      form: "local",
      forms: { default: "local", environments: { "fountain-k3d": "fountain" } },
      // #2726: the steward holds no credential; its capabilities join the box block.
      vault: null,
      capabilities: [
        { name: "fountain", broker: "lobby", declared: true },
        { name: "inference", broker: null, declared: false },
      ],
      lease: { holder: "box-host:1:abc", acquiredAt: "2026-09-25T10:00:00.000Z", live: true },
    });
    expect(s.ops).toEqual([
      {
        name: "box-converge",
        schedule: { cron: "* * * * *", overlap: "skip" },
        env: "local",
        lastRun: { id: expect.any(String), status: "ok", started: "2026-09-25T10:00:00.000Z", ended: "2026-09-25T10:00:05.000Z", gate: null, point: null },
        // #2778: not a ConvergeOp (no Converge label), so no tick.
        lastTick: null,
        changesCheckout: false,
        workLease: null,
      },
      { name: "box-release", schedule: null, env: "local", lastRun: null, lastTick: null, changesCheckout: false, workLease: null },
      {
        name: "box-dispatch",
        schedule: { cron: "*/5 * * * *", overlap: "skip" },
        env: "local",
        lastRun: null,
        lastTick: null,
        changesCheckout: true,
        workLease: {
          kind: null,
          held: [
            {
              item: "W-1",
              holder: "box-steward/box-dispatch@box-host:1:abc",
              token: turn.ok ? turn.lease.token : "",
              acquiredAt: "2026-09-25T10:00:30.000Z",
              expiresAt: "2026-09-25T10:10:30.000Z",
              state: "active",
            },
          ],
        },
      },
    ]);
    // #2749: nothing the steward runs waits on a decision point.
    expect(s.waiting).toEqual([]);

    const k3d = result(await workspaceStatus({ cwd: root, env: "fountain-k3d", now: "2026-09-25T11:00:00.000Z" }));
    expectValid(k3d);
    expect(k3d.members[0].stewards[0].form).toBe("fountain");
    expect(k3d.members[0].stewards[0].lease!.live).toBe(false);
  });

  test("an op file that can't be imported is a reason, and the read still succeeds", async () => {
    const root = stewarded();
    writeFileSync(join(root, "box", "ops", "broken.op.ts"), "export const x = ;\n");
    const doc = result(await workspaceStatus({ cwd: root, env: "minimal" }));
    expectValid(doc);
    expect(doc.members[0].stewards.map((s) => s.name)).toEqual(["box-steward"]);
    expect(doc.members[0].stewardReasons.map((r) => r.code)).toEqual(["stewards-unreadable"]);
  });
});

describe("chant workspace status on the chant repo (#2557)", () => {
  test("validates and lists every declared member", async () => {
    const doc = result(await workspaceStatus({ cwd: join(REPO, "packages", "core"), env: "prod", compareTo: "staging" }));
    expectValid(doc);
    expect(doc.workspace).toMatchObject({ name: "chant", root: ".", file: "chant.workspace.json" });
    const ls = listWorkspace({ cwd: REPO });
    if ("error" in ls) throw new Error(ls.error.message);
    expect(doc.members.map((m) => m.name)).toEqual(ls.members.map((m) => m.name));
  });
});
