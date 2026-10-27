/**
 * #4592: the Pulumi and plunge install lines take a version, check the
 * release checksums file against a recorded sum per architecture, install
 * under a versioned path and skip an engine already present. String checks
 * only; nothing is downloaded.
 */

import { describe, expect, test } from "vitest";
import {
  ciEngineDir,
  ciRelease,
  CI_ENGINE_ROOT,
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
    expect(() => recordedSums("pulumi", "3.300.0", { x64: "nope" })).toThrow(/64 hex/);
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
    expect(line).toContain(`x64) want=${PINNED_SHA256["pulumi-v3.272.0-linux-x64.tar.gz"]} ;;`);
    expect(line).toContain(`arm64) want=${PINNED_SHA256["pulumi-v3.272.0-linux-arm64.tar.gz"]} ;;`);
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
    expect(other).toContain("want= &&");
    expect(other).not.toContain("x64) want=");
  });

  test("a product's root and sums", () => {
    const own = pulumiInstallLine("3.272.0", { root: "/opt/plywood", sha256: { x64: "b".repeat(64) } });
    expect(own).toContain('"/opt/plywood/pulumi-3.272.0/pulumi"');
    expect(own).toContain(`x64) want=${"b".repeat(64)} ;;`);
    expect(own).not.toContain("arm64) want=");
    expect(() => pulumiInstallLine("3.272.0", { root: "relative/dir" })).toThrow(/absolute/);
  });
});

describe("plungeInstallLine", () => {
  test("installs plunge's release under a versioned path, checked, skipping on the directory alone", () => {
    const line = plungeInstallLine();
    expect(line.startsWith(`{ [ -x "${CI_ENGINE_ROOT}/plunge-${PLUNGE_CI_VERSION}/plunge" ] || (set -e;`)).toBe(true);
    expect(line).toContain(`plunge-v${PLUNGE_CI_VERSION}-checksums.txt`);
    expect(line).toContain(`x64) want=${PINNED_SHA256["plunge-v0.1.0-linux-x64.tar.gz"]} ;;`);
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
