/**
 * A live root's record store resolved through chant (chant#4954):
 * choudoufu's resolved store when `live-check -json` was read, else the
 * `record_store` block the files write, and the backend block's strings for
 * an s3 store's region and the bucket check.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { forgetLiveSetups, liveBlockText, liveRecordStore, rememberLiveSetup, rootBackendAttrs, writtenRecordStore } from "./live-roots";

afterEach(() => forgetLiveSetups());

/** A root directory holding `files`. */
function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-record-store-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const S3_BACKEND = 'terraform {\n  backend "s3" {\n    bucket = "state"\n    region = "eu-west-1"\n    encrypt = true\n  }\n}\n';

describe("the store a root's files write", () => {
  test("an s3 record_store block, its key_prefix, bucket and region", () => {
    const dir = root({
      "main.tf": 'terraform {\n  live {\n    estate = "prod"\n    # record_store "local" {}\n    record_store "s3" {\n      bucket = "records"\n      region = "us-east-2"\n      key_prefix = "custom/prod"\n    }\n  }\n}\n',
    });
    expect(writtenRecordStore(dir, "prod")).toEqual({ kind: "s3", bucket: "records", prefix: "custom/prod/", region: "us-east-2" });
  });

  test("no record_store block is the local store beside the root, under tofu-records/<estate>/", () => {
    const dir = root({ "estate.chdf.hcl": 'estate = "dev"\n' });
    expect(writtenRecordStore(dir, "dev")).toEqual({ kind: "local", dir: join(dir, ".tofu-records"), prefix: "tofu-records/dev/" });
    expect(liveBlockText(dir)).toContain('estate = "dev"');
  });

  test("an s3 store with no bucket, and a kind it does not read, are unread", () => {
    expect(writtenRecordStore(root({ "main.tf": 'terraform {\n  live {\n    record_store "s3" {\n    }\n  }\n}\n' }), "e")).toEqual({ kind: "unread", name: "s3" });
    expect(writtenRecordStore(root({ "main.tf": 'terraform {\n  live {\n    record_store "kubernetes" {\n      namespace = "x"\n    }\n  }\n}\n' }), "e")).toEqual({ kind: "unread", name: "kubernetes" });
  });

  test("a root with no live block has no store", () => {
    const dir = root({ "main.tf": S3_BACKEND });
    expect(writtenRecordStore(dir, "e")).toBeUndefined();
    expect(liveRecordStore(dir, "e")).toBeUndefined();
  });
});

describe("the store choudoufu resolved", () => {
  test("wins over the files, an s3 store taking its region from the backend block", () => {
    const dir = root({ "main.tf": 'terraform {\n  live {\n    estate = "prod"\n  }\n}\n', "backend.tf": S3_BACKEND });
    rememberLiveSetup(dir, { estate: "prod", estateSource: "explicit", store: { kind: "s3", bucket: "state", prefix: "tofu-records/prod/", source: "backend" } });
    expect(liveRecordStore(dir, "prod")).toEqual({ kind: "s3", bucket: "state", prefix: "tofu-records/prod/", region: "eu-west-1" });
  });

  test("a resolved local store is a directory under the root, and another kind is unread", () => {
    const dir = root({ "main.tf": 'terraform {\n  live {\n  }\n}\n' });
    rememberLiveSetup(dir, { estateSource: "root_path", store: { kind: "local", bucket: "", prefix: "tofu-records/x/", source: "implied" } });
    expect(liveRecordStore(dir, "x")).toEqual({ kind: "local", dir: join(dir, ".tofu-records"), prefix: "tofu-records/x/" });
    forgetLiveSetups();
    rememberLiveSetup(dir, { estateSource: "root_path", store: { kind: "gcs", bucket: "b", prefix: "p/", source: "backend" } });
    expect(liveRecordStore(dir, "x")).toEqual({ kind: "unread", name: "gcs" });
  });
});

describe("the backend block's strings", () => {
  test("are its plain string attributes, and none for a cloud block or no backend", () => {
    expect(rootBackendAttrs(root({ "main.tf": S3_BACKEND }))).toEqual({ bucket: "state", region: "eu-west-1" });
    expect(rootBackendAttrs(root({ "main.tf": 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n' }))).toEqual({});
    expect(rootBackendAttrs(root({ "main.tf": 'resource "x" "y" {}\n' }))).toEqual({});
  });
});
