/**
 * An s3 state's lock against floci (#4437): a real lock object taken, a
 * state written under it, and the lock released. Set CHANT_FLOCI_ENDPOINT to
 * a running floci, for example `docker run -d -p 4611:4566 floci/floci` and
 * `CHANT_FLOCI_ENDPOINT=http://localhost:4611`. Skipped without it.
 *
 * The binary is faked: its `state push` puts the state object in the bucket
 * the way the s3 backend does, after checking the lock object is there.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BinaryExec, StateFile } from "./exec";
import { RootStates, UNWRITTEN_SUFFIX } from "./root-states";
import { S3Client, sign } from "./s3";

const endpoint = process.env.CHANT_FLOCI_ENDPOINT?.replace(/\/+$/, "");

describe.skipIf(!endpoint)("an s3 state's lock against floci (#4437)", () => {
  const bucket = `chant-state-${process.pid}-${Date.now()}`;
  const creds = { region: "us-east-1", accessKeyId: "test", secretAccessKey: "test" };
  const env = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1" };
  const client = new S3Client({ bucket, endpoint: endpoint!, ...creds });
  const state: StateFile = { version: 4, terraform_version: "1.10.0", serial: 3, lineage: "floci-lineage", outputs: {}, resources: [] };
  let dir: string;

  beforeAll(async () => {
    const url = `${endpoint}/${bucket}`;
    const res = await fetch(url, { method: "PUT", headers: sign(creds, "PUT", url, {}, createHash("sha256").update("").digest("hex"), new Date()) });
    expect(res.ok).toBe(true);
    dir = join(mkdtempSync(join(tmpdir(), "chant-floci-")), "app");
    mkdirSync(join(dir, ".terraform"), { recursive: true });
    writeFileSync(join(dir, ".terraform/terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "s3", config: { bucket, key: "app.tfstate", region: "us-east-1", use_lockfile: true, endpoints: { s3: endpoint } } } }));
  });

  afterAll(async () => {
    for (const k of ["app.tfstate", "app.tfstate.tflock", `app.tfstate${UNWRITTEN_SUFFIX}`]) await client.remove(k).catch(() => {});
  });

  it("takes the lock object, writes the state under it, and releases it", async () => {
    const lockAtPush: (string | undefined)[] = [];
    const exec: BinaryExec = async (_bin, args) => {
      if (args[0] === "state" && args[1] === "push") {
        lockAtPush.push(await client.get("app.tfstate.tflock"));
        await client.put("app.tfstate", readFileSync(args.at(-1)!, "utf-8"), "application/json");
        return { code: 0, stdout: "", out: "" };
      }
      if (args[0] === "state" && args[1] === "pull") return { code: 0, stdout: (await client.get("app.tfstate")) ?? "", out: "" };
      return { code: 1, stdout: "", out: "unexpected" };
    };
    const states = new RootStates({ roots: [{ root: "app", dir, env }], binary: "tofu", exec, work: mkdtempSync(join(tmpdir(), "chant-floci-work-")), reportDir: mkdtempSync(join(tmpdir(), "chant-floci-report-")), runId: "floci-1" });
    await states.take();
    const lock = await client.get("app.tfstate.tflock");
    expect(JSON.parse(lock!)).toMatchObject({ Operation: "chant terraform.compose", Info: expect.stringContaining("(run floci-1)"), Path: `${bucket}/app.tfstate` });
    // A second run finds the real lock object held.
    const other = new RootStates({ roots: [{ root: "app", dir, env }], binary: "tofu", exec, work: mkdtempSync(join(tmpdir(), "chant-floci-work-")), reportDir: mkdtempSync(join(tmpdir(), "chant-floci-report-")) });
    await expect(other.take()).rejects.toThrow("its state is locked at s3://");
    expect(await states.write("app", state)).toEqual({ written: true, attempts: 1 });
    expect(lockAtPush).toEqual([lock]);
    expect(await states.pull("app")).toMatchObject({ lineage: "floci-lineage", serial: 3 });
    await states.release();
    expect(await client.get("app.tfstate.tflock")).toBeUndefined();
  });
});
