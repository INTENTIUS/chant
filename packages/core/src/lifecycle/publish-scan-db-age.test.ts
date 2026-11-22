/**
 * A publish under a scanner database bound (#5464): `release.scan.dbMaxAgeHours`
 * or a security profile's hours. A database built longer ago than the bound,
 * or one whose build time the scanner can't say, refuses the publish with
 * `publish-scan-db-stale` before anything stages. The scanner is a fake.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import type { ScanContext } from "./publish-scan";
import { createPublishTargets } from "./publish-targets";
import { runPublish, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { writePackage } from "./__fixtures__/publish-fakes";
import { fakeReleaseScanner } from "./__fixtures__/scan-fakes";
import { scanDatabaseBound } from "../workspace/security-profiles";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-11-21T12:00:00Z");

async function publish(built: string | undefined, dbAge: ScanContext["dbAge"]) {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-db-age-"));
  dirs.push(dir);
  writePackage(join(dir, "pkg"), "@acme/core", "1.4.0", false, { "left-pad": "^1.3.0" });
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "acme", lockfileVersion: 3, packages: { "": { name: "acme" }, "node_modules/left-pad": { version: "1.3.1" } } }));
  const targets = await createPublishTargets([PublishDeclarationSchema.parse({ type: "npm", packages: ["pkg"] })], { npm: join(dir, "no-npm-here") });
  const scanner = { ...fakeReleaseScanner(), database: async () => ({ version: "v6.0.2", ...(built ? { built } : {}) }) };
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [] as ReleaseArtifact[], targets: [{ env: "dev", params: [], templates: [] }] });
  const ctx: PublishContext = { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: true, ci: "github", reason: "" }, cwd: dir, tag: null, env: {}, redactor: createRedactor({}), log: () => undefined, scan: { scanner, policy: {}, vex: [], ...(dbAge ? { dbAge } : {}) } };
  return runPublish({ cwd: dir, release, label: ctx.label, targets, ctx, record: false, now: () => NOW }).catch((e: unknown) => e as Error & { code: string; step: string; staged: string[] });
}

describe("the scanner database's age at publish", () => {
  test("under fedramp-moderate a database built 30 hours before the scan refuses the publish before anything stages", async () => {
    const err = await publish("2026-11-20T06:00:00Z", scanDatabaseBound(undefined, ["fedramp-moderate"]));
    expect(err).toMatchObject({ code: "publish-scan-db-stale", step: "scan", staged: [] });
    expect((err as Error).message).toContain("30 hours before the scan, and the fedramp-moderate security profile takes one no older than 24 hours");
  });

  test("a database built 6 hours before passes the scan, and the publish goes on to the stage", async () => {
    const err = await publish("2026-11-21T06:00:00Z", scanDatabaseBound(undefined, ["fedramp-moderate"]));
    expect(err).toMatchObject({ step: "stage" });
  });

  test("a scanner that can't say when its database was built is refused under a bound", async () => {
    expect(await publish(undefined, scanDatabaseBound(undefined, ["cccs-medium"]))).toMatchObject({ code: "publish-scan-db-stale", step: "scan" });
  });

  test("with no bound, the database's age refuses nothing", async () => {
    expect(await publish("2025-01-01T00:00:00Z", null)).toMatchObject({ step: "stage" });
  });

  test("release.scan.dbMaxAgeHours bounds it without a profile", async () => {
    expect(await publish("2026-11-21T00:00:00Z", scanDatabaseBound(6, []))).toMatchObject({ code: "publish-scan-db-stale", message: expect.stringContaining("release.scan.dbMaxAgeHours takes one no older than 6 hours") });
  });
});
