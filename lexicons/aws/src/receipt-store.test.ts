import { describe, it, expect } from "vitest";
import { awsReceiptStore, observeReceiptRows, ssmGetParameter, ssmPutParameter } from "./receipt-store";
import { EFFECT_RECEIPTS_METADATA_KEY } from "./effect-receipt-row";
import { receiptActivities, type EffectReceiptRef } from "@intentius/chant/op/receipt-store";
import type { AwsReadHttp } from "./api/read-client";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** A directory with no chant.config.ts anywhere upward. */
const bareDir = mkdtempSync(join(tmpdir(), "chant-receipt-store-"));

interface Call {
  url: string;
  target: string;
  body: Record<string, unknown>;
}

/** Fake SSM endpoint: records calls, answers from a name → value map. */
function fakeSsm(parameters: Record<string, string>, opts?: { failReads?: boolean }) {
  const calls: Call[] = [];
  const http: AwsReadHttp = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const target = init.headers["x-amz-target"] ?? "";
    calls.push({ url, target: target.replace(/^AmazonSSM\./, ""), body });
    if (target.endsWith("GetParameter")) {
      if (opts?.failReads) return { status: 500, text: JSON.stringify({ __type: "InternalServerError" }) };
      const value = parameters[body.Name as string];
      if (value === undefined) {
        return { status: 400, text: JSON.stringify({ __type: "ParameterNotFound" }) };
      }
      return { status: 200, text: JSON.stringify({ Parameter: { Name: body.Name, Value: value } }) };
    }
    if (target.endsWith("PutParameter")) {
      if (parameters[body.Name as string] !== undefined && body.Overwrite !== true) {
        return { status: 400, text: JSON.stringify({ __type: "ParameterAlreadyExists" }) };
      }
      parameters[body.Name as string] = body.Value as string;
      return { status: 200, text: JSON.stringify({ Version: 1 }) };
    }
    return { status: 400, text: JSON.stringify({ __type: "InvalidAction" }) };
  };
  return { calls, http, parameters };
}

const ref: EffectReceiptRef = { name: "seeded", effect: "db-seed", flavor: "hash", inputs: { v: 1 } };

function store(fake: ReturnType<typeof fakeSsm>, env: Record<string, string | undefined> = {}) {
  return awsReceiptStore({
    stack: "demo",
    environment: "dev",
    cwd: bareDir,
    http: fake.http,
    env,
  });
}

describe("awsReceiptStore", () => {
  it("read returns the stored value at the derived path", async () => {
    const fake = fakeSsm({ "/chant-receipts/demo/dev/db-seed": "sha256:abc" });
    await expect(store(fake).read(ref)).resolves.toBe("sha256:abc");
    expect(fake.calls[0].target).toBe("GetParameter");
    expect(fake.calls[0].body.Name).toBe("/chant-receipts/demo/dev/db-seed");
  });

  it("read returns undefined for an absent receipt — a real answer, not an error", async () => {
    const fake = fakeSsm({});
    await expect(store(fake).read(ref)).resolves.toBeUndefined();
  });

  it("read throws on a failed read rather than answering wrongly", async () => {
    const fake = fakeSsm({}, { failReads: true });
    await expect(store(fake).read(ref)).rejects.toThrow(/GetParameter/);
  });

  it("write creates plain String with the ownership tags", async () => {
    const fake = fakeSsm({});
    await store(fake).write(ref, "sha256:abc");
    expect(fake.calls).toHaveLength(1);
    const { body } = fake.calls[0];
    expect(body.Type).toBe("String");
    expect(body.Overwrite).toBeUndefined();
    expect(body.Tags).toContainEqual({ Key: "chant:managed-by", Value: "chant" });
    expect(body.Tags).toContainEqual({ Key: "chant:stack", Value: "demo" });
    expect(body.Tags).toContainEqual({ Key: "chant:env", Value: "dev" });
    expect(fake.parameters["/chant-receipts/demo/dev/db-seed"]).toBe("sha256:abc");
  });

  it("write overwrites an existing receipt — String + Overwrite, no tags on the retry", async () => {
    const fake = fakeSsm({ "/chant-receipts/demo/dev/db-seed": "sha256:old" });
    await store(fake).write(ref, "sha256:new");
    expect(fake.calls.map((c) => c.target)).toEqual(["PutParameter", "PutParameter"]);
    const retry = fake.calls[1].body;
    expect(retry.Type).toBe("String");
    expect(retry.Overwrite).toBe(true);
    expect(retry.Tags).toBeUndefined();
    expect(fake.parameters["/chant-receipts/demo/dev/db-seed"]).toBe("sha256:new");
  });

  it("honors AWS_ENDPOINT_URL_SSM, then AWS_ENDPOINT_URL (#1694)", async () => {
    const perService = fakeSsm({});
    await store(perService, { AWS_ENDPOINT_URL_SSM: "http://localhost:4566", AWS_ENDPOINT_URL: "http://elsewhere:1" }).read(ref);
    expect(perService.calls[0].url).toBe("http://localhost:4566/");

    const ambient = fakeSsm({});
    await store(ambient, { AWS_ENDPOINT_URL: "http://localhost:4566" }).read(ref);
    expect(ambient.calls[0].url).toBe("http://localhost:4566/");
  });

  it("errors without a stack identity", async () => {
    const fake = fakeSsm({});
    const s = awsReceiptStore({ environment: "dev", cwd: bareDir, http: fake.http, env: {} });
    await expect(s.read(ref)).rejects.toThrow(/ownership: \{ stack \}/);
  });

  it("errors without an env — the segment is explicit (decision 4)", async () => {
    const fake = fakeSsm({});
    const s = awsReceiptStore({ stack: "demo", cwd: bareDir, http: fake.http, env: {} });
    await expect(s.read(ref)).rejects.toThrow(/CHANT_ENV/);
  });

  it("reads CHANT_ENV for the env segment", async () => {
    const fake = fakeSsm({ "/chant-receipts/demo/staging/db-seed": "x" });
    const s = awsReceiptStore({ stack: "demo", cwd: bareDir, http: fake.http, env: { CHANT_ENV: "staging" } });
    await expect(s.read(ref)).resolves.toBe("x");
  });
});

describe("receiptActivities over the aws store", () => {
  it("resolves receiptRead/receiptWrite/receiptStaleness against the SSM store", async () => {
    const fake = fakeSsm({});
    const activities = receiptActivities(store(fake));

    const read = await activities.receiptRead({ receipt: ref, expectation: "sha256:abc" });
    expect(read).toEqual({ current: null, expectation: "sha256:abc", applied: false });

    await activities.receiptWrite({ receipt: ref, expectation: "sha256:abc" });
    const again = await activities.receiptRead({ receipt: ref, expectation: "sha256:abc" });
    expect(again.applied).toBe(true);

    const staleness = await activities.receiptStaleness({
      receipts: [{ receipt: ref, expectation: "sha256:other" }],
    });
    expect(staleness.stale).toBe(true);
    expect(staleness.findings[0]).toMatchObject({ receipt: "seeded", kind: "differs" });
  });

  it("is wired into the op activities barrel by name", async () => {
    const barrel = await import("./op/activities/index");
    expect(typeof barrel.receiptRead).toBe("function");
    expect(typeof barrel.receiptWrite).toBe("function");
    expect(typeof barrel.receiptStaleness).toBe("function");
  });
});

describe("observeReceiptRows (plan's live read)", () => {
  const buildOutput = JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Metadata: {
      [EFFECT_RECEIPTS_METADATA_KEY]: {
        seeded: {
          Type: "AWS::SSM::Parameter",
          Properties: { Name: "/chant-receipts/demo/dev/db-seed", Type: "String", Value: "sha256:abc", Tags: [] },
        },
      },
    },
    Resources: {},
  });

  it("maps a present receipt's stored value onto attributes.value", async () => {
    const fake = fakeSsm({ "/chant-receipts/demo/dev/db-seed": "sha256:abc" });
    const obs = await observeReceiptRows(["seeded", "unrelated"], buildOutput, { http: fake.http, env: {} });
    expect(obs.resources.seeded).toMatchObject({
      type: "AWS::SSM::Parameter",
      physicalId: "/chant-receipts/demo/dev/db-seed",
      status: "EXTERNAL",
      attributes: { value: "sha256:abc" },
    });
    expect(obs.unobserved).toEqual({});
    // Only the rendered receipt was queried — never a guess for other entities.
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a confirmed absence as absence — in neither map", async () => {
    const fake = fakeSsm({});
    const obs = await observeReceiptRows(["seeded"], buildOutput, { http: fake.http, env: {} });
    expect(obs.resources).toEqual({});
    expect(obs.unobserved).toEqual({});
  });

  it("reports a failed read as unobserved, never a wrong answer", async () => {
    const fake = fakeSsm({}, { failReads: true });
    const obs = await observeReceiptRows(["seeded"], buildOutput, { http: fake.http, env: {} });
    expect(obs.resources).toEqual({});
    expect(obs.unobserved.seeded).toMatchObject({ type: "AWS::SSM::Parameter", reason: "read-failed" });
  });

  it("answers nothing for a template without receipt rows", async () => {
    const fake = fakeSsm({});
    const obs = await observeReceiptRows(["seeded"], JSON.stringify({ Resources: {} }), { http: fake.http, env: {} });
    expect(obs).toEqual({ resources: {}, unobserved: {} });
    expect(fake.calls).toHaveLength(0);
  });
});
