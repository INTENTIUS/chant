/**
 * #5151: files a release builds once in its cut, recorded by digest, and
 * refused by a publish target when the file it reads differs.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  artifactFileProblems,
  buildReleaseArtifacts,
  checkReleaseArtifacts,
  copyArtifactFiles,
  expandOutput,
  isPrebuilt,
  releaseArtifactFiles,
  ReleaseArtifactError,
  type ReleaseArtifactDeclaration,
} from "./release-artifacts";
import { cutRelease, ReleaseCutError } from "./release-cut";
import { checkReleaseDigest, expandArtifactAssets } from "./publish-targets";
import { PublishTargetError } from "./release-publish";
import type { Release, ReleasePublish } from "./release-store";
import type { TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";

const dirs: string[] = [];
const repos: TestRepo[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "chant-5151-"));
  dirs.push(d);
  return d;
}

const EPOCH = 1_760_000_000;

/** A build that writes `dist/<os>_<arch>/tool<ext>` holding the platform and the label. */
const TOOL: ReleaseArtifactDeclaration = {
  name: "tool",
  build: 'mkdir -p "dist/${CHANT_RELEASE_OS}_${CHANT_RELEASE_ARCH}" && printf "%s %s/%s" "$CHANT_RELEASE_LABEL" "$CHANT_RELEASE_OS" "$CHANT_RELEASE_ARCH" > "dist/${CHANT_RELEASE_OS}_${CHANT_RELEASE_ARCH}/tool${CHANT_RELEASE_EXT}" && chmod +x "dist/${CHANT_RELEASE_OS}_${CHANT_RELEASE_ARCH}/tool${CHANT_RELEASE_EXT}"',
  outputs: ["dist/{os}_{arch}/tool{ext}"],
  platforms: ["linux/amd64", "darwin/arm64", "windows/amd64"],
};

const refusal = (fn: () => unknown): ReleaseArtifactError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReleaseArtifactError) return err;
    throw err;
  }
  throw new Error("not refused");
};

/** The entries of a zip the way an unzip reads them: from the central directory, each inflated. */
function readZip(buf: Buffer): Record<string, { data: string; mode: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, { data: string; mode: number }> = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf-8");
    const localName = buf.readUInt16LE(local + 26);
    const data = inflateRawSync(buf.subarray(local + 30 + localName, local + 30 + localName + size)).toString("utf-8");
    out[name] = { data, mode: mode & 0o777 };
    at += 46 + nameLen;
  }
  return out;
}

describe("release.artifacts is checked (#5151)", () => {
  test("names, kinds, paths, platforms and placeholders", () => {
    expect(refusal(() => checkReleaseArtifacts([{ name: "a b", build: "x", outputs: ["a"] }])).code).toBe("release-artifact-name-invalid");
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["a"] }, { name: "a", checksums: "s" }])).code).toBe("release-artifact-name-taken");
    expect(refusal(() => checkReleaseArtifacts([{ name: "app", build: "x", outputs: ["a"] }], { imageNames: ["app"] })).code).toBe("release-artifact-name-taken");
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["../a"] }])).code).toBe("release-artifact-outside");
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["dist/{os}"] }])).message).toMatch(/no platforms/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["dist/{goos}"], platforms: ["linux/amd64"] }])).message).toMatch(/\{goos\}/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["a"], platforms: ["amd64"] }])).message).toMatch(/os\/arch/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "s", checksums: "SUMS", of: ["later"] }, { name: "later", build: "x", outputs: ["a"] }])).message).toMatch(/not an entry before it/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "a", build: "x", outputs: ["a"], checksums: "s" } as unknown as ReleaseArtifactDeclaration])).message).toMatch(/more than one/);
  });
});

describe("files the cut builds (#5151)", () => {
  test("a build per platform, packed tar.gz and zip on Windows, the same bytes twice, and a checksums file", () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "README.md"), "read me\n");
    const decls: ReleaseArtifactDeclaration[] = [{ ...TOOL, archive: { files: ["README.md"] } }, { name: "sums", checksums: "dist/SHA256SUMS" }];
    const build = () => buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", env: { PATH: process.env.PATH ?? "" } });
    const first = build();
    expect(first.map((a) => [a.component, a.path])).toEqual([
      ["tool", "dist/tool_linux_amd64.tar.gz"],
      ["tool", "dist/tool_darwin_arm64.tar.gz"],
      ["tool", "dist/tool_windows_amd64.zip"],
      ["sums", "dist/SHA256SUMS"],
    ]);
    expect(first.every((a) => a.kind === "asset" && /^sha256:[0-9a-f]{64}$/.test(a.digest))).toBe(true);
    // The same files pack to the same bytes, so a build on the tag checks against the cut's record.
    expect(build()).toEqual(first);

    const listing = execFileSync("tar", ["-tzvf", join(cwd, "dist/tool_linux_amd64.tar.gz")], { encoding: "utf-8" });
    expect(listing).toMatch(/^-rwxr-xr-x .* tool$/m);
    expect(listing).toMatch(/^-rw-r--r-- .* README\.md$/m);
    expect(execFileSync("tar", ["-xzOf", join(cwd, "dist/tool_linux_amd64.tar.gz"), "tool"], { encoding: "utf-8" })).toBe("v1.4.0 linux/amd64");

    const zip = readZip(readFileSync(join(cwd, "dist/tool_windows_amd64.zip")));
    expect(zip["tool.exe"]).toEqual({ data: "v1.4.0 windows/amd64", mode: 0o755 });
    expect(zip["README.md"]).toEqual({ data: "read me\n", mode: 0o644 });

    const sums = readFileSync(join(cwd, "dist/SHA256SUMS"), "utf-8").trim().split("\n");
    expect(sums.map((l) => l.split("  ")[1])).toEqual(["tool_darwin_arm64.tar.gz", "tool_linux_amd64.tar.gz", "tool_windows_amd64.zip"]);
    for (const line of sums) {
      const [hex, name] = line.split("  ");
      expect(first.find((a) => a.path === `dist/${name}`)?.digest).toBe(`sha256:${hex}`);
    }
  });

  test("raw outputs are recorded as written, and a glob names what the build wrote", () => {
    const cwd = scratch();
    const files = buildReleaseArtifacts({
      artifacts: [{ name: "bin", build: "mkdir -p out && printf a > out/a-$CHANT_RELEASE_LABEL.bin && printf b > out/b-$CHANT_RELEASE_LABEL.bin", outputs: ["out/*-{label}.bin"] }],
      cwd,
      sourceDateEpoch: EPOCH,
      label: "2.0.0",
    });
    expect(files.map((f) => f.path)).toEqual(["out/a-2.0.0.bin", "out/b-2.0.0.bin"]);
    expect(expandOutput(cwd, "out/?-2.0.0.bin")).toEqual(["out/a-2.0.0.bin", "out/b-2.0.0.bin"]);
  });

  test("a failing build, a missing output, a path written twice and a checksums name collision stop the cut", () => {
    const cwd = scratch();
    const at = (artifacts: ReleaseArtifactDeclaration[], label: string | null = "v1") => refusal(() => buildReleaseArtifacts({ artifacts, cwd, sourceDateEpoch: EPOCH, label }));
    expect(at([{ name: "a", build: "exit 3", outputs: ["a"] }]).code).toBe("release-artifact-build-failed");
    expect(at([{ name: "a", build: "true", outputs: ["nothing"] }]).code).toBe("release-artifact-no-output");
    expect(at([{ name: "a", build: "printf x > same", outputs: ["same"], platforms: ["linux/amd64", "linux/arm64"] }]).code).toBe("release-artifact-output-taken");
    expect(at([{ name: "a", build: "printf x > a.txt", outputs: ["a.txt"] }, { name: "b", build: "printf y > a.txt", outputs: ["a.txt"] }]).code).toBe("release-artifact-output-taken");
    expect(at([{ name: "a", build: "printf x > v.txt", outputs: ["{label}.txt"] }], null).code).toBe("release-artifact-no-label");
    expect(
      at([
        { name: "a", build: "mkdir -p x y && printf 1 > x/f && printf 2 > y/f", outputs: ["x/f", "y/f"] },
        { name: "s", checksums: "SUMS" },
      ]).code,
    ).toBe("release-artifact-checksums-name-taken");
  });

  test("goreleaser runs in snapshot mode with the label, its version must be the label, and its uploadable files are recorded", () => {
    const cwd = scratch();
    const ran: Array<{ command: string; label: string | undefined; bin: string | undefined }> = [];
    const fakeGoreleaser = (version: string) => (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      ran.push({ command, label: o.env.CHANT_RELEASE_LABEL, bin: o.env.CHANT_GORELEASER });
      const dist = join(o.cwd, "dist");
      mkdirSync(join(dist, "app_linux_amd64_v1"), { recursive: true });
      writeFileSync(join(dist, "app_linux_amd64_v1", "app"), "binary");
      writeFileSync(join(dist, "app_1.4.0_linux_amd64.tar.gz"), "archive");
      writeFileSync(join(dist, "checksums.txt"), "sums");
      writeFileSync(join(dist, "metadata.json"), JSON.stringify({ project_name: "app", version }));
      writeFileSync(
        join(dist, "artifacts.json"),
        JSON.stringify([
          { name: "metadata.json", path: "dist/metadata.json", type: "Metadata" },
          { name: "app", path: "dist/app_linux_amd64_v1/app", type: "Binary" },
          { name: "app_1.4.0_linux_amd64.tar.gz", path: "dist/app_1.4.0_linux_amd64.tar.gz", type: "Archive" },
          { name: "checksums.txt", path: "dist/checksums.txt", type: "Checksum" },
        ]),
      );
      return 0;
    };
    const decls: ReleaseArtifactDeclaration[] = [{ name: "app", goreleaser: { config: ".goreleaser.yaml" } }];
    const files = buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", env: { CHANT_GORELEASER: "/opt/goreleaser" }, run: fakeGoreleaser("v1.4.0") });
    expect(ran).toEqual([{ command: "/opt/goreleaser release --snapshot --clean --skip=publish --config .goreleaser.yaml", label: "v1.4.0", bin: "/opt/goreleaser" }]);
    expect(files.map((f) => f.path)).toEqual(["dist/app_1.4.0_linux_amd64.tar.gz", "dist/checksums.txt"]);
    // The label from its first digit is the version too, as goreleaser strips a v.
    expect(buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", env: {}, run: fakeGoreleaser("1.4.0") })).toEqual(files);
    // A config whose snapshot version is goreleaser's default would ship binaries that report another version.
    const err = refusal(() => buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", env: {}, run: fakeGoreleaser("0.0.0-SNAPSHOT-abc1234") }));
    expect(err.code).toBe("release-artifact-version-mismatch");
    expect(err.fix).toContain("{{ .Env.CHANT_RELEASE_LABEL }}");
    expect(refusal(() => buildReleaseArtifacts({ artifacts: decls, cwd, sourceDateEpoch: EPOCH, label: null, run: fakeGoreleaser("x") })).code).toBe("release-artifact-no-label");
    // Named types record what they name, a built binary among them.
    expect(buildReleaseArtifacts({ artifacts: [{ name: "app", goreleaser: { types: ["Binary"] } }], cwd, sourceDateEpoch: EPOCH, label: "v1.4.0", run: fakeGoreleaser("v1.4.0") }).map((f) => f.path)).toEqual(["dist/app_linux_amd64_v1/app"]);
  });

  test("the files are checked on disk, and staged and restored at their paths", () => {
    const cwd = scratch();
    const files = buildReleaseArtifacts({ artifacts: [TOOL], cwd, sourceDateEpoch: EPOCH, label: "v1" });
    expect(artifactFileProblems(cwd, files)).toEqual([]);
    const stage = scratch();
    copyArtifactFiles(files, cwd, stage);
    const next = scratch();
    copyArtifactFiles(files, stage, next);
    expect(artifactFileProblems(next, files)).toEqual([]);
    writeFileSync(join(next, files[0]!.path), "tampered");
    expect(artifactFileProblems(next, files)).toEqual([expect.objectContaining({ path: files[0]!.path, problem: "digest", recorded: files[0]!.digest })]);
    expect(refusal(() => copyArtifactFiles([{ path: "dist/none" }], stage, next)).code).toBe("release-artifact-missing");
  });
});

describe("files built before the cut, on other runners (#5183)", () => {
  const JOBS = [
    { name: "linux-arm64", outputs: ["dist/linux_arm64/tool"] },
    { name: "darwin-arm64", outputs: ["dist/darwin_arm64/tool"] },
  ];
  /** What a build job's archive leaves in the checkout once the cut job unpacks it. */
  const unpack = (cwd: string, files: Record<string, string>): void => {
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), data, { mode: 0o755 });
    }
  };
  const noRun = () => {
    throw new Error("the cut ran a command for an entry with no build");
  };

  test("an entry with no build, or with builtBy, is checked", () => {
    expect(() => checkReleaseArtifacts([{ name: "tool", outputs: ["dist/tool"] }])).not.toThrow();
    expect(() => checkReleaseArtifacts([{ name: "tool", builtBy: ["linux-arm64", "darwin-arm64"] }], { builds: JOBS })).not.toThrow();
    expect(isPrebuilt({ name: "tool", outputs: ["dist/tool"] })).toBe(true);
    expect(isPrebuilt({ name: "tool", build: "make", outputs: ["dist/tool"] })).toBe(false);
    const unknown = refusal(() => checkReleaseArtifacts([{ name: "tool", builtBy: "windows" }], { builds: JOBS }));
    expect(unknown.code).toBe("release-artifact-invalid");
    expect(unknown.message).toMatch(/builtBy names "windows", which is not a release.workflow.builds job \(they are linux-arm64, darwin-arm64\)/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool", builtBy: "linux-arm64" }])).message).toMatch(/not a release.workflow.builds job/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool", build: "make", builtBy: "linux-arm64", outputs: ["a"] } as ReleaseArtifactDeclaration], { builds: JOBS })).message).toMatch(/both a build command and builtBy/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool", builtBy: "linux-arm64", platforms: ["linux/arm64"] }], { builds: JOBS })).message).toMatch(/platforms and no outputs/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool" } as ReleaseArtifactDeclaration])).message).toMatch(/names none of outputs, goreleaser and checksums/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool", builtBy: "x" }], { builds: [{ name: "x", outputs: ["dist/[ab]"] }] })).message).toMatch(/\[ \] glob/);
    expect(refusal(() => checkReleaseArtifacts([{ name: "tool", outputs: ["../tool"] }])).code).toBe("release-artifact-outside");
  });

  test("the cut records the files per platform as they are, runs nothing, and archives and checksums cover them", () => {
    const cwd = scratch();
    unpack(cwd, { "dist/linux_arm64/tool": "linux built on arm", "dist/darwin_arm64/tool": "darwin built on a mac" });
    const raw = buildReleaseArtifacts({
      artifacts: [{ name: "tool", outputs: ["dist/{os}_{arch}/tool{ext}"], platforms: ["linux/arm64", "darwin/arm64"] }],
      cwd,
      sourceDateEpoch: EPOCH,
      label: "v2.0.0",
      run: noRun,
    });
    expect(raw.map((a) => [a.component, a.path])).toEqual([
      ["tool", "dist/linux_arm64/tool"],
      ["tool", "dist/darwin_arm64/tool"],
    ]);
    expect(readFileSync(join(cwd, "dist/linux_arm64/tool"), "utf-8")).toBe("linux built on arm");
    expect(artifactFileProblems(cwd, raw)).toEqual([]);

    const packed = buildReleaseArtifacts({
      artifacts: [{ name: "tool", outputs: ["dist/{os}_{arch}/tool"], platforms: ["linux/arm64", "darwin/arm64"], archive: true }, { name: "sums", checksums: "dist/SHA256SUMS", of: ["tool"] }],
      cwd,
      sourceDateEpoch: EPOCH,
      label: "v2.0.0",
      run: noRun,
    });
    expect(packed.map((a) => a.path)).toEqual(["dist/tool_linux_arm64.tar.gz", "dist/tool_darwin_arm64.tar.gz", "dist/SHA256SUMS"]);
    expect(execFileSync("tar", ["-xzOf", join(cwd, "dist/tool_darwin_arm64.tar.gz"), "tool"], { encoding: "utf-8" })).toBe("darwin built on a mac");
    expect(readFileSync(join(cwd, "dist/SHA256SUMS"), "utf-8").split("\n").filter(Boolean).map((l) => l.split("  ")[1])).toEqual(["tool_darwin_arm64.tar.gz", "tool_linux_arm64.tar.gz"]);
  });

  test("builtBy takes the build jobs' outputs, and a file missing from them stops the cut", () => {
    const cwd = scratch();
    unpack(cwd, { "dist/linux_arm64/tool": "linux" });
    const err = refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "tool", builtBy: ["linux-arm64", "darwin-arm64"] }], builds: JOBS, cwd, sourceDateEpoch: EPOCH, label: "v1", run: noRun }));
    expect(err.code).toBe("release-artifact-not-built");
    expect(err.message).toBe('artifact "tool" has no dist/darwin_arm64/tool: the entry has no build command, so the file must be there before the cut, written by the build jobs linux-arm64, darwin-arm64');
    unpack(cwd, { "dist/darwin_arm64/tool": "darwin" });
    const files = buildReleaseArtifacts({ artifacts: [{ name: "tool", builtBy: ["linux-arm64", "darwin-arm64"] }], builds: JOBS, cwd, sourceDateEpoch: EPOCH, label: "v1", run: noRun });
    expect(files.map((f) => f.path)).toEqual(["dist/linux_arm64/tool", "dist/darwin_arm64/tool"]);

    const perPlatform = refusal(() => buildReleaseArtifacts({ artifacts: [{ name: "w", outputs: ["dist/{os}_{arch}/tool{ext}"], platforms: ["windows/amd64"] }], cwd, sourceDateEpoch: EPOCH, label: "v1", run: noRun }));
    expect(perPlatform.code).toBe("release-artifact-not-built");
    expect(perPlatform.message).toMatch(/^artifact "w" for windows\/amd64 has no dist\/windows_amd64\/tool\.exe/);
  });

  test("under --at the files are read from the checkout the cut runs in and copied to the commit's", () => {
    const here = scratch();
    const at = scratch();
    unpack(here, { "dist/linux_arm64/tool": "runner bytes" });
    const files = buildReleaseArtifacts({
      artifacts: [{ name: "tool", outputs: ["dist/*/tool"], archive: { name: "tool" } }],
      cwd: at,
      prebuiltFrom: here,
      sourceDateEpoch: EPOCH,
      label: "v1",
      run: noRun,
    });
    expect(files.map((f) => f.path)).toEqual(["dist/tool.tar.gz"]);
    expect(readFileSync(join(at, "dist/linux_arm64/tool"), "utf-8")).toBe("runner bytes");
    expect(execFileSync("tar", ["-xzOf", join(at, "dist/tool.tar.gz"), "tool"], { encoding: "utf-8" })).toBe("runner bytes");
  });

  test("the release records them, and the publish side checks them as any other file", async () => {
    const r = new TestRepo("release-artifacts-prebuilt");
    repos.push(r);
    r.write("chant.config.ts", "export default { release: { green: \"none\" } };\n");
    r.write(".gitignore", "dist/\n");
    r.commit("init");
    unpack(r.dir, { "dist/linux_arm64/tool": "linux", "dist/darwin_arm64/tool": "darwin" });
    const decls: ReleaseArtifactDeclaration[] = [{ name: "tool", builtBy: ["linux-arm64", "darwin-arm64"] }];
    const noCompile: TargetCompiler = {
      async compile(env) {
        throw new Error(`compiled ${env}`);
      },
      async buildArtifacts() {
        throw new Error("built");
      },
    };
    const result = await cutRelease({
      cwd: r.dir,
      compiler: noCompile,
      label: "v1.0.0",
      actor: "alice",
      env: {},
      green: "none",
      publishes: [{ target: "forge:0123456789abcdef", kind: "forge", destination: "github acme/tool" }],
      buildArtifacts: () => buildReleaseArtifacts({ artifacts: decls, builds: JOBS, cwd: r.dir, sourceDateEpoch: EPOCH, label: "v1.0.0", run: noRun }),
    });
    const release = result.release as Release;
    const files = releaseArtifactFiles(release, ["tool"]);
    expect(expandArtifactAssets(release, ["artifact:tool"])).toEqual(["dist/darwin_arm64/tool", "dist/linux_arm64/tool"]);
    // --from: the staged files are put in place and checked against the record.
    const stage = scratch();
    copyArtifactFiles(files, r.dir, stage);
    const publishJob = scratch();
    copyArtifactFiles(files, stage, publishJob);
    expect(artifactFileProblems(publishJob, files)).toEqual([]);
    // A file another runner changed after the cut is refused.
    writeFileSync(join(publishJob, "dist/linux_arm64/tool"), "swapped");
    expect(artifactFileProblems(publishJob, files)).toEqual([expect.objectContaining({ path: "dist/linux_arm64/tool", problem: "digest" })]);
    const recorded = files.find((f) => f.path === "dist/linux_arm64/tool")!;
    const swapped = artifactFileProblems(publishJob, files)[0]!.digest!;
    expect(() => checkReleaseDigest(release, "asset", publishJob, recorded.path, [swapped])).toThrow(PublishTargetError);
  });
});

describe("a release records the files and the targets check them (#5151)", () => {
  const FORGE: ReleasePublish = { target: "forge:0123456789abcdef", kind: "forge", destination: "github acme/tool" };
  const noCompile: TargetCompiler = {
    async compile(env) {
      throw new Error(`compiled ${env}`);
    },
    async buildArtifacts() {
      throw new Error("built");
    },
  };

  test("an artifact release built at the cut records each file, and a forge asset that differs is refused", async () => {
    const r = new TestRepo("release-artifacts");
    repos.push(r);
    r.write("chant.config.ts", "export default { release: { green: \"none\" } };\n");
    r.write(".gitignore", "dist/\n");
    r.commit("init");
    const decls: ReleaseArtifactDeclaration[] = [{ ...TOOL, archive: true }, { name: "sums", checksums: "dist/SHA256SUMS" }];
    const result = await cutRelease({
      cwd: r.dir,
      compiler: noCompile,
      label: "v1.0.0",
      actor: "alice",
      env: {},
      green: "none",
      publishes: [FORGE],
      buildArtifacts: () => buildReleaseArtifacts({ artifacts: decls, cwd: r.dir, sourceDateEpoch: EPOCH, label: "v1.0.0" }),
    });
    const release = result.release as Release;
    const files = releaseArtifactFiles(release, ["tool", "sums"]);
    expect(files.map((f) => f.path).sort()).toEqual(["dist/SHA256SUMS", "dist/tool_darwin_arm64.tar.gz", "dist/tool_linux_amd64.tar.gz", "dist/tool_windows_amd64.zip"]);
    expect(expandArtifactAssets(release, ["artifact:tool", "README.md"])).toEqual(["dist/tool_darwin_arm64.tar.gz", "dist/tool_linux_amd64.tar.gz", "dist/tool_windows_amd64.zip", "README.md"]);
    expect(() => expandArtifactAssets(release, ["artifact:nope"])).toThrow(PublishTargetError);
    const recorded = files.find((f) => f.path === "dist/tool_linux_amd64.tar.gz")!;
    expect(() => checkReleaseDigest(release, "asset", r.dir, recorded.path, [recorded.digest])).not.toThrow();
    const err = (() => {
      try {
        checkReleaseDigest(release, "asset", r.dir, recorded.path, [`sha256:${"0".repeat(64)}`]);
      } catch (e) {
        return e as PublishTargetError;
      }
      return null;
    })();
    expect(err?.code).toBe("publish-artifact-digest-mismatch");
  });

  test("an entry named like a component is refused", async () => {
    const r = new TestRepo("release-artifacts-clash");
    repos.push(r);
    r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    const compiler: TargetCompiler = {
      async compile(env) {
        return { env, params: [], components: ["tool"], buildSteps: {}, buildInputs: {}, componentFiles: { tool: "tool.component.ts" }, templates: [{ component: "tool", path: "a.json", content: "{}" }] };
      },
      async buildArtifacts() {
        return [];
      },
    };
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v1", actor: "alice", env: {}, buildArtifacts: () => [{ component: "tool", kind: "asset", path: "dist/tool", digest: `sha256:${"a".repeat(64)}` }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("release-artifact-name-taken");
  });
});
