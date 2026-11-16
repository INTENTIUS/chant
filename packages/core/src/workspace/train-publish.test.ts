/**
 * #5136: a release train of a nested workspace's members publishes as one
 * set. Every member stages before any reveals, layers reveal core first and
 * wait for core's `latest` before the next, a failure resumes across members
 * from each member's publish record, a pinned release that is not published
 * is refused before anything stages, and the train itself lives inside the
 * outer member's ledger. npm is the fake from ../lifecycle/__fixtures__.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease } from "../lifecycle/release-cut";
import type { ReleaseArtifact } from "../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { readFakeNpmRegistry, seedFakeNpmRegistry, writeFakeNpm, writeOciLayout } from "../lifecycle/__fixtures__/publish-fakes";
import type { PublishFetch } from "../lifecycle/release-publish";
import { TestRepo } from "./trust/test-repo";
import { appendReleaseTrain, readMemberReleases, pickTrain, trainDigest, type ReleaseTrainRecord } from "./release-train";
import { publishTrain, trainDependencies, trainLayers, TrainPublishRunError } from "./train-publish";
import { workspaceLedgerPrefix } from "./workspace-ledger";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["packages"], buildSteps: {}, buildInputs: {}, componentFiles: { packages: "packages.component.ts" }, templates: [] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const pkg = (name: string, version: string, peer?: Record<string, string>) => JSON.stringify({ name, version, ...(peer ? { peerDependencies: peer } : {}) }, null, 2);
const member = (pkgDir: string, stage: boolean, verify?: string[]) =>
  `export default { environments: ["npm"], release: { publish: [{ type: "npm", stage: ${stage}, packages: ["../../${pkgDir}"] }]${verify ? `, verify: ${JSON.stringify(verify)}` : ""} } };\n`;

/** An outer workspace whose member `npm` is a nested workspace of two release members, core and lex; lex peers on core. */
function setup(opts: { stage?: boolean; extra?: string[]; verify?: Record<string, string[]> } = {}) {
  const r = new TestRepo("train-publish");
  repos.push(r);
  const stage = opts.stage ?? true;
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "npm", dir: "release", kind: "workspace", because: "the packages' releases" }] }, null, 2));
  const names = ["core", "lex", ...(opts.extra ?? [])];
  r.write("release/chant.workspace.json", JSON.stringify({ name: "npm", schema: 1, members: names.map((n) => ({ name: n, dir: n, kind: "chant" })) }, null, 2));
  for (const n of names) {
    r.write(`release/${n}/chant.config.ts`, member(`pkgs/${n}`, stage, opts.verify?.[n]));
    r.write(`release/${n}/packages.component.ts`, "export const packages = {};\n");
  }
  r.write("pkgs/core/package.json", pkg("@acme/core", "2.0.0"));
  r.write("pkgs/lex/package.json", pkg("@acme/lex", "2.0.0", { "@acme/core": "^2.0.0" }));
  for (const n of opts.extra ?? []) r.write(`pkgs/${n}/package.json`, pkg(`@acme/${n}`, "2.0.0"));
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const log = join(dirname(r.dir), "npm.log");
  seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } }, "@acme/lex": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
  const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
  return { r, log, npm, nested: join(r.dir, "release") };
}

const cut = (r: TestRepo, m: string, label: string) => cutRelease({ cwd: join(r.dir, "release", m), compiler, label, actor: "alice", env: {}, npmPublished: () => true, now: () => new Date("2026-11-15T10:00:00.000Z") });

async function recordTrain(nested: string, pins: Record<string, string> = {}): Promise<ReleaseTrainRecord> {
  const picked = pickTrain(await readMemberReleases(nested), new Map(Object.entries(pins)));
  if ("problems" in picked) throw new Error(picked.problems.join("; "));
  const record: ReleaseTrainRecord = { version: 1, id: "train-1", env: "npm", timestamp: "2026-11-15T10:01:00.000Z", actor: "alice", members: picked.members, trainDigest: trainDigest(picked.members) };
  await appendReleaseTrain(nested, record);
  return record;
}

const npmCalls = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { args: string[] }).args) : []);
const latest = (log: string) => Object.fromEntries(Object.entries(readFakeNpmRegistry(log).packages).map(([n, p]) => [n, p.distTags.latest]));
const ENV = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, ...extra });

describe("layers", () => {
  test("a member comes after the members whose names it needs; a layer is in name order; a cycle shares a layer", () => {
    expect(trainLayers([
      { member: "lex", provides: ["@a/lex"], needs: ["@a/core"] },
      { member: "core", provides: ["@a/core"], needs: [] },
      { member: "helm", provides: ["@a/helm"], needs: ["@a/lex", "left-pad"] },
      { member: "client", provides: ["@a/client"], needs: [] },
    ])).toEqual([["client", "core"], ["lex"], ["helm"]]);
    expect(trainLayers([
      { member: "a", provides: ["a"], needs: ["b"] },
      { member: "b", provides: ["b"], needs: ["a"] },
    ])).toEqual([["a", "b"]]);
  });
});

type Fixture = ReturnType<typeof setup>;

/** A fixture whose repository, cuts and train are made once, in beforeAll, which the unit-test budget does not count. */
function fixture(make: () => Promise<Fixture>): () => Fixture {
  let f: Fixture | undefined;
  beforeAll(async () => {
    f = await make();
  }, 120_000);
  return () => f!;
}

const NO_WAIT = async () => undefined;

describe("a nested workspace's train ledger", () => {
  const f = fixture(async () => {
    const x = setup();
    x.r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "npm", dir: "release", kind: "workspace", because: "x" }, { name: "oci", dir: "images", kind: "workspace", because: "y" }] }, null, 2));
    x.r.write("images/chant.workspace.json", JSON.stringify({ name: "oci", schema: 1, members: [] }, null, 2));
    x.r.git(["tag", `ci/green/${x.r.commit("a second nested workspace")}`]);
    await cut(x.r, "core", "2.0.0");
    await cut(x.r, "lex", "2.0.0");
    await recordTrain(x.nested);
    return x;
  });

  test("sits inside the outer member's ledger, apart from the outer workspace's and another nested one's", async () => {
    const { r, nested } = f();
    expect(await workspaceLedgerPrefix(r.dir)).toBe("_members/_workspace/");
    expect(await workspaceLedgerPrefix(nested)).toBe("_members/npm/_members/_workspace/");
    expect(await workspaceLedgerPrefix(join(nested, "core"))).toBe("_members/npm/_members/_workspace/");
    expect(await workspaceLedgerPrefix(join(r.dir, "images"))).toBe("_members/oci/_members/_workspace/");
    expect(r.git(["show", "chant/lifecycle:_members/npm/_members/_workspace/npm/trains.jsonl"])).toContain("train-1");
    expect(() => r.git(["show", "chant/lifecycle:_members/_workspace/npm/trains.jsonl"])).toThrow();
  });

  test("pins each member's release, read from its nested ledger", async () => {
    const { r, nested } = f();
    expect(r.git(["ls-tree", "-r", "--name-only", "chant/lifecycle"]).split("\n").filter((p) => p.endsWith("cuts.jsonl"))).toEqual([
      "_members/npm/_members/core/_releases/cuts.jsonl",
      "_members/npm/_members/lex/_releases/cuts.jsonl",
    ]);
    const picked = pickTrain(await readMemberReleases(nested));
    expect("members" in picked && picked.members.map((m) => [m.member, m.label])).toEqual([["core", "2.0.0"], ["lex", "2.0.0"]]);
  });
});

describe("a staged train publish", () => {
  const f = fixture(async () => {
    const x = setup();
    await cut(x.r, "core", "2.0.0");
    await cut(x.r, "lex", "2.0.0");
    await recordTrain(x.nested);
    return x;
  });
  const lines: string[] = [];
  const run = (extra: Record<string, string> = {}) =>
    publishTrain({ cwd: f().nested, env: "npm", yes: true, processEnv: ENV(extra), deps: { npm: f().npm, sleep: NO_WAIT }, say: (l) => lines.push(l), log: (l) => lines.push(l) });

  test("is planned in layers, core first, and the plan sends nothing", async () => {
    const { log, npm, nested } = f();
    const planned = await publishTrain({ cwd: nested, env: "npm", processEnv: ENV(), deps: { npm } });
    expect(planned).toMatchObject({ kind: "planned", members: [{ member: "core", layer: 0, role: "publish" }, { member: "lex", layer: 1, role: "publish" }] });
    expect(npmCalls(log).filter((a) => a[0] === "publish")).toEqual([]);
  });

  test("a failure while staging lex, after core staged, moves no latest", async () => {
    const { log } = f();
    const first = await run({ FAKE_NPM_FAIL: "pkgs/lex" }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(TrainPublishRunError);
    expect(first).toMatchObject({ code: "publish-npm-failed", member: "lex", step: "stage", staged: ["core: npm (1 package)"], revealed: [] });
    expect(latest(log)).toEqual({ "@acme/core": "1.0.0", "@acme/lex": "1.0.0" });
    expect(readFakeNpmRegistry(log).packages["@acme/core"]!.distTags.next).toBe("2.0.0");
  });

  test("a re-run stages only lex, then moves core's latest and waits to see it before lex's moves", async () => {
    const { r, log } = f();
    const before = npmCalls(log).length;
    const done = await run({ FAKE_NPM_TAG_LAG: "@acme/core=2" });
    expect(done.kind).toBe("published");
    const calls = npmCalls(log).slice(before).filter((a) => a[0] !== "view" || a[2]?.startsWith("dist-tags."));
    expect(calls).toEqual([
      ["publish", join(r.dir, "pkgs", "lex"), "--tag", "next"],
      ["dist-tag", "add", "@acme/core@2.0.0", "latest"],
      ["view", "@acme/core", "dist-tags.latest"],
      ["view", "@acme/core", "dist-tags.latest"],
      ["view", "@acme/core", "dist-tags.latest"],
      ["dist-tag", "add", "@acme/lex@2.0.0", "latest"],
    ]);
    expect(latest(log)).toEqual({ "@acme/core": "2.0.0", "@acme/lex": "2.0.0" });
    expect(lines).toContain("  core: npm (1 package): staged by an earlier run; not staged again");
    // Each member's own record holds its steps, where chant release publish in the member reads them.
    const rec = (m: string) => r.git(["show", `chant/lifecycle:_members/npm/_members/${m}/_releases/publishes.jsonl`]).trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    expect(rec("core")).toEqual(["staged", "revealed"]);
    expect(rec("lex")).toEqual(["staged", "revealed"]);
  });

  test("run once more, publishes and tags nothing again", async () => {
    const { log } = f();
    const third = npmCalls(log).length;
    const again = await run();
    expect(again).toMatchObject({ kind: "published", resumed: [{ member: "core", step: "revealed" }, { member: "lex", step: "revealed" }] });
    expect(npmCalls(log).slice(third).filter((a) => a[0] === "publish" || a[0] === "dist-tag")).toEqual([]);
  });
});

describe("a train publish with release.verify (#5157)", () => {
  const f = fixture(async () => {
    const x = setup({ verify: { lex: ["lex-check"] } });
    await cut(x.r, "core", "2.0.0");
    await cut(x.r, "lex", "2.0.0");
    await recordTrain(x.nested);
    return x;
  });
  const seen: Array<{ command: string; cwd: string; npm: string | undefined }> = [];
  let exit = 1;
  const runVerify = (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    seen.push({ command, cwd: o.cwd, npm: o.env.CHANT_STAGED_NPM });
    return exit;
  };
  const run = () => publishTrain({ cwd: f().nested, env: "npm", yes: true, processEnv: ENV(), deps: { npm: f().npm, sleep: NO_WAIT }, runVerify });

  test("the plan names the member's verify commands", async () => {
    const planned = await publishTrain({ cwd: f().nested, env: "npm", processEnv: ENV(), deps: { npm: f().npm } });
    expect(planned).toMatchObject({ kind: "planned", verify: [{ member: "lex", steps: [{ name: "lex-check", run: "lex-check" }] }] });
  });

  test("runs after the whole train has staged, with every member's staged packages; a failure moves no latest and is in the member's record", async () => {
    const { r, log } = f();
    const failed = await run().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TrainPublishRunError);
    expect(failed).toMatchObject({ code: "publish-verify-failed", member: "lex", step: "verify", staged: ["core: npm (1 package)", "lex: npm (1 package)"], revealed: [] });
    expect(seen).toEqual([{ command: "lex-check", cwd: join(r.dir, "release", "lex"), npm: "@acme/core@2.0.0 @acme/lex@2.0.0" }]);
    expect(latest(log)).toEqual({ "@acme/core": "1.0.0", "@acme/lex": "1.0.0" });
    const rec = (m: string) => r.git(["show", `chant/lifecycle:_members/npm/_members/${m}/_releases/publishes.jsonl`]).trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    expect(rec("lex")).toEqual(["staged", "verify-failed"]);
  });

  test("run again, stages nothing again, verifies again, then reveals", async () => {
    const { log } = f();
    exit = 0;
    const before = npmCalls(log).length;
    const done = await run();
    expect(done).toMatchObject({ kind: "published", verified: "passed" });
    expect(seen).toHaveLength(2);
    expect(npmCalls(log).slice(before).filter((a) => a[0] === "publish")).toEqual([]);
    expect(latest(log)).toEqual({ "@acme/core": "2.0.0", "@acme/lex": "2.0.0" });
  });
});

describe("a train publish with stage: false", () => {
  const f = fixture(async () => {
    const x = setup({ stage: false });
    await cut(x.r, "core", "2.0.0");
    await cut(x.r, "lex", "2.0.0");
    await recordTrain(x.nested);
    return x;
  });

  test("publishes each layer in its turn, after the layer before resolves", async () => {
    const { r, log, npm, nested } = f();
    const done = await publishTrain({ cwd: nested, env: "npm", yes: true, processEnv: ENV({ FAKE_NPM_TAG_LAG: "@acme/core=1" }), deps: { npm, sleep: NO_WAIT } });
    expect(done.kind).toBe("published");
    expect(npmCalls(log).filter((a) => a[0] === "publish" || a[2]?.startsWith("dist-tags."))).toEqual([
      ["publish", join(r.dir, "pkgs", "core"), "--tag", "latest"],
      ["view", "@acme/core", "dist-tags.latest"],
      ["view", "@acme/core", "dist-tags.latest"],
      ["publish", join(r.dir, "pkgs", "lex"), "--tag", "latest"],
    ]);
  });
});

describe("a train that pins a member at an earlier release", () => {
  const f = fixture(async () => {
    const x = setup({ extra: ["old"] });
    await cut(x.r, "old", "1.5.0");
    x.r.write("pkgs/core/CHANGES.md", "a change\n");
    x.r.git(["tag", `ci/green/${x.r.commit("a change to core")}`]);
    await cut(x.r, "core", "2.0.0");
    await cut(x.r, "lex", "2.0.0");
    await recordTrain(x.nested);
    return x;
  });

  test("is refused before anything stages while the registry does not hold that release", async () => {
    const { log, npm, nested } = f();
    const refused = await publishTrain({ cwd: nested, env: "npm", yes: true, processEnv: ENV(), deps: { npm } });
    expect(refused).toMatchObject({ kind: "refused", code: "train-member-unpublished" });
    expect(refused.kind === "refused" && refused.message).toContain("old 1.5.0 was cut from commit");
    expect(npmCalls(log).filter((a) => a[0] === "publish" || a[0] === "dist-tag")).toEqual([]);
  });

  test("once the registry holds it, publishes the members cut here and leaves it alone", async () => {
    const { log, npm, nested } = f();
    seedFakeNpmRegistry(log, { packages: { ...readFakeNpmRegistry(log).packages, "@acme/old": { versions: ["1.5.0"], distTags: { latest: "1.5.0" } } } });
    const done = await publishTrain({ cwd: nested, env: "npm", yes: true, processEnv: ENV(), deps: { npm, sleep: NO_WAIT } });
    expect(done).toMatchObject({ kind: "published", members: [{ member: "old", role: "pinned" }, { member: "core", role: "publish" }, { member: "lex", role: "publish" }] });
    expect(latest(log)).toEqual({ "@acme/core": "2.0.0", "@acme/lex": "2.0.0", "@acme/old": "1.5.0" });
  });
});

/**
 * #5165: a train of mixed kinds: npm core and lex (lex peers on core), an
 * image member that names core in release.dependsOn, and an MCP Registry
 * entry whose server.json lists lex. The registry is a fake fetch.
 */
function mixedSetup(opts: { dependsOn?: string[] } = {}) {
  const r = new TestRepo("train-publish-mixed");
  repos.push(r);
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "rel", dir: "release", kind: "workspace", because: "the releases" }] }, null, 2));
  const names = ["core", "lex", "image", "server"];
  r.write("release/chant.workspace.json", JSON.stringify({ name: "rel", schema: 1, members: names.map((n) => ({ name: n, dir: n, kind: "chant" })) }, null, 2));
  for (const n of names) r.write(`release/${n}/packages.component.ts`, "export const packages = {};\n");
  r.write("release/core/chant.config.ts", member("pkgs/core", true));
  r.write("release/lex/chant.config.ts", member("pkgs/lex", true));
  const dependsOn = JSON.stringify(opts.dependsOn ?? ["core"]);
  r.write("release/image/chant.config.ts", `export default { environments: ["npm"], release: { dependsOn: ${dependsOn}, publish: [{ type: "oci", image: "img", repository: "127.0.0.1:5999/acme/img" }] } };\n`);
  r.write("release/server/chant.config.ts", `export default { environments: ["npm"], release: { publish: [{ type: "mcp-registry", registry: "https://mcp.test" }] } };\n`);
  r.write("release/server/server.json", JSON.stringify({ name: "io.github.acme/lex", version: "2.0.0", packages: [{ registryType: "npm", identifier: "@acme/lex", version: "2.0.0" }] }));
  r.write("pkgs/core/package.json", pkg("@acme/core", "2.0.0"));
  r.write("pkgs/lex/package.json", pkg("@acme/lex", "2.0.0", { "@acme/core": "^2.0.0" }));
  writeOciLayout(join(r.dir, "release", "image", "img"));
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const log = join(dirname(r.dir), "npm.log");
  seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } }, "@acme/lex": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
  const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
  return { r, log, npm, nested: join(r.dir, "release") };
}

/** The MCP Registry and GitHub's OIDC token service, in one fake fetch. `refuse` makes the publish fail. */
function fakeMcp() {
  const held = new Set<string>();
  const state = { refuse: true, publishes: 0 };
  const fetch: PublishFetch = async (url, init) => {
    const u = new URL(url);
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json) });
    if (u.hostname === "token.test") return answer(200, { value: "jwt" });
    if (u.pathname === "/v0.1/auth/github-oidc") return answer(200, { registry_token: "reg" });
    if (u.pathname === "/v0.1/publish") {
      state.publishes++;
      if (state.refuse) return answer(503, { detail: "unavailable" });
      const b = JSON.parse(String(init.body)) as { name: string; version: string };
      held.add(`${b.name}@${b.version}`);
      return answer(200, {});
    }
    const m = /^\/v0\.1\/servers\/(.+)\/versions\/([^/]+)$/.exec(u.pathname);
    if (m && held.has(`${decodeURIComponent(m[1]!)}@${decodeURIComponent(m[2]!)}`)) return answer(200, { server: { packages: [{ registryType: "npm", identifier: "@acme/lex", version: "2.0.0" }] } });
    return answer(404, {});
  };
  return { fetch, held, state };
}

const MCP_ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test/t", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" };

describe("a train of mixed target kinds (#5165)", () => {
  const f = fixture(async () => {
    const x = mixedSetup();
    for (const m of ["core", "lex", "image", "server"]) await cut(x.r, m, "2.0.0");
    await recordTrain(x.nested);
    return x;
  });

  test("layers members across kinds: an image after the member its dependsOn names, an MCP entry after the package its server.json lists", async () => {
    const { npm, nested } = f();
    const planned = await publishTrain({ cwd: nested, env: "npm", processEnv: ENV(MCP_ENV), deps: { npm } });
    expect(planned).toMatchObject({
      kind: "planned",
      members: [
        { member: "core", layer: 0 },
        { member: "image", layer: 1, after: ["core"] },
        { member: "lex", layer: 1, after: ["core"] },
        { member: "server", layer: 2, after: ["lex"] },
      ],
    });
  });

});

describe("release.dependsOn on a member the declaration does not list (#5165)", () => {
  const f = fixture(async () => {
    const x = mixedSetup({ dependsOn: ["nope"] });
    for (const m of ["core", "lex", "image", "server"]) await cut(x.r, m, "2.0.0");
    await recordTrain(x.nested);
    return x;
  });

  test("is refused before anything stages", async () => {
    const refused = await publishTrain({ cwd: f().nested, env: "npm", processEnv: ENV(MCP_ENV), deps: { npm: f().npm } });
    expect(refused).toMatchObject({ kind: "refused", code: "train-depends-on-unknown" });
    expect(refused.kind === "refused" && refused.message).toContain("image: release.dependsOn names nope");
  });
});

describe("a mixed train resumes across layers (#5165)", () => {
  const f = fixture(async () => {
    const x = mixedSetup({ dependsOn: [] });
    // Without the image: the OCI target is covered by its own tests, and this train publishes npm then the MCP Registry.
    x.r.write("release/chant.workspace.json", JSON.stringify({ name: "rel", schema: 1, members: ["core", "lex", "server"].map((n) => ({ name: n, dir: n, kind: "chant" })) }, null, 2));
    x.r.git(["tag", `ci/green/${x.r.commit("three members")}`]);
    for (const m of ["core", "lex", "server"]) await cut(x.r, m, "2.0.0");
    await recordTrain(x.nested);
    return x;
  });
  const mcp = fakeMcp();
  const run = () => publishTrain({ cwd: f().nested, env: "npm", yes: true, processEnv: ENV(MCP_ENV), deps: { npm: f().npm, sleep: NO_WAIT, fetch: mcp.fetch } });

  test("a refused MCP publish in the last layer leaves the npm layers revealed", async () => {
    const { log } = f();
    const failed = await run().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TrainPublishRunError);
    expect(failed).toMatchObject({ code: "publish-mcp-registry-failed", member: "server", step: "reveal", revealed: ["core: npm (1 package)", "lex: npm (1 package)"] });
    expect(latest(log)).toEqual({ "@acme/core": "2.0.0", "@acme/lex": "2.0.0" });
  });

  test("run again, skips what each record shows revealed, waits on lex, and publishes the entry", async () => {
    const { log } = f();
    mcp.state.refuse = false;
    const before = npmCalls(log).length;
    const done = await run();
    expect(done).toMatchObject({ kind: "published", resumed: [{ member: "server", step: "staged" }, { member: "core", step: "revealed" }, { member: "lex", step: "revealed" }] });
    const calls = npmCalls(log).slice(before);
    expect(calls.filter((a) => a[0] === "publish" || a[0] === "dist-tag")).toEqual([]);
    expect(calls).toContainEqual(["view", "@acme/lex", "dist-tags.latest"]);
    expect([...mcp.held]).toEqual(["io.github.acme/lex@2.0.0"]);
  });
});

describe("dependencies", () => {
  test("are each member's direct ones, by name", () => {
    expect(Object.fromEntries(trainDependencies([
      { member: "server", provides: ["mcp:x"], needs: ["npm:@a/lex", "oci:ghcr.io/a/img"] },
      { member: "lex", provides: ["npm:@a/lex", "member:lex"], needs: [] },
      { member: "img", provides: ["oci:ghcr.io/a/img", "member:img"], needs: ["member:lex"] },
    ]))).toEqual({ server: ["img", "lex"], lex: [], img: ["lex"] });
  });
});
