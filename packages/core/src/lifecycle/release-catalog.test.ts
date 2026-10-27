/**
 * The release catalog model (#4595): the builder joins release, status,
 * changelog, consumer, attestation and engine-field inputs into one
 * validated catalog, `releaseVersion` round-trips through the ledger read,
 * and records without it still parse and are listed by digest.
 */
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../workspace/release-catalog.schema.json";
import { NEXT_RELEASE } from "../release-floors";
import { appendReleaseRecord, InvalidReleaseRecordError, readReleaseLedger, RELEASE_VERSION_FLOOR, type ReleaseRecord } from "./release-ledger";
import { parseReleaseLedger } from "./release-read";
import {
  buildReleaseCatalog,
  catalogVersion,
  parseReleaseCatalog,
  RELEASE_CATALOG_FLOOR,
  RELEASE_CATALOG_SCHEMA_ID,
  ReleaseCatalogError,
  validateReleaseCatalog,
} from "./release-catalog";

const rec = (over: Partial<ReleaseRecord>): ReleaseRecord => ({
  version: 1,
  component: "vpc/aws",
  env: "registry",
  digest: "sha256:aaa",
  gitSha: "1111111111111111111111111111111111111111",
  runId: "run-1",
  timestamp: "2026-10-01T00:00:00.000Z",
  actor: "ci",
  ...over,
});

const AT = { generatedAt: "2026-10-27T00:00:00.000Z", chant: "0.0.0-test" };

describe("release catalog schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.$id).toBe(RELEASE_CATALOG_SCHEMA_ID);
  });

  test("its floors are the next release", () => {
    expect(RELEASE_CATALOG_FLOOR).toBe(NEXT_RELEASE);
    expect(RELEASE_VERSION_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("buildReleaseCatalog", () => {
  const releases = [
    rec({ releaseVersion: "1.0.0", digest: "sha256:v1", timestamp: "2026-10-01T00:00:00.000Z" }),
    rec({ releaseVersion: "1.1.0", digest: "sha256:v11", timestamp: "2026-10-05T00:00:00.000Z" }),
    rec({ releaseVersion: "1.1.0", digest: "sha256:v11", env: "mirror", timestamp: "2026-10-06T00:00:00.000Z" }),
    rec({ releaseVersion: "2.0.0", digest: "sha256:v2", timestamp: "2026-10-10T00:00:00.000Z" }),
    rec({ component: "eks/aws", digest: "sha256:e1", timestamp: "2026-10-02T00:00:00.000Z" }),
  ];

  test("groups records by component and version, newest first, with every environment", () => {
    const c = buildReleaseCatalog({ releases }, AT);
    expect(c.$schema).toBe(RELEASE_CATALOG_SCHEMA_ID);
    expect(c.contract).toBe(1);
    expect(c.components.map((x) => x.name)).toEqual(["eks/aws", "vpc/aws"]);
    const vpc = c.components[1];
    expect(vpc.versions.map((v) => v.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(vpc.versions[1].envs).toEqual(["mirror", "registry"]);
    expect(vpc.versions[1].time).toBe("2026-10-05T00:00:00.000Z");
    expect(vpc.latest).toBe("2.0.0");
  });

  test("a record without a version is listed by its digest", () => {
    const c = buildReleaseCatalog({ releases }, AT);
    const eks = c.components[0];
    expect(eks.versions[0].version).toBeNull();
    expect(eks.latest).toBe("sha256:e1");
    expect(catalogVersion(c, "eks/aws", "sha256:e1")?.digest).toBe("sha256:e1");
  });

  test("the latest status wins, a restore is one more record, and latest skips what is not active", () => {
    const c = buildReleaseCatalog(
      {
        releases,
        statuses: [
          { component: "vpc/aws", digest: "sha256:v2", status: "yanked", reason: "drops a route", replacement: "1.1.0", actor: "ana", timestamp: "2026-10-11T00:00:00.000Z" },
          { component: "vpc/aws", digest: "sha256:v1", status: "deprecated", reason: "old", actor: "ana", timestamp: "2026-10-11T00:00:00.000Z" },
          { component: "vpc/aws", digest: "sha256:v11", status: "yanked", actor: "bo", timestamp: "2026-10-12T00:00:00.000Z" },
          { component: "vpc/aws", digest: "sha256:v11", status: "active", actor: "bo", timestamp: "2026-10-13T00:00:00.000Z" },
          { component: "vpc/aws", digest: "sha256:none", version: "9.9.9", status: "yanked", actor: "x", timestamp: "2026-10-13T00:00:00.000Z" },
        ],
      },
      AT,
    );
    const vpc = c.components[1];
    expect(vpc.versions[0].status).toEqual({ state: "yanked", reason: "drops a route", replacement: "1.1.0", actor: "ana", time: "2026-10-11T00:00:00.000Z" });
    expect(vpc.versions[1].status.state).toBe("active");
    expect(vpc.versions[1].status.actor).toBe("bo");
    expect(vpc.versions[2].status.state).toBe("deprecated");
    expect(vpc.latest).toBe("1.1.0");
  });

  test("a status naming only a version matches by version", () => {
    const c = buildReleaseCatalog({ releases, statuses: [{ component: "vpc/aws", digest: "sha256:other", version: "1.0.0", status: "deprecated", actor: "a", timestamp: "2026-10-20T00:00:00.000Z" }] }, AT);
    expect(catalogVersion(c, "vpc/aws", "1.0.0")?.status.state).toBe("deprecated");
  });

  test("joins changelogs, consumers, attestations and engine fields", () => {
    const c = buildReleaseCatalog(
      {
        releases,
        changelogs: [{ component: "vpc/aws", version: "2.0.0", bump: "major", entries: [{ kind: "breaking", sha: "abc", subject: "drop ipv4 default" }] }],
        consumers: [
          { component: "vpc/aws", version: "1.1.0", consumers: [{ repo: "acme/live", root: "prod", file: "prod/main.tf", address: "module.vpc" }] },
          { component: "vpc/aws", digest: "sha256:v11", consumers: [{ repo: "acme/live", root: "dev", file: "dev/main.tf", address: "module.vpc" }] },
        ],
        attestations: [{ component: "vpc/aws", digest: "sha256:v2", state: "signed", verify: "cosign verify-blob --bundle vpc.bundle vpc.tgz", identity: "ci@acme" }],
        fields: [
          { component: "vpc/aws", engine: "terraform", fields: { address: "registry.acme.dev/acme/vpc/aws" } },
          { component: "vpc/aws", version: "2.0.0", engine: "terraform", fields: { inputs: [{ name: "cidr", type: "string" }] } },
          { component: "missing", engine: "terraform", fields: { x: 1 } },
        ],
      },
      AT,
    );
    const vpc = c.components[1];
    expect(vpc.fields).toEqual({ terraform: { address: "registry.acme.dev/acme/vpc/aws" } });
    expect(vpc.versions[0].fields.terraform).toEqual({ inputs: [{ name: "cidr", type: "string" }] });
    expect(vpc.versions[0].changelog.bump).toBe("major");
    expect(vpc.versions[0].attestation).toEqual({ state: "signed", verify: "cosign verify-blob --bundle vpc.bundle vpc.tgz", identity: "ci@acme" });
    expect(vpc.versions[1].consumers.map((u) => u.root)).toEqual(["dev", "prod"]);
    expect(vpc.versions[2].attestation.state).toBe("unsigned");
    expect(c.components.find((x) => x.name === "missing")).toBeUndefined();
  });

  test("components narrows the catalog", () => {
    const c = buildReleaseCatalog({ releases, components: ["eks/aws"] }, AT);
    expect(c.components.map((x) => x.name)).toEqual(["eks/aws"]);
  });

  test("the result validates and parses back", () => {
    const c = buildReleaseCatalog({ releases }, AT);
    expect(validateReleaseCatalog(c)).toEqual([]);
    expect(parseReleaseCatalog(JSON.stringify(c))).toEqual(c);
  });

  test("parse refuses text that is not a catalog, and keeps fields it does not know", () => {
    expect(() => parseReleaseCatalog("{")).toThrow(ReleaseCatalogError);
    expect(() => parseReleaseCatalog({ contract: 1 })).toThrow(ReleaseCatalogError);
    const c = { ...buildReleaseCatalog({ releases }, AT), extra: true };
    expect((parseReleaseCatalog(c) as unknown as { extra: boolean }).extra).toBe(true);
  });
});

describe("releaseVersion on the release ledger", () => {
  test("old records without it still parse, and a bad value is dropped, not the record", () => {
    const old = JSON.stringify(rec({}));
    const bad = JSON.stringify({ ...rec({ digest: "sha256:b" }), releaseVersion: 7 });
    const good = JSON.stringify(rec({ digest: "sha256:c", releaseVersion: "1.2.3" }));
    const { records, malformed } = parseReleaseLedger([old, bad, good]);
    expect(malformed).toBe(0);
    expect(records.map((r) => r.releaseVersion)).toEqual([undefined, undefined, "1.2.3"]);
    expect("releaseVersion" in records[1]).toBe(false);
  });

  test("round-trips through append and read", async () => {
    await withTestDir(async (dir) => {
      const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "test@chant.dev"]);
      git(["config", "user.name", "Test"]);
      git(["config", "commit.gpgsign", "false"]);
      writeFileSync(join(dir, "README.md"), "fixture\n");
      git(["add", "README.md"]);
      git(["commit", "-q", "-m", "init"]);
      const { version: _v, ...input } = rec({ releaseVersion: "3.1.0" });
      await appendReleaseRecord(input, { cwd: dir });
      const { version: _w, releaseVersion: _r, ...plain } = rec({ digest: "sha256:old" });
      await appendReleaseRecord(plain, { cwd: dir });
      const { records } = await readReleaseLedger("registry", { cwd: dir });
      expect(records.map((r) => r.releaseVersion)).toEqual(["3.1.0", undefined]);
      const catalog = buildReleaseCatalog({ releases: records }, AT);
      expect(catalog.components[0].versions.map((v) => v.version ?? v.digest).sort()).toEqual(["3.1.0", "sha256:old"]);
    });
  });

  test("append refuses an empty version", async () => {
    const { version: _v, ...input } = rec({ releaseVersion: "" });
    await expect(appendReleaseRecord(input, { cwd: "/nonexistent" })).rejects.toThrow(InvalidReleaseRecordError);
  });
});
