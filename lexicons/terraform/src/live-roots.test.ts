/**
 * chant#4910: live roots and estates read from a root's files, the setup
 * `choudoufu live-check -json` resolves (through a fake exec), and the bucket
 * check's target for a resolved store. Nothing runs choudoufu or reaches a
 * bucket.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bucketLines, bucketTarget, checkStoreBucket, estateOf, forgetLiveSetups, liveRoots, parseLiveSetup, readLiveSetup, resolvedEstate, setupLine } from "./live-roots";
import type { BinaryExec } from "./state/exec";

afterEach(() => forgetLiveSetups());

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-live-roots-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("liveRoots and estateOf (chant#4910)", () => {
  const dir = repo({
    "envs/plain/main.tf": 'terraform {\n  backend "s3" {}\n}\n',
    "envs/block/main.tf": 'terraform {\n  live {\n    estate = "prod"\n  }\n}\n\ndata "terraform_estate_outputs" "net" {\n  estate = "network"\n}\n',
    "envs/unnamed/main.tf": "terraform {\n  live {}\n}\n",
    "envs/sidecar/main.tf": "",
    "envs/sidecar/estate.chdf.hcl": 'estate = "side"\n',
    "envs/json/main.tf.json": JSON.stringify({ terraform: [{ live: [{ estate: "js" }] }], data: { terraform_estate_outputs: { up: { estate: "upstream" } } } }),
    "envs/commented/main.tf": '# terraform {\n#   live {}\n# }\ndata "terraform_estate_outputs" "x" {\n  # estate = "ignored"\n  estate = "kept"\n}\n',
  });

  test("a live block, named or not, an estate sidecar, and a JSON live block make a live root; a commented one does not", () => {
    expect(liveRoots(dir, ["envs/plain", "envs/block", "envs/unnamed", "envs/sidecar", "envs/json", "envs/commented"])).toEqual(["envs/block", "envs/unnamed", "envs/sidecar", "envs/json"]);
  });

  test("a root's estate and the estates whose outputs it reads", () => {
    expect(estateOf(join(dir, "envs/block"))).toEqual({ estate: "prod", reads: ["network"] });
    expect(estateOf(join(dir, "envs/sidecar"))).toEqual({ estate: "side", reads: [] });
    expect(estateOf(join(dir, "envs/json"))).toEqual({ estate: "js", reads: ["upstream"] });
    expect(estateOf(join(dir, "envs/commented"))).toEqual({ reads: ["kept"] });
    expect(estateOf(join(dir, "envs/unnamed"))).toEqual({ reads: [] });
  });
});

const LIVE_CHECK = JSON.stringify({ estate: "prod", estate_source: "backend_key", record_store: { kind: "s3", bucket: "acme-records", prefix: "tofu-records/prod/", source: "backend", declared_at: "main.tf:2" } });

describe("the setup choudoufu resolves (chant#4910)", () => {
  test("live-check's estate and store are read once per directory, and win over the files' estate", async () => {
    const dir = repo({ "r/main.tf": 'terraform {\n  live {\n    estate = "written"\n  }\n}\n' });
    const calls: string[][] = [];
    const exec: BinaryExec = async (bin, args) => (calls.push([bin, ...args]), { code: 1, stdout: LIVE_CHECK, out: LIVE_CHECK });
    expect(resolvedEstate(join(dir, "r"))).toBe("written");
    const setup = await readLiveSetup(join(dir, "r"), { exec });
    await readLiveSetup(join(dir, "r"), { exec });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(["choudoufu", "live-check", "-json"]);
    expect(setup).toEqual({ estate: "prod", estateSource: "backend_key", store: { kind: "s3", bucket: "acme-records", prefix: "tofu-records/prod/", source: "backend", declaredAt: "main.tf:2" } });
    expect(resolvedEstate(join(dir, "r"))).toBe("prod");
    expect(setupLine("r", setup!)).toBe('r: records in s3 bucket "acme-records" under tofu-records/prod/ (derived from its backend block at main.tf:2); estate "prod" (from the backend key)');
  });

  test("a release that prints no estate_source gives no setup", () => {
    expect(parseLiveSetup(JSON.stringify({ estate: "prod" }))).toBeUndefined();
    expect(parseLiveSetup("not json")).toBeUndefined();
  });

  test("the bucket check's target, or why there is none", async () => {
    const s3 = parseLiveSetup(LIVE_CHECK)!.store!;
    expect(bucketTarget(s3, { region: "eu-west-1" }, {})).toEqual({ target: { store: "s3", bucket: "acme-records", region: "eu-west-1" } });
    expect(bucketTarget(s3, {}, {})).toEqual({ skip: "no region: set region in the backend block or AWS_REGION" });
    expect(bucketTarget({ ...s3, kind: "azurerm", bucket: "acct/records" }, {}, {})).toMatchObject({ skip: expect.stringContaining("resource group") });
    const checked = await checkStoreBucket(s3, { region: "eu-west-1" }, {}, async (t) => ({ store: t.store, bucket: "acme-records", correct: true, settings: [{ setting: "versioning", verdict: "ok", found: "Enabled" }] }) as never);
    expect(bucketLines("r", checked)).toEqual(["r: bucket acme-records has every setting choudoufu needs (versioning)"]);
    expect(await checkStoreBucket({ ...s3, kind: "local" })).toEqual({ skipped: "the local store has no bucket" });
  });
});
