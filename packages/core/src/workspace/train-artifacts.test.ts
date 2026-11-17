/**
 * #5216: a train's members' images and files, from the job that cut them to
 * the job that publishes them, and release verify per member. The checks are
 * `chant release images` and `chant release artifacts` in each member, which
 * these tests stand in for; what is tested is which members, which flags,
 * and where the files go.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease } from "../lifecycle/release-cut";
import type { ReleaseArtifact } from "../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { seedFakeNpmRegistry, writeFakeNpm } from "../lifecycle/__fixtures__/publish-fakes";
import { TestRepo } from "./trust/test-repo";
import { cutTrain, npmVersions, TrainCutError, type MemberCutter } from "./train-cut";
import { TRAIN_ARTIFACTS_INDEX, trainArtifacts, trainVerify, type MemberChant } from "./train-artifacts";
import { memberDigestsEnv } from "./train-publish";
import { resolveRelease } from "../lifecycle/release-store";

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

// The package leaves dist/ out, so the image archive is not packed with it.
const pkg = (name: string, version: string) => `${JSON.stringify({ name, version, files: ["index.js"] }, null, 2)}\n`;

/** Two members: app builds an image and a file at the cut (unless `files` is false), lib publishes a package only. */
async function setup(opts: { files?: boolean } = {}) {
  const files = opts.files !== false;
  const r = new TestRepo("train-artifacts");
  repos.push(r);
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "chant" }, { name: "lib", dir: "lib", kind: "chant" }] }, null, 2));
  r.write("chant.config.ts", 'export default { release: { train: { env: "npm" } } };\n');
  r.write(
    "app/chant.config.ts",
    !files ? 'export default { environments: ["npm"], release: { publish: [{ type: "npm", stage: false, packages: ["."] }] } };\n' : 'export default { environments: ["npm"], release: { images: [{ name: "web", build: "true", archive: "dist/web.tar" }], artifacts: [{ name: "cli", build: "true", outputs: ["dist/cli"] }], publish: [{ type: "npm", stage: false, packages: ["."] }] } };\n',
  );
  r.write("lib/chant.config.ts", 'export default { environments: ["npm"], release: { publish: [{ type: "npm", stage: false, packages: ["."] }] } };\n');
  for (const n of ["app", "lib"]) {
    r.write(`${n}/package.json`, pkg(`@acme/${n}`, "1.0.0"));
    r.write(`${n}/packages.component.ts`, "export const packages = {};\n");
  }
  r.write(".gitignore", "dist/\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const log = join(dirname(r.dir), "npm.log");
  seedFakeNpmRegistry(log, { packages: { "@acme/app": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } }, "@acme/lib": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
  const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
  // app's cut records its image and file, and leaves them in the member, as `release cut --at` copies them back.
  const cutter: MemberCutter = async (m, commit, o) => {
    if (!o.yes) return { tag: null };
    const dir = join(o.root, m.dir);
    const app = files && m.member === "app";
    if (app) {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist/web.tar"), "image");
      writeFileSync(join(dir, "dist/cli"), "cli");
    }
    await cutRelease({
      cwd: dir,
      compiler,
      label: m.label,
      actor: "alice",
      env: {},
      npmPublished: () => true,
      now: () => new Date("2026-11-16T10:00:00.000Z"),
      ...(app
        ? {
            buildImages: async () => [{ component: "web", kind: "image" as const, path: "dist/web.tar", digest: "sha256:aa" }],
            buildArtifacts: async () => [{ component: "cli", kind: "asset" as const, path: "dist/cli", digest: "sha256:bb" }],
          }
        : {}),
    });
    return { tag: null };
  };
  const out = await cutTrain({ cwd: r.dir, env: "npm", at: head, registry: npmVersions(npm), yes: true, noPush: true, cutter, actor: "alice" });
  return { r, head, train: out.train!.id };
}

/** A stand-in for this chant: records each command and the member it ran in, and exits with `code`. */
function recorder(code = 0): { chant: MemberChant; runs: string[] } {
  const runs: string[] = [];
  return { runs, chant: (args, cwd) => (runs.push(`${cwd.split("/").pop()}: ${args.filter((a) => !a.includes("digests.json")).join(" ")}`), code) };
}

describe("train artifacts", () => {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    f = await setup();
  }, 120_000);

  test("in the cut job: checks what the cut left as it is, and stages it per member directory with an index", async () => {
    const { r, train } = f;
    const stage = join(dirname(r.dir), "stage");
    const { chant, runs } = recorder();
    const out = await trainArtifacts({ cwd: r.dir, env: "npm", train, output: stage, chant });
    expect(runs).toEqual(["app: release images 1.0.1 --no-build -o", "app: release artifacts 1.0.1 --no-build"]);
    expect(out.members).toEqual([{ member: "app", ref: "1.0.1", images: ["dist/web.tar"], files: ["dist/cli"], built: { images: false, files: false }, copied: 0 }]);
    expect(readFileSync(join(stage, "app/dist/web.tar"), "utf-8")).toBe("image");
    expect(readFileSync(join(stage, "app/dist/cli"), "utf-8")).toBe("cli");
    expect(JSON.parse(readFileSync(join(stage, TRAIN_ARTIFACTS_INDEX), "utf-8"))).toMatchObject({ train, members: [{ member: "app", images: ["dist/web.tar"], files: ["dist/cli"] }] });
  });

  test("in the publish job: copies them from the stage into a checkout without them, then checks them", async () => {
    const { r, train } = f;
    const stage = join(dirname(r.dir), "stage");
    rmSync(join(r.dir, "app/dist"), { recursive: true, force: true });
    const { chant, runs } = recorder();
    const out = await trainArtifacts({ cwd: r.dir, env: "npm", train, from: stage, chant });
    expect(out.members[0]).toMatchObject({ copied: 2, built: { images: false, files: false } });
    expect(readFileSync(join(r.dir, "app/dist/cli"), "utf-8")).toBe("cli");
    expect(runs).toEqual(["app: release images 1.0.1 --no-build -o", "app: release artifacts 1.0.1 --no-build"]);
  });

  test("with nothing handed over (a pushed train tag, a resumed publish), a member's files are built again; --no-build refuses", async () => {
    const { r, train } = f;
    rmSync(join(r.dir, "app/dist"), { recursive: true, force: true });
    const { chant, runs } = recorder();
    const out = await trainArtifacts({ cwd: r.dir, env: "npm", train, from: join(dirname(r.dir), "nowhere"), chant });
    expect(out.members[0]).toMatchObject({ copied: 0, built: { images: true, files: true } });
    expect(runs).toEqual(["app: release images 1.0.1 -o", "app: release artifacts 1.0.1"]);
    const refused = trainArtifacts({ cwd: r.dir, env: "npm", train, noBuild: true, chant: recorder().chant });
    await expect(refused).rejects.toMatchObject({ code: "train-artifact-missing" });
    await expect(refused).rejects.toThrow(/dist\/web.tar is not here/);
  });

  test("train publish hands a member with images its recorded digests in CHANT_RELEASE_DIGESTS, and other members nothing", async () => {
    const { r } = f;
    const app = (await resolveRelease("1.0.1", { cwd: join(r.dir, "app") }))!.release;
    const env = await memberDigestsEnv(join(r.dir, "app"), app, { KEEP: "1" });
    expect(env.KEEP).toBe("1");
    expect(JSON.parse(readFileSync(env.CHANT_RELEASE_DIGESTS!, "utf-8"))).toEqual({ web: "sha256:aa" });
    const lib = (await resolveRelease("1.0.1", { cwd: join(r.dir, "lib") }))!.release;
    expect(await memberDigestsEnv(join(r.dir, "lib"), lib, { KEEP: "1" })).toEqual({ KEEP: "1" });
  });

  test("a check that fails stops with the member named", async () => {
    const { r, train } = f;
    await expect(trainArtifacts({ cwd: r.dir, env: "npm", train, chant: recorder(1).chant })).rejects.toMatchObject({ code: "train-image-check-failed" });
  });

  test("a checkout of another commit has nothing of the train to check", async () => {
    const { r, train } = f;
    r.write("app/README.md", "later\n");
    r.commit("later");
    try {
      await expect(trainArtifacts({ cwd: r.dir, env: "npm", train, chant: recorder().chant })).rejects.toMatchObject({ code: "train-nothing-cut-here" });
    } finally {
      r.git(["checkout", "-q", "HEAD~1"]);
    }
  });
});

describe("a train whose members build no files", () => {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    f = await setup({ files: false });
  }, 120_000);

  test("train artifacts checks nothing, and its stage still holds the index, so the cut job's upload finds a file", async () => {
    const { r, train } = f;
    const stage = join(dirname(r.dir), "stage-empty");
    const { chant, runs } = recorder();
    const out = await trainArtifacts({ cwd: r.dir, env: "npm", train, output: stage, chant });
    expect(out.members).toEqual([]);
    expect(runs).toEqual([]);
    expect(existsSync(join(stage, TRAIN_ARTIFACTS_INDEX))).toBe(true);
  });

  test("runs release verify in every member the train cut here, and reports every failure before it stops", async () => {
    const { r, train } = f;
    const { chant, runs } = recorder();
    const out = await trainVerify({ cwd: r.dir, env: "npm", train, chant });
    expect(runs.sort()).toEqual(["app: release verify 1.0.1", "lib: release verify 1.0.1"]);
    expect(out.members.every((m) => m.ok)).toBe(true);
    const failing: MemberChant = (args, cwd) => (cwd.endsWith("lib") ? 1 : 0);
    const err = await trainVerify({ cwd: r.dir, env: "npm", train, chant: failing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrainCutError);
    expect(err).toMatchObject({ code: "train-verify-failed" });
    expect((err as Error).message).toContain("lib 1.0.1");
    expect((err as Error).message).not.toContain("app 1.0.1");
  });
});
