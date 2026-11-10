/**
 * #4592: the Pulumi and plunge install lines take a version, check the
 * release checksums file against a recorded sum per architecture, install
 * under a versioned path and skip an engine already present. String checks
 * only; nothing is downloaded.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CI_SETUP_UNLINKED_FLOOR } from "@intentius/chant/lexicon";
import { CI_TOOL_DOCKER_ARCH, CI_TOOL_JOB_ARCH, CI_TOOL_SHA256, ciToolFetchScript } from "@intentius/chant/ci-image";
import {
  ciEngineDir,
  ciFetchScript,
  ciRelease,
  CI_DOCKER_ARCH,
  CI_ENGINE_ROOT,
  CI_JOB_ARCH,
  PULUMI_CI_SETUP_FLOOR,
  PINNED_SHA256,
  PLUNGE_CI_VERSION,
  plungeInstallLine,
  PULUMI_CI_VERSION,
  pulumiInstallLine,
  recordedSums,
} from "./ci-setup";

describe("ciRelease", () => {
  test("Pulumi's and plunge's archives and checksums files", () => {
    const p = ciRelease("pulumi", "3.272.0");
    expect(p.base).toBe("https://github.com/pulumi/pulumi/releases/download/v3.272.0");
    expect(p.archive("arm64")).toBe("pulumi-v3.272.0-linux-arm64.tar.gz");
    expect(p.checksums).toBe("pulumi-3.272.0-checksums.txt");
    const g = ciRelease("plunge", "0.1.0");
    expect(g.base).toBe("https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.1.0");
    expect(g.archive("x64")).toBe("plunge-v0.1.0-linux-x64.tar.gz");
    expect(g.checksums).toBe("plunge-v0.1.0-checksums.txt");
  });

  test("refuses a version a shell would read as more", () => {
    expect(() => ciRelease("pulumi", "3.272.0; curl evil")).toThrow(/not a release version/);
    expect(() => pulumiInstallLine("latest")).toThrow();
  });
});

describe("recordedSums", () => {
  test("the default releases are recorded for both architectures", () => {
    expect(Object.keys(recordedSums("pulumi", PULUMI_CI_VERSION))).toEqual(["x64", "arm64"]);
    expect(Object.keys(recordedSums("plunge", PLUNGE_CI_VERSION))).toEqual(["x64", "arm64"]);
    expect(recordedSums("pulumi", PULUMI_CI_VERSION).x64).toBe(PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]);
  });

  test("an unrecorded release has none, and the caller's sums replace the table", () => {
    expect(recordedSums("pulumi", "3.300.0")).toEqual({});
    expect(recordedSums("pulumi", "3.300.0", { x64: "a".repeat(64) })).toEqual({ x64: "a".repeat(64) });
    expect(() => recordedSums("pulumi", "3.300.0", { x64: "nope" })).toThrow(/64 lower-case hex/);
  });
});

describe("pulumiInstallLine", () => {
  const line = pulumiInstallLine();

  test("installs the default version under a versioned path and links it", () => {
    expect(line).toContain(`${CI_ENGINE_ROOT}/pulumi-${PULUMI_CI_VERSION}`);
    expect(line).toContain(`ln -sf "${CI_ENGINE_ROOT}/pulumi-${PULUMI_CI_VERSION}/pulumi" /usr/local/bin/pulumi`);
    expect(line).not.toContain("get.pulumi.com");
  });

  test("checks the checksums file, then the recorded sum per architecture, then the archive", () => {
    expect(line).toContain(`/pulumi-${PULUMI_CI_VERSION}-checksums.txt"`);
    expect(line).toContain(`(amd64) want=${PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]} ;;`);
    expect(line).toContain(`(arm64) want=${PINNED_SHA256["pulumi-v3.272.0-linux-arm64.tar.gz"]} ;;`);
    expect(line).toContain("sha256sum -c -");
    expect(line.indexOf("want=")).toBeLessThan(line.indexOf("sha256sum -c"));
  });

  test("skips when the pulumi on PATH is that version, or the versioned directory holds it", () => {
    expect(line.startsWith(`{ command -v pulumi >/dev/null 2>&1 && [ "$(pulumi version 2>/dev/null)" = "v${PULUMI_CI_VERSION}" ]; } || `)).toBe(true);
    expect(line).toContain(`[ -x "${CI_ENGINE_ROOT}/pulumi-${PULUMI_CI_VERSION}/pulumi" ] || (set -e;`);
  });

  test("another version, unrecorded, checks only the checksums file", () => {
    const other = pulumiInstallLine("3.300.0");
    expect(other).toContain("/opt/chant/pulumi-3.300.0");
    expect(other).toContain('case "$a" in  (*) want= ;; esac');
    expect(other).not.toContain("(amd64) want=");
  });

  test("a product's root and sums", () => {
    const own = pulumiInstallLine("3.272.0", { root: "/opt/plywood", sha256: { x64: "b".repeat(64) } });
    expect(own).toContain('"/opt/plywood/pulumi-3.272.0/pulumi"');
    expect(own).toContain(`(amd64) want=${"b".repeat(64)} ;;`);
    expect(own).not.toContain("(arm64) want=");
    expect(() => pulumiInstallLine("3.272.0", { root: "relative/dir" })).toThrow(/absolute/);
  });
});

describe("plungeInstallLine", () => {
  test("installs plunge's release under a versioned path, checked, skipping on the directory alone", () => {
    const line = plungeInstallLine();
    expect(line.startsWith(`{ [ -x "${CI_ENGINE_ROOT}/plunge-${PLUNGE_CI_VERSION}/plunge" ] || (set -e;`)).toBe(true);
    expect(line).toContain(`plunge-v${PLUNGE_CI_VERSION}-checksums.txt`);
    expect(line).toContain(`(amd64) want=${PINNED_SHA256["plunge-v0.1.0-linux-x64.tar.gz"]} ;;`);
    expect(line).toContain("--strip-components=1");
    expect(line).toContain(`ln -sf "${ciEngineDir("plunge", PLUNGE_CI_VERSION)}/plunge" /usr/local/bin/plunge`);
    expect(line).not.toContain("plunge version");
  });
});

describe("pulumi-up's pinned binary (#4592)", () => {
  test("engineVersion runs the binary at the install lines' versioned path", async () => {
    const { pulumiUpEngineBin } = await import("./pulumi-up");
    expect(pulumiUpEngineBin({ engineVersion: "3.272.0" }, "pulumi")).toBe("/opt/chant/pulumi-3.272.0/pulumi");
    expect(pulumiUpEngineBin({ engineVersion: "0.1.0", engineRoot: "/opt/plywood" }, "plunge")).toBe("/opt/plywood/plunge-0.1.0/plunge");
    expect(pulumiInstallLine("3.272.0")).toContain(`"${pulumiUpEngineBin({ engineVersion: "3.272.0" }, "pulumi")}"`);
    expect(plungeInstallLine("0.1.0", { root: "/opt/plywood" })).toContain(`"${pulumiUpEngineBin({ engineVersion: "0.1.0", engineRoot: "/opt/plywood" }, "plunge")}"`);
  });

  test("absent, PATH; a bad version or a root alone is refused", async () => {
    const { pulumiUpEngineBin } = await import("./pulumi-up");
    expect(pulumiUpEngineBin({}, "pulumi")).toBeUndefined();
    expect(() => pulumiUpEngineBin({ engineVersion: "3.272.0; id" }, "pulumi")).toThrow(/pulumi-up/);
    expect(() => pulumiUpEngineBin({ engineRoot: "/opt/plywood" }, "pulumi")).toThrow(/engineVersion/);
  });

  test("engineRunnerAt refuses a relative binary", async () => {
    const { engineRunnerAt } = await import("./run");
    expect(() => engineRunnerAt("pulumi")).toThrow(/absolute/);
  });
});

// #4814: a second release beside the linked one, and the fetch script for image builds.
describe("an unlinked install line (#4814)", () => {
  test("installs under the versioned path and never touches PATH", () => {
    for (const line of [pulumiInstallLine("3.250.0", { root: "/opt/plywood", link: false }), plungeInstallLine("0.2.0", { root: "/opt/plywood", link: false })]) {
      expect(line).not.toContain("/usr/local/bin");
      expect(line).not.toContain("ln -s");
    }
  });

  test("skips on the versioned directory alone, not on the pulumi that PATH finds", () => {
    const line = pulumiInstallLine("3.250.0", { root: "/opt/plywood", link: false });
    expect(line.startsWith('[ -x "/opt/plywood/pulumi-3.250.0/pulumi" ] || (set -e; ')).toBe(true);
    expect(line).not.toContain("command -v pulumi");
    expect(line).not.toContain("pulumi version");
    expect(line.endsWith(")")).toBe(true);
  });

  test("is the fetch script under the job's architecture, so plywood's unlinkedInstallLine is this call", () => {
    const sums = { x64: "c".repeat(64), arm64: "d".repeat(64) };
    expect(plungeInstallLine("0.2.0", { root: "/opt/plywood", sha256: sums, link: false })).toBe(
      `[ -x "/opt/plywood/plunge-0.2.0/plunge" ] || (set -e; ${ciFetchScript("plunge", "0.2.0", { dir: "/opt/plywood/plunge-0.2.0", sha256: sums })})`,
    );
  });

  test("a linked line is the one it was", () => {
    expect(pulumiInstallLine()).toBe(pulumiInstallLine(PULUMI_CI_VERSION, { link: true }));
    expect(pulumiInstallLine().startsWith("{ command -v pulumi")).toBe(true);
  });
});

describe("ciFetchScript (#4814)", () => {
  test("takes the target directory, an arch expression and a checksums URL word", () => {
    const s = ciFetchScript("pulumi", "3.272.0", { dir: "/out/opt/plywood/pulumi-3.272.0", arch: CI_DOCKER_ARCH, checksumsUrl: '"$CHECKSUMS_URL"' });
    // #4908: ci-image's script, which reads the Docker build's architecture as amd64 or arm64.
    expect(s.startsWith(`a=${CI_TOOL_DOCKER_ARCH} && `)).toBe(true);
    expect(CI_DOCKER_ARCH).toBe(`"$(case "$TARGETARCH" in (arm64) echo arm64 ;; (*) echo x64 ;; esac)"`);
    expect(s).toContain('curl -fsSLo "$t/sums" "$CHECKSUMS_URL"');
    expect(s).toContain('tar -xzf "$t/$f" -C "/out/opt/plywood/pulumi-3.272.0" --strip-components=1');
    expect(s).toContain(`(amd64) want=${PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]} ;;`);
  });

  test("defaults to the job's architecture and the release's own checksums file", () => {
    const s = ciFetchScript("plunge", "0.1.0", { dir: "/opt/chant/plunge-0.1.0" });
    expect(s.startsWith(`a=${CI_TOOL_JOB_ARCH} && `)).toBe(true);
    expect(CI_JOB_ARCH).toBe(`"$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"`);
    expect(s).toContain('curl -fsSLo "$t/sums" "https://github.com/INTENTIUS/plunge/releases/download/plunge-v0.1.0/plunge-v0.1.0-checksums.txt"');
    expect(() => ciFetchScript("plunge", "0.1.0", { dir: "relative" })).toThrow(/absolute/);
  });

  test.skipIf(!["sha256sum", "tar", "sh"].every((b) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0))(
    "run: installs a release whose sum matches, and refuses a tampered checksums file",
    () => {
      const work = mkdtempSync(join(tmpdir(), "chant-ci-fetch-"));
      const served = join(work, "served");
      mkdirSync(join(served, "src", "pulumi"), { recursive: true });
      writeFileSync(join(served, "src", "pulumi", "pulumi"), "#!/bin/sh\necho v3.272.0\n");
      chmodSync(join(served, "src", "pulumi", "pulumi"), 0o755);
      const archive = "pulumi-v3.272.0-linux-x64.tar.gz";
      execFileSync("tar", ["-czf", join(served, archive), "-C", join(served, "src"), "pulumi"]);
      const sum = createHash("sha256").update(readFileSync(join(served, archive))).digest("hex");
      writeFileSync(join(served, "pulumi-3.272.0-checksums.txt"), `${sum}  ${archive}\n`);
      writeFileSync(join(served, "tampered.txt"), `${"0".repeat(64)}  ${archive}\n`);
      // curl -fsSLo <out> <url>: serve the file the URL names from the served directory.
      const bin = join(work, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "curl"), `#!/bin/sh\ncp "${served}/$(basename "$3")" "$2"\n`);
      chmodSync(join(bin, "curl"), 0o755);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const run = (script: string) => spawnSync("sh", ["-c", `set -e; ${script}`], { env, encoding: "utf8" });

      const dir = join(work, "opt", "pulumi-3.272.0");
      const ok = run(ciFetchScript("pulumi", "3.272.0", { dir, arch: '"x64"', sha256: { x64: sum } }));
      expect(ok.stderr).toBe("");
      expect(ok.status).toBe(0);
      expect(existsSync(join(dir, "pulumi"))).toBe(true);

      const tampered = run(ciFetchScript("pulumi", "3.272.0", { dir: join(work, "t"), arch: '"x64"', checksumsUrl: '"https://example.test/tampered.txt"', sha256: { x64: sum } }));
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain(`lists ${"0".repeat(64)} for ${archive}; chant records ${sum}`);
    },
  );

  test("is ci-image's fetch script, and the pins are ci-image's (#4908)", () => {
    const sums = { x64: "e".repeat(64), arm64: "f".repeat(64) };
    expect(ciFetchScript("pulumi", "3.272.0", { dir: "/out/p", arch: CI_DOCKER_ARCH, sha256: sums, checksumsUrl: '"$U"' })).toBe(
      ciToolFetchScript("pulumi", "3.272.0", { dir: "/out/p", arch: CI_TOOL_DOCKER_ARCH, sha256: { amd64: sums.x64, arm64: sums.arm64 }, checksumsUrl: '"$U"' }),
    );
    expect(ciFetchScript("plunge", "0.2.0", { dir: "/out/g" })).toBe(ciToolFetchScript("plunge", "0.2.0", { dir: "/out/g" }));
    expect(PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]).toBe(CI_TOOL_SHA256["pulumi-3.272.0-linux-amd64"]);
    expect(PINNED_SHA256["plunge-v0.2.0-linux-arm64.tar.gz"]).toBe(CI_TOOL_SHA256["plunge-0.2.0-linux-arm64"]);
    // plywood's pinnedSums, which turned ci-image's sums into these words, is this call.
    expect(recordedSums("plunge", "0.2.0")).toEqual({ x64: CI_TOOL_SHA256["plunge-0.2.0-linux-amd64"], arm64: CI_TOOL_SHA256["plunge-0.2.0-linux-arm64"] });
  });

  test("the floor names the next release", () => {
    expect(PULUMI_CI_SETUP_FLOOR).toBe(CI_SETUP_UNLINKED_FLOOR);
    expect(CI_SETUP_UNLINKED_FLOOR).toBe("0.124.78");
  });
});
