/**
 * Records written before the release model read under it (#4034, phase 2 of
 * behold#678).
 *
 * `__fixtures__/older-records/older-records.json` holds ledger lines in the
 * shapes the producers wrote before #4020, #4043, #4045 and #4046 added their
 * fields: deploy records from `components release`, `run --components`,
 * `promote`, `rollback`, `redeploy`, SQL Yodeler and chud-studio's release Op;
 * run records; gate facts and resolutions; a release plan; and a change-set
 * document composed by the code of #4022. Each entry names the producer and
 * the source its shape was taken from.
 *
 * The lines are written byte for byte to the `chant/lifecycle` branch of a
 * temp repository, then read through the readers a tool uses: the release and
 * gate ledger parsers, `chant workspace status`, `chant release list`,
 * `joinRelease` and `chant change-set show`. For each field the newer model
 * adds, the test asserts that it reads as absent, never as a value chant
 * invented, and that no reader errors or skips a line. It also asserts that a
 * read leaves the branch where it was, since ledger lines are immutable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, git, repo, repoFixture } from "./__fixtures__/contract-repo";
import { changeSetDocumentDigest, composeChangeSet, verifyChangeSetDigest, type ChangeSetDocument } from "../change-set";
import { changeSetFile } from "../lifecycle/change-set-store";
import { parseGateLedger, type GateResolutionRecord, type PendingGateRecord } from "../lifecycle/gate-ledger";
import { joinRelease } from "../lifecycle/release-join";
import { readReleaseLedger, listReleaseEnvironments } from "../lifecycle/release-ledger";
import { parseReleaseLedger, readReleaseRecords } from "../lifecycle/release-read";
import { labelsByDigest, makeRelease, parseCuts, parseRelease, type Release } from "../lifecycle/release-store";
import { readReleasePlan } from "../lifecycle/plan-ledger";
import { readRunLedger } from "../lifecycle/run-ledger";
import { sortedJsonReplacer } from "../utils";
import { loadAjv2020 } from "./ajv2020";
import { changeSetShowDocument } from "./change-set-show";
import changeSetShowSchema from "./change-set-show.schema.json";
import { releasesDocument } from "./releases";
import releasesSchema from "./releases.schema.json";
import { formatStatus, workspaceStatus, type StatusDocument } from "./status";
import { gatesInLedger } from "./status-gates";
import statusSchema from "./status.schema.json";

afterAll(cleanScratch);

interface Entry {
  producer: string;
  source: string;
  line: Record<string, unknown>;
}
const data = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "older-records", "older-records.json"), "utf8")) as {
  files: Record<string, Entry[]>;
  plans: { digest: string; plan: Record<string, unknown> };
};
const changeSetText = readFileSync(join(import.meta.dirname, "__fixtures__", "older-records", "change-set-984534ea9.json"), "utf8");
const oldChangeSet = JSON.parse(changeSetText) as ChangeSetDocument;

/** A ledger file's text, one line per entry, written with sorted keys as chant writes them. */
const textOf = (path: string): string => data.files[path].map((e) => JSON.stringify(e.line, sortedJsonReplacer)).join("\n") + "\n";
const entriesOf = (path: string): Entry[] => data.files[path];

const releaseLedgers = ["staging", "prod", "fly"] as const;
const NOW = "2026-09-12T00:00:00.000Z";
const COMMIT = "2f22765d04931a078909145ca628d2264c852d7d";

/**
 * The release a later `chant release cut` made from the commit that three of
 * the older deploys were built from. The implicit release of #4046 names its
 * templates with a null component; the other target names one.
 */
const release: Release = makeRelease({
  member: null,
  commit: COMMIT,
  artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: "sha256:47e0cbb98c01f4a49e3450e8686ca069f23c3c13c2d49cf50a4c3513f01b6ed3" }],
  targets: [
    { env: "staging", templates: [{ component: null, path: "src/dist/ops/deploy/op.json", digest: `sha256:${"1".repeat(64)}` }], params: [] },
    { env: "prod", templates: [{ component: "api", path: "api/template.json", digest: `sha256:${"2".repeat(64)}` }], params: [] },
  ],
});
const cutLine = JSON.stringify({ version: 1, releaseDigest: release.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: "2026-10-16T09:00:00.000Z", runOrigin: null, signature: null }, sortedJsonReplacer);

const stem = (digest: string): string => digest.replace(/:/g, "_");

/** Write `files` as the whole tree of a `chant/lifecycle` commit without touching the working tree or index. */
function lifecycle(root: string, files: Record<string, string>): string {
  const index = join(root, ".git", "older-records-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const exec = (args: string[], input?: string): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf-8",
      input,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }).trim();
  for (const [path, text] of Object.entries(files)) {
    const blob = exec(["hash-object", "-w", "--stdin"], text);
    exec(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const tree = exec(["write-tree"]);
  const commit = exec(["commit-tree", tree, "-m", "ledger"]);
  git(root, "update-ref", "refs/heads/chant/lifecycle", commit);
  return commit;
}

/** The tree an older chant left on chant/lifecycle, plus one release cut afterwards. */
const tree = (): Record<string, string> => ({
  ...Object.fromEntries(Object.keys(data.files).map((path) => [path, textOf(path)])),
  [`_plans/${stem(data.plans.digest)}.json`]: JSON.stringify(data.plans.plan, sortedJsonReplacer) + "\n",
  [`_change-sets/${changeSetFile(oldChangeSet.digest)}`]: changeSetText,
  [`_releases/${stem(release.releaseDigest)}.json`]: JSON.stringify(release, sortedJsonReplacer) + "\n",
  "_releases/cuts.jsonl": cutLine + "\n",
});

const workspace = repoFixture(() => {
  const root = repo({
    "chant.workspace.json": declaration([
      { name: "site", dir: ".", kind: "other", because: "the root project" },
      { name: "web", dir: "apps/web", kind: "chant" },
    ]),
    "apps/web/chant.config.ts": "",
  }, true);
  lifecycle(root, tree());
  return root;
});

const tip = (root: string): string => git(root, "rev-parse", "chant/lifecycle");
const lifecycleFile = (root: string, path: string): string => git(root, "show", `chant/lifecycle:${path}`) + "\n";
const doc = (d: StatusDocument): Extract<StatusDocument, { members: unknown }> => {
  if ("error" in d) throw new Error(`${d.error.code}: ${d.error.message}`);
  return d;
};

/** The fields the newer model adds to a deploy record. */
const NEW_DEPLOY_FIELDS = ["releaseDigest", "admission"] as const;
/** The fields it adds to a gate fact or resolution. `empty` and `releaseDigest` are #4045's; `gitSha` and `runId` are #4020's. */
const NEW_GATE_FIELDS = ["gitSha", "runId", "releaseDigest", "empty", "seal", "carriedFrom", "checkpointDigest"] as const;
/** The fields it adds to a run record (#4020). */
const NEW_RUN_FIELDS = ["gitSha", "runOrigin"] as const;

describe("deploy records from every producer", () => {
  test("parse with no line skipped, byte for byte as written, and carry no field the release model adds", () => {
    for (const path of ["staging/releases.jsonl", "prod/releases.jsonl", "fly/releases.jsonl"]) {
      const { records, malformed } = parseReleaseLedger(textOf(path).split("\n").filter(Boolean));
      expect(malformed, path).toBe(0);
      expect(records, path).toEqual(entriesOf(path).map((e) => e.line));
      for (const record of records) {
        for (const field of NEW_DEPLOY_FIELDS) expect(Object.keys(record), `${path} ${record.component}`).not.toContain(field);
        expect(Object.keys(record)).not.toContain("flags");
      }
    }
  });

  test("a record names the producers the fixture claims, so each producer named in #4034 is covered", () => {
    const producers = [...releaseLedgers.flatMap((e) => entriesOf(`${e}/releases.jsonl`))].map((e) => e.producer).join("\n");
    for (const name of ["components release", "run --components", "components promote", "components rollback", "components redeploy", "SQL Yodeler", "chud-studio"]) {
      expect(producers, name).toContain(name);
    }
  });

  test("read from the branch, the older fields still read as they were written", async () => {
    const root = workspace();
    const before = tip(root);
    expect(await listReleaseEnvironments({ cwd: root })).toEqual(["fly", "prod", "staging"]);
    const prod = await readReleaseLedger("prod", { cwd: root });
    expect(prod.malformed).toBe(0);
    const [first, promote, rollback, redeploy] = prod.records;
    expect(first.runOrigin).toEqual({ forge: "github", repo: "acme/shop", url: "https://github.com/acme/shop/actions/runs/8399000111" });
    expect(promote.promotedFrom).toEqual({ env: "staging", runId: "8431209934", timestamp: "2026-09-08T14:02:11.482Z" });
    expect(rollback.restores?.runId).toBe("8399000111");
    expect(redeploy.redeploys?.runId).toBe("local-1789074000000");
    const staging = await readReleaseLedger("staging", { cwd: root });
    expect(staging.records.find((r) => r.component === "ingress")?.inputDigest).toBe("sha256:bc227a21bd89c5c2e7e971e001e538da4dff21e972059a914b38595400418ca1");
    expect(tip(root)).toBe(before);
  });

  test("a port that reads the file text (a bundle without git) gives the same records", async () => {
    const port = { read: async (env: string, file: string) => (env === "staging" && file === "releases.jsonl" ? textOf("staging/releases.jsonl") : null), list: async () => [], trees: async () => ["staging"] };
    const { records, malformed } = await readReleaseRecords(port, "staging");
    expect(malformed).toBe(0);
    expect(records.map((r) => r.component)).toEqual(["api", "worker", "ingress", "schema"]);
  });
});

describe("gate facts and resolutions", () => {
  test("parse with no line skipped, and none carries a field the newer model adds", () => {
    for (const path of ["_gates/api.jsonl", "_gates/release.jsonl", "_gates/web.jsonl", "_gates/nightly.jsonl"]) {
      const read = parseGateLedger(textOf(path));
      expect(read.malformed, path).toBe(0);
      expect(read.pending.length + read.resolutions.length, path).toBe(entriesOf(path).length);
      for (const record of [...read.pending, ...read.resolutions]) {
        for (const field of NEW_GATE_FIELDS) expect(Object.keys(record), `${path} ${field}`).not.toContain(field);
      }
    }
  });

  test("a resolution with no kind reads as a resolution, and one with no plan stays plan-less", () => {
    const nightly = parseGateLedger(textOf("_gates/nightly.jsonl"));
    expect(nightly.resolutions).toHaveLength(1);
    expect(nightly.resolutions[0].kind).toBeUndefined();
    expect(nightly.resolutions[0].planDigest).toBeUndefined();
    expect(nightly.pending[0].planDigest).toBeUndefined();
  });

  test("an approval of a component gate before #4045 still counts for that gate, and does not count for a release gate", () => {
    const api = textOf("_gates/api.jsonl");
    const old = gatesInLedger("api", api, ["prod"], NOW);
    expect(old.gates.map((g) => [g.name, g.env, g.state])).toEqual([["deploy", "prod", "approved"]]);

    // A release gate's fact names the release; the older approval names none, so it is not an approval of this release.
    const releaseFact: PendingGateRecord = { version: 1, kind: "pending", op: "release", gate: "ship", planDigest: "sha256:aa", releaseDigest: release.releaseDigest, environment: "prod", timestamp: "2026-10-16T10:00:00.000Z", expiresAt: "2026-10-23T10:00:00.000Z" };
    const olderApproval: GateResolutionRecord = { version: 1, op: "release", gate: "ship", resolvedBy: "alex", timestamp: "2026-10-16T11:00:00.000Z", planDigest: "sha256:aa", environment: "prod" };
    const content = [releaseFact, olderApproval].map((l) => JSON.stringify(l)).join("\n");
    const gates = gatesInLedger("release", content, ["prod"], "2026-10-16T12:00:00.000Z").gates;
    expect(gates).toHaveLength(1);
    expect(gates[0].state).not.toBe("approved");
    expect(gates[0].approvals).toEqual([]);
    expect(gates[0].releaseDigest).toBe(release.releaseDigest);
  });
});

describe("run records and release plans", () => {
  test("a run record reads with no gitSha and no runOrigin", async () => {
    const root = workspace();
    const { records, malformed } = await readRunLedger("fly", "release", { cwd: root });
    expect(malformed).toBe(0);
    expect(records.map((r) => r.status)).toEqual(["gated", "ok"]);
    for (const record of records) for (const field of NEW_RUN_FIELDS) expect(Object.keys(record)).not.toContain(field);
  });

  test("the plan chud-studio wrote reads by the digest its deploy record names", async () => {
    const root = workspace();
    const plan = await readReleasePlan(data.plans.digest, { cwd: root });
    expect(plan).toEqual(data.plans.plan);
  });
});

describe("chant workspace status over the older ledgers", () => {
  const { expectValid } = contract(statusSchema);

  test("every deploy item reads releaseDigest, releaseLabel and admission as null, with the older fields as written", async () => {
    const root = workspace();
    const before = tip(root);
    const status = doc(await workspaceStatus({ cwd: root, env: "prod", compareTo: "staging", now: NOW }));
    expectValid(status);
    const site = status.members.find((m) => m.name === "site")!;
    const releases = site.environments.flatMap((e) => e.releases);
    expect(releases.map((r) => `${r.component}`)).toEqual(["api", "schema/acme", "api", "ingress", "schema", "worker"]);
    for (const r of releases) {
      expect(r.releaseDigest, r.component).toBeNull();
      expect(r.releaseLabel, r.component).toBeNull();
      expect(r.admission, r.component).toBeNull();
    }
    const prodApi = site.environments.find((e) => e.env === "prod")!.releases.find((r) => r.component === "api")!;
    expect(prodApi.approver).toBeNull();
    expect(prodApi.digest).toBe("sha256:db88ccee4ed09c4324d896b8a0db6dab0091c76f579eab51e54656c40517866f");
    const worker = site.environments.find((e) => e.env === "staging")!.releases.find((r) => r.component === "worker")!;
    expect(worker.approver).toBe("bob");
    expect(tip(root)).toBe(before);
  });

  test("the release cut afterwards runs in no environment, because no older deploy names it", async () => {
    const root = workspace();
    const status = doc(await workspaceStatus({ cwd: root, env: "staging", now: NOW }));
    expectValid(status);
    const site = status.members.find((m) => m.name === "site")!;
    expect(site.releaseCuts).toHaveLength(1);
    expect(site.releaseCuts![0]).toMatchObject({ label: "v1.0.0", signature: null, commit: COMMIT });
    expect(site.releaseCuts![0].signatureCheck.status).toBe("unsigned");
    // The staging api deploy was built from the release's commit, and says nothing of the release.
    expect(site.environments[0].releases.find((r) => r.component === "api")).toMatchObject({ gitSha: COMMIT, releaseDigest: null, releaseLabel: null });
  });

  test("older gates list with their state, and none shows gitSha, runId or releaseDigest", async () => {
    const root = workspace();
    const site = doc(await workspaceStatus({ cwd: root, env: "prod", compareTo: "staging", now: NOW })).members.find((m) => m.name === "site")!;
    expect(site.gateLedger.malformed).toBe(0);
    const byName = Object.fromEntries(site.gates.map((g) => [`${g.component}/${g.name}`, g]));
    expect(Object.keys(byName).sort()).toEqual(["api/deploy", "nightly/confirm", "release/ship", "web/pr-apply"]);
    expect(byName["api/deploy"]).toMatchObject({ env: "prod", state: "approved" });
    expect(byName["release/ship"]).toMatchObject({ env: null, state: "approved" });
    expect(byName["nightly/confirm"]).toMatchObject({ planDigest: null, state: "approved" });
    expect(byName["web/pr-apply"].state).toBe("pending");
    for (const gate of site.gates) {
      for (const field of ["gitSha", "runId", "releaseDigest"]) expect(Object.keys(gate), `${gate.component} ${field}`).not.toContain(field);
    }
  });

  test("a gate gets changeSet only where a document is stored under its plan digest", async () => {
    const root = workspace();
    const site = doc(await workspaceStatus({ cwd: root, env: "prod", compareTo: "staging", now: NOW })).members.find((m) => m.name === "site")!;
    const byName = Object.fromEntries(site.gates.map((g) => [`${g.component}/${g.name}`, g]));
    expect(byName["web/pr-apply"].changeSet).toBe(oldChangeSet.digest);
    for (const name of ["api/deploy", "release/ship", "nightly/confirm"]) expect(Object.keys(byName[name]), name).not.toContain("changeSet");
  });

  test("the fly environment lists chud-studio's release with its plan, and no release label", async () => {
    const root = workspace();
    const status = doc(await workspaceStatus({ cwd: root, env: "fly", now: NOW }));
    expectValid(status);
    const fly = status.members.find((m) => m.name === "site")!.environments[0].releases;
    expect(fly).toHaveLength(1);
    expect(fly[0]).toMatchObject({ component: "app", approver: "alex", releaseDigest: null, releaseLabel: null, admission: null });
    expect(fly[0].plan).toEqual(data.plans.plan);
  });

  test("the table prints without error and says nothing of the newer fields", async () => {
    const root = workspace();
    const out = formatStatus(doc(await workspaceStatus({ cwd: root, env: "prod", compareTo: "staging", now: NOW })));
    expect(out).toContain("api");
    expect(out).not.toContain("undefined");
  });
});

describe("chant release list, joinRelease and chant change-set show over the older records", () => {
  test("release list shows the release with no environment running it", async () => {
    const root = workspace();
    const before = tip(root);
    const list = await releasesDocument({ cwd: root });
    contract(releasesSchema).expectValid(list);
    if ("error" in list) throw new Error(list.error.message);
    expect(list.reason).toBeNull();
    expect(list.releases).toHaveLength(1);
    expect(list.releases[0]).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1.0.0", commit: COMMIT, environments: [] });
    expect(list.releases[0].cuts[0].signatureCheck.status).toBe("unsigned");
    // The prod target names its component; the staging target is the implicit release of #4046, whose template has none.
    expect(list.releases[0].targets.map((t) => t.templates[0].component)).toEqual(["api", null]);
    expect(tip(root)).toBe(before);
  });

  test("joining from the commit finds the release and no deploy, gate or approval", async () => {
    const root = workspace();
    const joined = await joinRelease({ commit: COMMIT }, { cwd: root });
    expect(joined.releases).toHaveLength(1);
    expect(joined.releases[0]).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1.0.0", commit: COMMIT, deploys: [], gates: { pending: [], resolutions: [] } });
  });

  test("joining from an older deploy record, with or without an admission, says it names no release", async () => {
    const root = workspace();
    const { records } = await readReleaseLedger("staging", { cwd: root });
    for (const deploy of records) {
      const joined = await joinRelease({ deploy }, { cwd: root });
      expect(joined.releases, deploy.component).toEqual([]);
      expect(joined.reason, deploy.component).toMatch(/names no release/);
    }
  });

  test("joining from an older gate fact or resolution says it binds no release", async () => {
    const root = workspace();
    const { pending, resolutions } = parseGateLedger(lifecycleFile(root, "_gates/release.jsonl"));
    for (const gate of [pending[0], resolutions[0]]) {
      const joined = await joinRelease({ gate }, { cwd: root });
      expect(joined.releases).toEqual([]);
      expect(joined.reason).toMatch(/binds no release/);
    }
  });

  test("change-set show reads a document composed before #4045, which has no releaseDigest and no environment", async () => {
    const root = workspace();
    const shown = await changeSetShowDocument({ cwd: root, digest: oldChangeSet.digest });
    const Ajv = loadAjv2020();
    const validate = new Ajv({ strict: false, allErrors: true }).compile(changeSetShowSchema) as ((d: unknown) => boolean) & { errors?: unknown };
    expect(validate(shown), JSON.stringify(validate.errors)).toBe(true);
    if ("error" in shown) throw new Error(shown.error.message);
    expect(shown.reason).toBeNull();
    expect(shown.changeSet).toEqual(oldChangeSet);
    expect(Object.keys(shown.changeSet!)).not.toContain("releaseDigest");
    expect(Object.keys(shown.changeSet!)).not.toContain("environment");
  });

  test("the older document still hashes to its digest, and composing the same parts today gives the same digest", () => {
    expect(verifyChangeSetDigest(oldChangeSet)).toBe(true);
    expect(changeSetDocumentDigest(oldChangeSet)).toBe(oldChangeSet.digest);
    const again = composeChangeSet([]);
    expect(Object.keys(again)).not.toContain("releaseDigest");
    expect(Object.keys(again)).not.toContain("environment");
  });
});

describe("cut lines and release files before the fields", () => {
  test("a cut line with no signature key reads with signature null, and a cut with no label reads as unlabelled", () => {
    const text = [
      JSON.stringify({ version: 1, releaseDigest: release.releaseDigest, label: "v0.9.0", actor: "alice", timestamp: "2026-10-15T09:00:00.000Z", runOrigin: null }),
      JSON.stringify({ version: 1, releaseDigest: `sha256:${"9".repeat(64)}`, label: null, actor: "bob", timestamp: "2026-10-15T10:00:00.000Z", runOrigin: { forge: "local" } }),
    ].join("\n");
    const { cuts, malformed } = parseCuts(text);
    expect(malformed).toBe(0);
    expect(cuts.map((c) => c.signature)).toEqual([null, null]);
    expect(labelsByDigest(cuts).get(release.releaseDigest)).toBe("v0.9.0");
    expect(labelsByDigest(cuts).has(`sha256:${"9".repeat(64)}`)).toBe(false);
  });

  test("a release file reads whether its templates name a component or none", () => {
    const parsed = parseRelease(JSON.stringify(release));
    expect(parsed?.targets.map((t) => t.templates[0].component)).toEqual(["api", null]);
  });
});

test("the fixture covers each of the ledgers the issue names", () => {
  expect(Object.keys(data.files).sort()).toEqual([
    "_gates/api.jsonl",
    "_gates/nightly.jsonl",
    "_gates/release.jsonl",
    "_gates/web.jsonl",
    "fly/releases.jsonl",
    "fly/runs__release.jsonl",
    "prod/releases.jsonl",
    "staging/releases.jsonl",
  ]);
});
