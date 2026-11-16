/**
 * #5154: a release train cut, prepared and published by chant commands. The
 * members are picked by `release changed`, labelled past every version they
 * have anywhere (the npm registry included), cut, recorded and tagged; the
 * prepare stamps every member cut at the commit and builds what they need;
 * the train publish takes the other members' stamps as the commit's. npm is
 * the fake from ../lifecycle/__fixtures__.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cutRelease } from "../lifecycle/release-cut";
import type { ReleaseArtifact } from "../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { seedFakeNpmRegistry, writeFakeNpm } from "../lifecycle/__fixtures__/publish-fakes";
import { stampReleaseVersion } from "../lifecycle/release-version";
import { ChantConfigSchema } from "../config";
import { TestRepo } from "./trust/test-repo";
import { readReleaseTrains } from "./release-train";
import { cutTrain, highestVersion, npmVersions, parseTrainLevels, planTrainCut, TrainCutError, type MemberCutter } from "./train-cut";
import { prepareTrain } from "./train-prepare";
import { runToStderr } from "./train-shell";
import { publishTrain } from "./train-publish";
import { appendPublishRecord } from "../lifecycle/publish-record";
import { createRedactor } from "../lifecycle/publish-credentials";
import { publishTargetKey } from "../lifecycle/publish-targets";

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

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
const member = (n: string) =>
  `export default { environments: ["npm"], release: { version: { packages: ["../../pkgs/${n}"], lockfile: false, ranges: "train" }, publish: [{ type: "npm", stage: false, packages: ["../../pkgs/${n}"] }] } };\n`;

/** chant's layout: an outer workspace whose members own pkgs/<n>, and a nested release/ workspace of one release member per package. */
function setup(opts: { first?: "together" } = {}) {
  const r = new TestRepo("train-cut");
  repos.push(r);
  const names = ["core", "lex", "util"];
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "npm", dir: "release", kind: "workspace", because: "releases" }, ...names.map((n) => ({ name: n, dir: `pkgs/${n}`, kind: "other", because: "a package" }))] }, null, 2));
  r.write("release/chant.workspace.json", JSON.stringify({ name: "npm", schema: 1, members: ["core", "lex"].map((n) => ({ name: n, dir: n, kind: "chant" })) }, null, 2));
  r.write("release/chant.config.ts", `export default { release: { train: { env: "npm"${opts.first ? `, first: "${opts.first}"` : ""} } } };\n`);
  for (const n of ["core", "lex"]) {
    r.write(`release/${n}/chant.config.ts`, member(n));
    r.write(`release/${n}/packages.component.ts`, "export const packages = {};\n");
  }
  // util is a workspace package core builds against and no member releases.
  r.write("pkgs/util/package.json", pkg("@acme/util", "1.0.0", { scripts: { prepack: "true" } }));
  r.write("pkgs/core/package.json", pkg("@acme/core", "1.0.0", { dependencies: { "@acme/util": "^1.0.0" }, scripts: { build: "true" } }));
  r.write("pkgs/lex/package.json", pkg("@acme/lex", "1.0.0", { peerDependencies: { "@acme/core": "^1.0.0" } }));
  r.write("package.json", pkg("acme", "0.0.0", { private: true, workspaces: ["pkgs/*"] }));
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const log = join(dirname(r.dir), "npm.log");
  seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0", "1.0.7"], distTags: { latest: "1.0.7" } }, "@acme/lex": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
  const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
  return { r, log, npm, nested: join(r.dir, "release"), head };
}

/** Cuts in-process, as `chant release cut --at` does, and tags the commit with the member's default tag. */
const cutter =
  (r: TestRepo): MemberCutter =>
  async (m, commit, o) => {
    if (!o.yes) return { tag: null };
    await cutRelease({ cwd: join(o.root, m.dir), compiler, label: m.label, actor: "alice", env: {}, now: () => new Date("2026-11-16T10:00:00.000Z") });
    const tag = `release/npm/${m.member}/${m.label}`;
    if (r.git(["tag", "-l", tag]).trim() === "") r.git(["tag", tag, commit]);
    return { tag };
  };

type Fixture = ReturnType<typeof setup>;
function fixture(make: () => Promise<Fixture>): () => Fixture {
  let f: Fixture | undefined;
  beforeAll(async () => {
    f = await make();
  }, 120_000);
  return () => f!;
}

describe("levels and versions", () => {
  test("--levels takes auto, one level for all, and <member>=<level>, and refuses anything else", () => {
    expect(parseTrainLevels("auto")).toEqual({ members: {} });
    expect(parseTrainLevels(undefined)).toEqual({ members: {} });
    expect(parseTrainLevels("minor core=major, lex=patch")).toEqual({ all: "minor", members: { core: "major", lex: "patch" } });
    expect(() => parseTrainLevels("huge")).toThrow(TrainCutError);
    expect(() => parseTrainLevels("minor major")).toThrow(/two levels/);
    expect(() => parseTrainLevels("=minor")).toThrow(/names no member/);
  });

  test("the highest version ignores what is not one", () => {
    expect(highestVersion(["1.2.3", "v1.10.0", "nope", "1.9.9"])).toBe("1.10.0");
    expect(highestVersion([])).toBeNull();
  });

  test("release.train is part of chant.config.ts, strictly", () => {
    expect(ChantConfigSchema.safeParse({ release: { train: { env: "npm", first: "together", check: ["true"], buildDependencies: false } } }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ release: { train: { env: "npm", frist: "together" } } }).success).toBe(false);
    expect(ChantConfigSchema.safeParse({ release: { train: { env: "a/b" } } }).success).toBe(false);
  });
});

describe("a train cut", () => {
  const f = fixture(async () => setup());

  test("labels each member past every version the registry holds, and plans without writing", async () => {
    const { nested, head, npm, log } = f();
    const registry = npmVersions(npm);
    const plan = await planTrainCut({ cwd: nested, env: "npm", at: head, registry });
    expect(plan.members.map((m) => [m.member, m.label, m.floor])).toEqual([
      ["core", "1.0.8", "1.0.7"],
      ["lex", "1.0.1", "1.0.0"],
    ]);
    const typed = await planTrainCut({ cwd: nested, env: "npm", at: head, registry, levels: parseTrainLevels("lex=minor") });
    expect(typed.members.find((m) => m.member === "lex")).toMatchObject({ label: "1.1.0", bumpFrom: "typed" });
    expect(readFileSync(log, "utf-8")).toContain('"view","@acme/core","versions","--json"');
    await expect(planTrainCut({ cwd: nested, env: "prod", at: head, registry })).rejects.toThrow(/release.train records trains for npm, not prod/);
  });

});

describe("a train cut, resumed", () => {
  let out: Awaited<ReturnType<typeof cutTrain>>;
  const f = fixture(async () => {
    const x = setup();
    // A run that stopped after one cut.
    await cutter(x.r)({ member: "core", dir: "core", label: "1.0.8", why: "", bump: "patch", bumpFrom: "default", floor: null, resumed: false }, x.head, { root: x.nested, yes: true });
    out = await cutTrain({ cwd: x.nested, env: "npm", at: x.head, registry: npmVersions(x.npm), yes: true, noPush: true, cutter: cutter(x.r), actor: "alice" });
    return x;
  });

  test("cuts, records the train and tags it, and takes a member already cut from the commit as it is", async () => {
    const { r, nested, head } = f();
    expect(out.members.map((m) => [m.member, m.label, m.resumed])).toEqual([
      ["lex", "1.0.1", false],
      ["core", "1.0.8", true],
    ]);
    expect(out.tags).toEqual({ core: "release/npm/core/1.0.8", lex: "release/npm/lex/1.0.1" });
    const { records } = await readReleaseTrains(nested, "npm");
    expect(records.map((t) => t.members.map((m) => `${m.member}@${m.label}`))).toEqual([["core@1.0.8", "lex@1.0.1"]]);
    expect(r.git(["tag", "--points-at", head, "-l", "release-train/*"]).trim()).toBe(`release-train/npm/${records[0]!.id}`);
  });

  test("then the commit is released, and nothing more is cut", async () => {
    const { nested, head, npm } = f();
    const again = await planTrainCut({ cwd: nested, env: "npm", at: head, registry: npmVersions(npm) });
    expect(again.released).toBe(out.trainTag);
    expect(again.members).toEqual([]);
  });
});

describe("release.train.check", () => {
  test("a failing release.train.check stops the train before any cut", async () => {
    const x = setup();
    x.r.write("release/chant.config.ts", 'export default { release: { train: { env: "npm", check: ["test \\"$CHANT_TRAIN_ENV\\" = nope"] } } };\n');
    const head = x.r.commit("a check");
    x.r.git(["tag", `ci/green/${head}`]);
    let cuts = 0;
    await expect(cutTrain({ cwd: x.nested, env: "npm", at: head, registry: npmVersions(x.npm), yes: true, noPush: true, cutter: async () => ({ tag: (cuts++, null) }) })).rejects.toThrow(/release.train.check failed/);
    expect(cuts).toBe(0);
  });

  test("a build that train prepare runs writes its stdout to stderr too", async () => {
    const { stdout, stderr, result } = await captured(() => runToStderr("echo built; exit 3", { cwd: tmpdir() }));
    expect(result).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain("built");
  });
});

describe("release.train.check, printing", () => {
  let run: { head: string; stdout: string; stderr: string; result: Awaited<ReturnType<typeof cutTrain>> };
  fixture(async () => {
    const x = setup();
    x.r.write("release/chant.config.ts", 'export default { release: { train: { env: "npm", check: ["echo \\"release floors at $CHANT_RELEASE_COMMIT: 287 floors agree\\""] } } };\n');
    const head = x.r.commit("a check that prints");
    x.r.git(["tag", `ci/green/${head}`]);
    run = { head, ...(await captured(() => cutTrain({ cwd: x.nested, env: "npm", at: head, registry: npmVersions(x.npm), yes: true, noPush: true, cutter: cutter(x.r), actor: "alice" }))) };
    return x;
  });

  test("a check that prints to stdout leaves --json output one JSON document (the first train's cut job)", () => {
    const { head, stdout, stderr, result } = run;
    // What `chant workspace train cut --json` puts on stdout: whatever the cut wrote there, then its document.
    const doc = JSON.parse(`${stdout}${JSON.stringify({ dryRun: false, ...result }, null, 2)}\n`) as { train: { id: string } | null };
    expect(doc.train?.id).toMatch(/^train-/);
    expect(stdout).toBe("");
    expect(stderr).toContain(`release floors at ${head}: 287 floors agree`);
  });
});

/** Runs `f` with what this process writes to stdout and stderr captured, as text. */
async function captured<T>(f: () => Promise<T>): Promise<{ stdout: string; stderr: string; result: T }> {
  const out: string[] = [];
  const err: string[] = [];
  const spy = (into: string[]) => (chunk: string | Uint8Array) => (into.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8")), true);
  const o = vi.spyOn(process.stdout, "write").mockImplementation(spy(out) as typeof process.stdout.write);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(spy(err) as typeof process.stderr.write);
  try {
    const result = await f();
    return { stdout: out.join(""), stderr: err.join(""), result };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe("the first train, together", () => {
  const f = fixture(async () => setup({ first: "together" }));

  test("cuts every member at one label past the highest version any of them has", async () => {
    const { nested, head, npm } = f();
    const plan = await planTrainCut({ cwd: nested, env: "npm", at: head, registry: npmVersions(npm), levels: parseTrainLevels("minor") });
    expect(plan.first).toBe(true);
    expect(plan.members.map((m) => [m.member, m.label])).toEqual([
      ["core", "1.1.0"],
      ["lex", "1.1.0"],
    ]);
    await expect(planTrainCut({ cwd: nested, env: "npm", at: head, registry: npmVersions(npm), levels: parseTrainLevels("core=minor") })).rejects.toThrow(/one level for all/);
  });
});

describe("the first train, together, after lockstep releases of the root", () => {
  const f = fixture(async () => {
    const x = setup({ first: "together" });
    // The root member released every package at one label before the train; those labels are spent.
    x.r.write("release/chant.config.ts", 'export default { environments: ["npm"], release: { train: { env: "npm", first: "together" } } };\n');
    x.r.write("release/packages.component.ts", "export const packages = {};\n");
    const head = x.r.commit("the lockstep root member");
    x.r.git(["tag", `ci/green/${head}`]);
    await cutRelease({ cwd: x.nested, compiler, label: "1.4.0", actor: "alice", env: {}, now: () => new Date("2026-11-16T09:00:00.000Z") });
    return { ...x, head };
  });

  test("labels every member past the root member's own labels too", async () => {
    const { nested, head, npm } = f();
    const plan = await planTrainCut({ cwd: nested, env: "npm", at: head, registry: npmVersions(npm) });
    expect(plan.members.map((m) => m.label)).toEqual(["1.4.1", "1.4.1"]);
  });
});

describe("prepare and publish", () => {
  const f = fixture(async () => {
    const x = setup();
    await cutTrain({ cwd: x.nested, env: "npm", at: x.head, registry: npmVersions(x.npm), yes: true, noPush: true, cutter: cutter(x.r), actor: "alice" });
    return x;
  });

  test("stamps every member cut here with the train's labels, and builds once the package they need that no member publishes here", async () => {
    const { r, nested } = f();
    const runs: string[] = [];
    const out = await prepareTrain({ cwd: nested, env: "npm", run: (command, cwd) => (runs.push(`${command} in ${cwd.slice(cwd.indexOf("pkgs/"))}`), 0) });
    expect(out.stamped.map((s) => [s.member, s.label])).toEqual([
      ["core", "1.0.8"],
      ["lex", "1.0.1"],
    ]);
    expect(runs).toEqual(["npm run prepack in pkgs/util"]);
    expect(JSON.parse(readFileSync(join(r.dir, "pkgs/lex/package.json"), "utf-8"))).toMatchObject({ version: "1.0.1", peerDependencies: { "@acme/core": "^1.0.8" } });
  });

  test("the train publish takes each member's stamp as the commit's, and plans", async () => {
    const { nested, npm } = f();
    const env = { PATH: `${dirname(npm)}:${process.env.PATH}` };
    const plan = await publishTrain({ cwd: nested, env: "npm", processEnv: env });
    expect(plan.kind).toBe("planned");
  });
});

describe("prepare, resuming a publish that revealed a member (#5222)", () => {
  const f = fixture(async () => {
    const x = setup();
    await cutTrain({ cwd: x.nested, env: "npm", at: x.head, registry: npmVersions(x.npm), yes: true, noPush: true, cutter: cutter(x.r), actor: "alice" });
    return x;
  });

  test("builds a member an earlier run revealed when a member still to publish needs it, since npm does not pack it again", async () => {
    const { nested } = f();
    const train = (await readReleaseTrains(nested, "npm")).records.at(-1)!;
    const core = train.members.find((m) => m.member === "core")!;
    const decl = { type: "npm", stage: false, packages: ["../../pkgs/core"] } as const;
    const target = publishTargetKey(ChantConfigSchema.parse({ release: { publish: [decl] } }).release!.publish![0]!);
    await appendPublishRecord(
      { version: 1, releaseDigest: core.releaseDigest, label: core.label, target, kind: "npm", name: "npm", step: "revealed", items: [{ name: "@acme/core@1.0.8", destination: "npm" }], state: {}, runId: "earlier", timestamp: "2026-11-16T10:00:00.000Z" },
      createRedactor(),
      { cwd: join(nested, "core") },
    );
    const runs: string[] = [];
    const out = await prepareTrain({ cwd: nested, env: "npm", run: (command, cwd) => (runs.push(`${command} in ${cwd.slice(cwd.indexOf("pkgs/"))}`), 0) });
    expect(runs).toEqual(["npm run prepack in pkgs/util", "npm run build in pkgs/core"]);
    expect(out.built.map((b) => b.dir)).toEqual(["pkgs/util", "pkgs/core"]);
  });
});

describe("release.version may leave the member (#5154)", () => {
  test("a member under release/<member> stamps a package elsewhere in the repository, and nothing outside it", () => {
    const { r } = setup();
    const s = stampReleaseVersion({ cwd: join(r.dir, "release/lex"), config: { packages: ["../../pkgs/lex"], lockfile: false }, label: "2.0.0" });
    expect(JSON.parse(readFileSync(join(r.dir, "pkgs/lex/package.json"), "utf-8")).version).toBe("2.0.0");
    s.restore();
    expect(() => stampReleaseVersion({ cwd: join(r.dir, "release/lex"), config: { packages: ["../../../elsewhere"] }, label: "2.0.0" })).toThrow(/not a path inside the repository/);
  });
});
