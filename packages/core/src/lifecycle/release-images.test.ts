/**
 * #4657 (option 1): the cut builds the release's images, records their
 * digests, and hands them to the build that packs the package; one cut and
 * one publish take the release out, and the package pins what is pushed.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease, ReleaseCutError } from "./release-cut";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { ociArchiveDigest } from "./publish-oci";
import { createPublishTargets } from "./publish-targets";
import { runPublish, PublishTargetError, type PublishContext } from "./release-publish";
import {
  buildReleaseImages,
  checkReleaseImages,
  packagePinProblem,
  pinnedDigests,
  readPins,
  releaseImageDigests,
  releaseImagePlatforms,
  ReleaseImageError,
  unknownPins,
  writeReleaseDigests,
} from "./release-images";
import type { Release, ReleaseArtifact } from "./release-store";
import { readFakeNpmRegistry, seedFakeNpmRegistry, startFakeRegistry, writeFakeNpm, writeLockfile, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const D = (c: string) => `sha256:${c.repeat(64)}`;
const NO_OIDC = { oidc: false, ci: null, reason: "not in CI" };

describe("release.images (#4657)", () => {
  test("names are checked, and an archive outside the member is refused", () => {
    expect(() => checkReleaseImages([{ name: "a b", build: "x", archive: "a.tar" }])).toThrow(/not a name/);
    expect(() => checkReleaseImages([{ name: "a", build: "x", archive: "a.tar" }, { name: "a", build: "y", archive: "b.tar" }])).toThrow(/twice/);
    expect(() => checkReleaseImages([{ name: "a", build: "x", archive: "../a.tar" }])).toThrow(/not a path inside the member/);
  });

  test("the platforms the images build: a Dockerfile entry's or the default, and a command entry's own (#4876)", () => {
    expect(releaseImagePlatforms([{ name: "a", dockerfile: "Dockerfile" }])).toEqual(["linux/amd64", "linux/arm64"]);
    expect(releaseImagePlatforms([{ name: "a", dockerfile: "Dockerfile", platforms: ["linux/amd64"] }, { name: "b", build: "x", archive: "b.tar" }])).toEqual(["linux/amd64"]);
    expect(releaseImagePlatforms([{ name: "b", build: "x", archive: "b.tar", platforms: ["linux/arm64", "linux/amd64"] }])).toEqual(["linux/amd64", "linux/arm64"]);
    expect(() => checkReleaseImages([{ name: "b", build: "x", archive: "b.tar", platforms: ["arm64"] }])).toThrow(/os\/arch/);
  });

  test("each build runs with SOURCE_DATE_EPOCH and the label, and its archive's top manifest digest is recorded", () => {
    const r = new TestRepo("release-images-build");
    repos.push(r);
    const seen: Array<Record<string, string | undefined>> = [];
    const built = buildReleaseImages({
      images: [{ name: "tofu", build: "build tofu", archive: "out/tofu" }],
      cwd: r.dir,
      sourceDateEpoch: 1762473600,
      label: "v2",
      env: { PATH: process.env.PATH, CHANT_RELEASE_LABEL: "from the shell" },
      archiveDigest: ociArchiveDigest,
      run: (_command, o) => {
        seen.push({ epoch: o.env.SOURCE_DATE_EPOCH, label: o.env.CHANT_RELEASE_LABEL });
        writeOciLayout(join(o.cwd, "out/tofu"), "tofu layer");
        return 0;
      },
    });
    const expected = ociArchiveDigest(join(r.dir, "out/tofu"));
    expect(built).toEqual([{ component: "tofu", kind: "image", path: "out/tofu", digest: expected }]);
    expect(seen).toEqual([{ epoch: "1762473600", label: "v2" }]);
  });

  test("a failed build and a build that writes no archive stop the cut", () => {
    const base = { cwd: "/nowhere", sourceDateEpoch: 1, label: null, archiveDigest: () => D("a"), images: [{ name: "a", build: "false", archive: "a.tar" }] };
    expect(() => buildReleaseImages({ ...base, run: () => 2 })).toThrow(ReleaseImageError);
    expect(() => buildReleaseImages({ ...base, run: () => 0 })).toThrow(/wrote no a.tar/);
  });

  test("pins: every sha256 digest in the file is checked against the release's images", () => {
    const release = { artifactDigests: [{ component: "tofu", kind: "image" as const, path: "out/tofu", digest: D("a") }, { component: "x", kind: "asset" as const, path: "x", digest: D("b") }] };
    expect(pinnedDigests(`{"tofu":"${D("a")}","again":"${D("a")}"}`)).toEqual([D("a")]);
    expect(unknownPins(`{"tofu":"${D("a")}"}`, release)).toEqual([]);
    // An asset's digest is not an image's.
    expect(unknownPins(`{"tofu":"${D("b")}"}`, release)).toEqual([D("b")]);
    expect(releaseImageDigests(release)).toEqual({ tofu: D("a") });
  });

  test("pins are read from a package directory and from a packed .tgz", () => {
    const r = new TestRepo("release-images-pins");
    repos.push(r);
    const pkg = join(r.dir, "pkg");
    writePackage(pkg, "@acme/api", "1.0.0");
    writeReleaseDigests(join(pkg, "dist", "digests.json"), { tofu: D("c") });
    expect(readPins(pkg, "dist/digests.json", true)).toContain(D("c"));
    expect(readPins(pkg, "dist/nope.json", true)).toBeNull();
    const stage = join(r.dir, "stage");
    mkdirSync(stage);
    execFileSync("cp", ["-R", pkg, join(stage, "package")]);
    execFileSync("tar", ["-czf", join(r.dir, "api.tgz"), "-C", stage, "package"]);
    expect(readPins(join(r.dir, "api.tgz"), "dist/digests.json", false)).toContain(D("c"));
  });
});

/** A member whose cut builds one image and packs one package that pins it, as terragucci's release does. */
async function cutWithImage(r: TestRepo, opts: { pin?: (digests: Record<string, string>) => Record<string, string> } = {}): Promise<{ release: Release; digestsFile: string; order: string[] }> {
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  writeLockfile(r.dir);
  r.write(".gitignore", "image/\npackages/\ndigests.json\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  const digestsFile = join(r.dir, "digests.json");
  const order: string[] = [];
  const compiler: TargetCompiler = {
    async compile(env): Promise<CompiledTarget> {
      order.push(`compile ${env}`);
      // The release's build command: pack the package with the digests the cut wrote.
      const digests = JSON.parse(readFileSync(digestsFile, "utf-8")) as Record<string, string>;
      const pkg = join(r.dir, "packages", "api");
      writePackage(pkg, "@acme/api", "2.0.0");
      writeReleaseDigests(join(pkg, "dist", "image-digests.json"), opts.pin ? opts.pin(digests) : digests);
      return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [{ component: null, path: "dist/out.json", content: "{}\n" }] };
    },
    async buildArtifacts(): Promise<ReleaseArtifact[]> {
      return [];
    },
  };
  const cut = await cutRelease({
    cwd: r.dir,
    compiler,
    label: "v2",
    actor: "alice",
    env: {},
    now: () => new Date("2026-11-07T10:00:00.000Z"),
    buildImages: () => {
      order.push("images");
      const built = buildReleaseImages({
        images: [{ name: "tofu", build: "build", archive: "image" }],
        cwd: r.dir,
        sourceDateEpoch: 1762473600,
        label: "v2",
        archiveDigest: ociArchiveDigest,
        run: (_c, o) => {
          writeOciLayout(join(o.cwd, "image"), "tofu layer");
          return 0;
        },
      });
      writeReleaseDigests(digestsFile, Object.fromEntries(built.map((a) => [a.component, a.digest])));
      return built;
    },
  });
  return { release: cut.release, digestsFile, order };
}

describe("one cut and one publish take an image and the package that pins it out (#4657)", () => {
  test("the images are built before the compile, recorded, pinned by the package, pushed under that digest, and a publish run again sends nothing", async () => {
    const r = new TestRepo("release-images-e2e");
    repos.push(r);
    const { release, order } = await cutWithImage(r);
    expect(order).toEqual(["images", "compile dev"]);
    const image = release.artifactDigests.find((a) => a.component === "tofu")!;
    expect(image).toMatchObject({ kind: "image", path: "image" });
    expect(readFileSync(join(r.dir, "packages/api/dist/image-digests.json"), "utf-8")).toContain(image.digest);

    const reg = await startFakeRegistry({ username: "robot", password: "pw-images-1", token: "tok-images-1" });
    try {
      const log = join(dirname(r.dir), "npm.log");
      seedFakeNpmRegistry(log, { packages: { "@acme/api": { versions: ["1.0.0"], distTags: { latest: "1.0.0" } } } });
      const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
      const decls = [
        { type: "oci", image: "image", repository: `${reg.host}/acme/tofu` },
        { type: "npm", packages: ["packages/api"], pins: "dist/image-digests.json" },
      ].map((d) => PublishDeclarationSchema.parse(d));
      const targets = await createPublishTargets(decls, { npm });
      const env = { PATH: process.env.PATH ?? "", OCI_USERNAME: "robot", OCI_PASSWORD: "pw-images-1" };
      const redactor = createRedactor(env);
      const ctx: PublishContext = { release, label: "v2", releaseTag: "release/v2", provenance: NO_OIDC, cwd: r.dir, tag: null, env, redactor, log: () => {} };
      const publish = () => runPublish({ cwd: r.dir, release, label: "v2", targets, ctx, say: () => {} });

      await publish();
      // The registry serves the image under the digest the package pins.
      expect(reg.manifests.has(image.digest)).toBe(true);
      expect(reg.manifests.has("v2")).toBe(true);
      expect(readFakeNpmRegistry(log).packages["@acme/api"]!.distTags.latest).toBe("2.0.0");

      // Run again: no image is pushed twice and the package is not published again.
      const uploads = reg.uploads;
      const npmLines = readFileSync(log, "utf-8").split("\n").filter(Boolean).length;
      const again = await publish();
      expect(reg.uploads).toBe(uploads);
      const after = readFileSync(log, "utf-8").split("\n").filter(Boolean).slice(npmLines).map((l) => (JSON.parse(l) as { args: string[] }).args[0]);
      expect(after).not.toContain("publish");
      expect(again.published.length).toBe(2);
      expect(existsSync(join(r.dir, "image", "index.json"))).toBe(true);
    } finally {
      await reg.close();
    }
  });

  test("a package that pins a digest the release does not record is refused before anything is published, and release verify's check names it", async () => {
    const r = new TestRepo("release-images-bad-pin");
    repos.push(r);
    const { release } = await cutWithImage(r, { pin: () => ({ tofu: D("9") }) });
    const decls = [PublishDeclarationSchema.parse({ type: "npm", packages: ["packages/api"], pins: "dist/image-digests.json" })];
    const [target] = await createPublishTargets(decls, {});
    const env = { PATH: process.env.PATH ?? "" };
    const ctx: PublishContext = { release, label: "v2", releaseTag: "release/v2", provenance: NO_OIDC, cwd: r.dir, tag: null, env, redactor: createRedactor(env), log: () => {} };
    const err = await target!.plan(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishTargetError);
    expect((err as PublishTargetError).code).toBe("publish-npm-pin-unknown");
    expect(packagePinProblem(r.dir, release, decls)).toMatch(new RegExp(`packages/api pins ${D("9")} in dist/image-digests.json`));

    const missing = [PublishDeclarationSchema.parse({ type: "npm", packages: ["packages/api"], pins: "dist/nope.json" })];
    const [t2] = await createPublishTargets(missing, {});
    expect(((await t2!.plan(ctx).catch((e: unknown) => e)) as PublishTargetError).code).toBe("publish-npm-pins-missing");
  });

  test("an image named like a component is refused", async () => {
    const r = new TestRepo("release-images-clash");
    repos.push(r);
    r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    const compiler: TargetCompiler = {
      async compile(env) {
        return { env, params: [], components: ["tofu"], buildSteps: {}, buildInputs: {}, componentFiles: { tofu: "tofu.component.ts" }, templates: [{ component: "tofu", path: "a.json", content: "{}" }] };
      },
      async buildArtifacts() {
        return [];
      },
    };
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, buildImages: () => [{ component: "tofu", kind: "image", path: "image", digest: D("a") }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("release-image-name-taken");
  });
});

// Kept beside the e2e so a reader sees the shape the cut hands the build.
test("the digests file is sorted JSON of name to digest", () => {
  const r = new TestRepo("release-images-file");
  repos.push(r);
  const file = join(r.dir, "d", "digests.json");
  writeReleaseDigests(file, { z: D("1"), a: D("2") });
  expect(readFileSync(file, "utf-8")).toBe(`{\n  "a": "${D("2")}",\n  "z": "${D("1")}"\n}\n`);
  writeFileSync(file, "");
});

describe("an npm package that would carry an image archive (#4934)", () => {
  /** A member that is itself the package, as sql-yodeler's is, with the image archive under dist/images and `files` as given. */
  const fixture = (name: string, files: string[]): { dir: string; release: Release } => {
    const r = new TestRepo(name);
    repos.push(r);
    writePackage(r.dir, "@acme/app", "2.0.0");
    const pkg = JSON.parse(readFileSync(join(r.dir, "package.json"), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(r.dir, "package.json"), JSON.stringify({ ...pkg, files }, null, 2));
    mkdirSync(join(r.dir, "dist", "images"), { recursive: true });
    writeFileSync(join(r.dir, "dist", "index.js"), "export {};\n");
    writeFileSync(join(r.dir, "dist", "images", "app.tar"), "image bytes");
    const image: ReleaseArtifact = { component: "app", kind: "image", path: "dist/images/app.tar", digest: D("a") };
    return { dir: r.dir, release: { artifactDigests: [image] } as unknown as Release };
  };
  const planOf = async (dir: string, release: Release) => {
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["."] })], {});
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const ctx: PublishContext = { release, label: "v2", releaseTag: "release/v2", provenance: NO_OIDC, cwd: dir, tag: null, env, redactor: createRedactor(env), log: () => {} };
    return target!.plan(ctx);
  };

  test("a package whose files takes the archive's directory is refused at plan time, naming the file and the files entry to add", async () => {
    const { dir, release } = fixture("npm-carries-image", ["dist", "sbom.spdx.json"]);
    const err = await planOf(dir, release).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishTargetError);
    expect((err as PublishTargetError).code).toBe("publish-npm-carries-image");
    expect((err as PublishTargetError).message).toContain("would carry dist/images/app.tar");
    expect((err as PublishTargetError).fix).toContain('Add "!dist/images/app.tar" to "files" in package.json');
  });

  test("the same package with the archive left out plans", async () => {
    const { dir, release } = fixture("npm-leaves-image-out", ["dist", "!dist/images/app.tar", "sbom.spdx.json"]);
    expect((await planOf(dir, release)).map((i) => i.name)).toEqual(["@acme/app@2.0.0"]);
  });
});
