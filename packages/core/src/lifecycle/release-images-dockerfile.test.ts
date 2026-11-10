/**
 * #4819: a `release.images` entry that names a Dockerfile, which chant builds
 * as the reproducible OCI archive itself, and the helpers that turn the cut's
 * digests file and a product's `{ name: reference }` into the table its
 * bundle bakes in and the pins file its npm target reads. terragucci's and
 * plywood's `scripts/release-image.sh` and `releaseDigests` are what these
 * replace; the expectations below are what those wrote.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChantConfigSchema } from "../config";
import {
  buildReleaseImages,
  checkReleaseImages,
  RELEASE_DIGESTS_ENV,
  RELEASE_IMAGE_BUILDER,
  RELEASE_IMAGE_DOCKERFILE_FLOOR,
  releaseImageBuildCommand,
  releaseImagePins,
  ReleaseImageError,
  resolveReleaseImages,
  writeReleaseImagePins,
  type ReleaseImageDeclaration,
} from "./release-images";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const scratch = () => mkdtempSync(join(tmpdir(), "chant-release-image-"));

describe("a release.images entry that names a Dockerfile (#4819)", () => {
  test("chant builds it the way both products' release-image.sh did", () => {
    expect(releaseImageBuildCommand({ name: "pulumi", dockerfile: "images/plywood-pulumi/Dockerfile" })).toBe(
      [
        `{ docker buildx inspect ${RELEASE_IMAGE_BUILDER} >/dev/null 2>&1 || docker buildx create --name ${RELEASE_IMAGE_BUILDER} --driver docker-container >/dev/null; }`,
        "mkdir -p dist/images",
        'docker buildx build --builder chant-release --no-cache --platform linux/amd64,linux/arm64 --provenance=false --sbom=false --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" --output type=oci,dest=dist/images/pulumi.tar,rewrite-timestamp=true -f images/plywood-pulumi/Dockerfile . >&2',
      ].join(" && "),
    );
    const own = releaseImageBuildCommand({ name: "tofu", dockerfile: "images/Dockerfile.tofu", context: "images/ctx", platforms: ["linux/amd64"], archive: "out/tofu image.tar" });
    expect(own).toContain("--platform linux/amd64 ");
    expect(own).toContain("--output 'type=oci,dest=out/tofu image.tar,rewrite-timestamp=true' -f images/Dockerfile.tofu images/ctx >&2");
    expect(own).toContain("mkdir -p out && ");
  });

  test("under release.version the build passes the label as CHANT_RELEASE_LABEL, for the image's version label (#4840)", () => {
    const entry = { name: "pulumi", dockerfile: "images/plywood-pulumi/Dockerfile" };
    const plain = releaseImageBuildCommand(entry);
    expect(plain).not.toContain("CHANT_RELEASE_LABEL");
    expect(releaseImageBuildCommand(entry, { versionArg: true })).toBe(
      plain.replace('--build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH"', '--build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" --build-arg CHANT_RELEASE_LABEL="$CHANT_RELEASE_LABEL"'),
    );
  });

  test("args go to the build as build arguments, so sql-yodeler's release-image.sh is a Dockerfile entry (#4908)", () => {
    const entry = {
      name: "sql-yodeler",
      dockerfile: ".github/image/Dockerfile",
      context: "dist/image-context",
      prepare: "mkdir -p dist/image-context && npm pack --pack-destination dist/image-context",
      args: { YODEL_PACKAGE: "/ctx/intentius-sql-yodeler-0.14.0.tgz", CHANT_PINS: "@intentius/chant@0.124.87 @intentius/chant-lexicon-sql@0.124.87" },
    };
    expect(releaseImageBuildCommand(entry, { versionArg: true })).toContain(
      `--build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" --build-arg CHANT_RELEASE_LABEL="$CHANT_RELEASE_LABEL" --build-arg YODEL_PACKAGE=/ctx/intentius-sql-yodeler-0.14.0.tgz --build-arg 'CHANT_PINS=@intentius/chant@0.124.87 @intentius/chant-lexicon-sql@0.124.87' --output`,
    );
    expect(releaseImageBuildCommand(entry)).toContain(" -f .github/image/Dockerfile dist/image-context >&2");
    expect(() => checkReleaseImages([entry])).not.toThrow();
    expect(() => checkReleaseImages([{ ...entry, args: { "BAD-NAME": "x" } }])).toThrow(/not a build argument name/);
    expect(() => checkReleaseImages([{ ...entry, args: { SOURCE_DATE_EPOCH: "0" } }])).toThrow(/chant passes itself/);
    expect(() => checkReleaseImages([{ ...entry, args: { A: "x\ny" } }])).toThrow(/one-line/);
    const parsed = ChantConfigSchema.safeParse({ release: { images: [entry] } });
    expect(parsed.success).toBe(true);
  });

  test("the archive defaults to dist/images/<name>.tar, and a build entry is as it was", () => {
    const images: ReleaseImageDeclaration[] = [
      { name: "pulumi", dockerfile: "images/plywood-pulumi/Dockerfile" },
      { name: "old", build: "scripts/release-image.sh old", archive: "dist/images/old.tar" },
    ];
    expect(resolveReleaseImages(images).map((i) => [i.name, i.archive])).toEqual([
      ["pulumi", "dist/images/pulumi.tar"],
      ["old", "dist/images/old.tar"],
    ]);
    expect(resolveReleaseImages(images)[1]).toEqual({ name: "old", build: "scripts/release-image.sh old", archive: "dist/images/old.tar" });
  });

  test("the prepare command runs once, before the builds, with no digests file named", () => {
    const cwd = scratch();
    const runs: { command: string; digests: string | undefined; epoch: string | undefined }[] = [];
    const prepare = "npm run build && npm pack -w @intentius/plywood --pack-destination images/pack";
    const built = buildReleaseImages({
      images: [
        { name: "pulumi", dockerfile: "images/plywood-pulumi/Dockerfile", prepare },
        { name: "plunge", dockerfile: "images/plywood-plunge/Dockerfile", prepare },
      ],
      cwd,
      sourceDateEpoch: 1_700_000_000,
      label: "0.3.0",
      env: { PATH: process.env.PATH, [RELEASE_DIGESTS_ENV]: "/tmp/stale.json" },
      archiveDigest: (abs) => (abs.endsWith("pulumi.tar") ? D("a") : D("b")),
      run: (command, o) => {
        runs.push({ command, digests: o.env[RELEASE_DIGESTS_ENV], epoch: o.env.SOURCE_DATE_EPOCH });
        const m = /dest=([^,]+),/.exec(command);
        if (m) {
          mkdirSync(join(cwd, "dist/images"), { recursive: true });
          writeFileSync(join(cwd, m[1]!), "");
        }
        return 0;
      },
    });
    expect(runs.map((r) => r.command.slice(0, 20))).toEqual([prepare.slice(0, 20), "{ docker buildx insp", "{ docker buildx insp"]);
    expect(runs[0]!.digests).toBeUndefined();
    expect(runs.every((r) => r.epoch === "1700000000")).toBe(true);
    expect(built).toEqual([
      { component: "pulumi", kind: "image", path: "dist/images/pulumi.tar", digest: D("a") },
      { component: "plunge", kind: "image", path: "dist/images/plunge.tar", digest: D("b") },
    ]);
  });

  test("run: the command reaches docker as the argv both scripts passed", () => {
    const cwd = scratch();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    const log = join(cwd, "docker.log");
    // A docker that records its argv, and writes the archive --output names.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nfor a in "$@"; do case "$a" in type=oci,dest=*) d="\${a#type=oci,dest=}"; d="\${d%%,*}"; : > "$d" ;; esac; done\nexit 0\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    buildReleaseImages({
      images: [{ name: "tofu", dockerfile: "images/Dockerfile.tofu" }],
      cwd,
      sourceDateEpoch: 42,
      label: null,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      archiveDigest: () => D("c"),
    });
    const calls = readFileSync(log, "utf-8").trim().split("\n");
    expect(calls).toEqual([
      "buildx inspect chant-release",
      "buildx build --builder chant-release --no-cache --platform linux/amd64,linux/arm64 --provenance=false --sbom=false --build-arg SOURCE_DATE_EPOCH=42 --output type=oci,dest=dist/images/tofu.tar,rewrite-timestamp=true -f images/Dockerfile.tofu .",
    ]);
    expect(existsSync(join(cwd, "dist/images/tofu.tar"))).toBe(true);
  });

  test("an entry with both build and dockerfile, a path outside the member, or a bad platform is refused", () => {
    const refused = (i: unknown) => {
      try {
        checkReleaseImages([i as ReleaseImageDeclaration]);
        return "";
      } catch (e) {
        return (e as ReleaseImageError).code;
      }
    };
    expect(refused({ name: "a", dockerfile: "D", build: "x", archive: "a.tar" })).toBe("release-image-invalid");
    expect(refused({ name: "a", dockerfile: "../D" })).toBe("release-image-archive-outside");
    expect(refused({ name: "a", dockerfile: "D", context: "/abs" })).toBe("release-image-archive-outside");
    expect(refused({ name: "a", dockerfile: "D", platforms: ["linux/amd64; rm"] })).toBe("release-image-invalid");
    expect(refused({ name: "a", dockerfile: "D", platforms: [] })).toBe("release-image-invalid");
    expect(refused({ name: "a", dockerfile: "D", platforms: ["linux/arm64/v8"] })).toBe("");
  });

  test("chant.config.ts takes either form", () => {
    const ok = (images: unknown) => ChantConfigSchema.safeParse({ release: { images } }).success;
    expect(ok([{ name: "pulumi", dockerfile: "images/plywood-pulumi/Dockerfile", context: ".", platforms: ["linux/amd64"], archive: "dist/images/pulumi.tar", prepare: "npm run build" }])).toBe(true);
    expect(ok([{ name: "old", build: "x", archive: "a.tar" }])).toBe(true);
    expect(ok([{ name: "old", build: "x" }])).toBe(false);
    expect(ok([{ name: "both", build: "x", archive: "a.tar", dockerfile: "D" }])).toBe(false);
  });

  test("the floor names the next release", () => expect(RELEASE_IMAGE_DOCKERFILE_FLOOR).toBe("0.124.78"));
});

describe("the digest table and the pins file (#4819)", () => {
  const digestsFile = (named: Record<string, string>) => {
    const f = join(scratch(), "digests.json");
    writeFileSync(f, JSON.stringify(named));
    return f;
  };

  test("outside a release build there is no table, and the pins file is removed", () => {
    const dir = scratch();
    const out = join(dir, "dist/image-digests.json");
    mkdirSync(join(dir, "dist"));
    writeFileSync(out, "{}\n");
    const table = releaseImagePins({ images: { pulumi: "ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0" }, version: "0.3.0", env: {} });
    expect(table).toBeUndefined();
    writeReleaseImagePins(table, { out });
    expect(existsSync(out)).toBe(false);
  });

  test("plywood's table: each image's reference at the version, to the digest the cut recorded", () => {
    const file = digestsFile({ plunge: D("b"), pulumi: D("a") });
    const images = { pulumi: "ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0", plunge: "ghcr.io/intentius/plywood-plunge:0.3.0-plunge0.2.0" };
    const table = releaseImagePins({ images, version: "0.3.0", env: { [RELEASE_DIGESTS_ENV]: file, CHANT_RELEASE_LABEL: "0.3.0" } });
    expect(table).toEqual({ "ghcr.io/intentius/plywood-pulumi:0.3.0-pulumi3.272.0": D("a"), "ghcr.io/intentius/plywood-plunge:0.3.0-plunge0.2.0": D("b") });
    expect(Object.keys(table!)).toEqual(Object.values(images));

    const dir = scratch();
    const bundle = join(dir, "plywood.mjs");
    writeFileSync(bundle, `const digests = ${JSON.stringify(table)};\n`);
    const out = join(dir, "dist/image-digests.json");
    writeReleaseImagePins(table, { out, bundles: [bundle] });
    // The bytes both build-cli.mjs scripts wrote.
    expect(readFileSync(out, "utf-8")).toBe(`${JSON.stringify(table, null, 2)}\n`);
  });

  test("terragucci's table, for its four images", () => {
    const names = ["tofu", "terraform", "terragrunt", "choudoufu"];
    const file = digestsFile(Object.fromEntries(names.map((n, i) => [n, D(String(i + 1))])));
    const images = Object.fromEntries(names.map((n) => [n, `ghcr.io/intentius/terragucci-${n}:0.4.51-${n}`]));
    const table = releaseImagePins({ images, version: "0.4.51", env: { [RELEASE_DIGESTS_ENV]: file } })!;
    expect(Object.entries(table)).toEqual(names.map((n, i) => [`ghcr.io/intentius/terragucci-${n}:0.4.51-${n}`, D(String(i + 1))]));
  });

  test("a label that is not the version, a missing digest, and a bundle without the digests are refused", () => {
    const file = digestsFile({ pulumi: D("a"), plunge: "latest" });
    const code = (f: () => unknown) => {
      try {
        f();
        return "";
      } catch (e) {
        return `${(e as ReleaseImageError).code}: ${(e as Error).message}`;
      }
    };
    expect(code(() => releaseImagePins({ images: { pulumi: "r" }, version: "0.3.0", env: { [RELEASE_DIGESTS_ENV]: file, CHANT_RELEASE_LABEL: "0.3.1" } }))).toBe(
      "release-label-not-version: the release is labelled 0.3.1, and the package is at 0.3.0",
    );
    expect(code(() => releaseImagePins({ images: { plunge: "r" }, version: "0.3.0", env: { [RELEASE_DIGESTS_ENV]: file } }))).toBe(
      `release-image-digest-missing: ${file} has no digest for the plunge image, which the release builds`,
    );
    const dir = scratch();
    const bundle = join(dir, "b.mjs");
    writeFileSync(bundle, "nothing here\n");
    expect(code(() => writeReleaseImagePins({ "ghcr.io/x:1": D("a") }, { out: join(dir, "p.json"), bundles: [bundle] }))).toBe(`release-pin-not-bundled: ${bundle} does not carry ghcr.io/x:1@${D("a")}`);
    expect(existsSync(join(dir, "p.json"))).toBe(false);
  });

  test("plain Node loads the module a product's build script imports", () => {
    // The products' build-cli.mjs run under node with no TypeScript loader; the module must reach only node: built-ins at run time.
    const src = readFileSync(join(__dirname, "release-images.ts"), "utf-8");
    const runtime = [...src.matchAll(/^import (?!type)[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(runtime.filter((s) => !s!.startsWith("node:") && s !== "../release-floors")).toEqual([]);
    expect(spawnSync("node", ["--version"]).status).toBe(0);
  });
});
