import { describe, expect, test } from "vitest";
import {
  POSTGRES_LATEST_MAJOR,
  POSTGRES_MAJORS,
  POSTGRES_PINS,
  postgresImage,
  postgresUpstreamPin,
  versionFromReleaseTag,
} from "./postgres-pin";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pinFile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "postgres-pin.ts"), "utf-8");

describe("the Postgres pins", () => {
  test("one pin per supported major, 14 to 18, each an exact minor with an image digest", () => {
    expect(POSTGRES_MAJORS).toEqual([14, 15, 16, 17, 18]);
    expect(POSTGRES_LATEST_MAJOR).toBe(18);
    expect(POSTGRES_PINS.map((p) => p.version)).toEqual(["14.24", "15.19", "16.15", "17.11", "18.6"]);
    for (const p of POSTGRES_PINS) {
      expect(p.version.startsWith(`${p.major}.`)).toBe(true);
      expect(p.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("the image is the tag and the digest together", () => {
    expect(postgresImage(18)).toBe(
      "postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722",
    );
    expect(() => postgresImage(13)).toThrow(/not a supported major/);
  });
});

describe("the upstream pins", () => {
  test("a git tag maps to the version; betas, release candidates and old spellings are skipped", () => {
    expect(versionFromReleaseTag("REL_18_6")).toBe("18.6");
    expect(versionFromReleaseTag("REL_17_11")).toBe("17.11");
    for (const tag of ["REL_18_BETA1", "REL_18_RC1", "REL9_6_24", "Release_2_0"]) {
      expect(versionFromReleaseTag(tag)).toBeNull();
    }
  });

  test.each(POSTGRES_PINS.map((p) => [p.major, p.version] as const))("the %i pin finds its own line and writes the new version back", (major, version) => {
    const pin = postgresUpstreamPin(major);
    const line = pinFile.split("\n").find((l) => pin.pattern.test(l));
    expect(line).toBeDefined();
    expect(pin.pattern.exec(line!)?.[1]).toBe(version);
    const next = pin.replace("REL_99_9", line!);
    expect(next).toContain('version: "99.9"');
    expect(next).toContain(`major: ${major},`);
    expect(next).toContain("digest:");
    expect(pin.upstream).toMatchObject({ owner: "postgres", repo: "postgres", kind: "tags", trackMajor: true });
    expect(pin.upstream.tagVersion?.("REL_18_6")).toBe("18.6");
    expect(pin.alsoMoves).toContain(`postgres-catalog-${major}.snapshot.json`);
  });

  test("no pattern matches another major's line", () => {
    for (const p of POSTGRES_PINS) {
      const matching = pinFile.split("\n").filter((l) => postgresUpstreamPin(p.major).pattern.test(l));
      expect(matching).toHaveLength(1);
    }
  });
});
