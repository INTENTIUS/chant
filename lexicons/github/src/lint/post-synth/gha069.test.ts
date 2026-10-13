import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha069 } from "./gha069";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "GHA069");

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["github", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function fixture(name: string): PostSynthContext {
  return makeCtx(readFileSync(join(FIXTURES, `${name}.yml`), "utf-8"));
}

/** The issue's fixture with the workflow block, the job block and the step swapped in. */
function workflow(opts: { wf?: string; job?: string; step: string }): string {
  const wf = opts.wf ?? "permissions:\n  id-token: write\n  contents: read\n";
  const job = opts.job === undefined ? "" : `    permissions: ${opts.job}\n`;
  return `name: Deploy
on:
  push:
${wf}jobs:
  deploy:
    runs-on: ubuntu-latest
${job}    steps:
${opts.step}`;
}

const AWS_STEP = `      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy
          aws-region: us-east-1
`;

describe("GHA069: job-level permissions block drops the workflow's id-token: write", () => {
  test("fires on the issue's fixture and names the scope, the job and the fix", () => {
    const diags = gha069.check(fixture("positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA069");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("deploy");
    expect(diags[0].message).toContain("id-token: write");
    expect(diags[0].message).toContain('Job "deploy"');
    expect(diags[0].message).toContain("aws-actions/configure-aws-credentials");
    expect(diags[0].message).toContain("Add `id-token: write` to job \"deploy\"'s permissions block");
    expect(diags[0].message).toContain("rather than removing it");
  });

  test("does not fire when the job block carries the scope", () => {
    expect(gha069.check(fixture("negative"))).toHaveLength(0);
  });

  test("does not fire when there is no job-level block", () => {
    expect(gha069.check(fixture("negative-no-job-block"))).toHaveLength(0);
  });

  test("does not fire on a job block whose job needs no OIDC token", () => {
    expect(gha069.check(fixture("negative-no-oidc-step"))).toHaveLength(0);
  });

  test("does not fire when the workflow block never granted id-token", () => {
    const yaml = workflow({ wf: "permissions:\n  contents: read\n", job: "\n      contents: read\n", step: AWS_STEP });
    expect(gha069.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not fire when there is no workflow block at all", () => {
    const yaml = workflow({ wf: "", job: "\n      contents: read\n", step: AWS_STEP });
    expect(gha069.check(makeCtx(yaml))).toHaveLength(0);
  });

  test.each([
    ["azure/login", "azure/login@v2", "client-id: abc"],
    ["Azure/login, as usually written", "Azure/login@v2", "client-id: abc"],
    ["google-github-actions/auth", "google-github-actions/auth@v2", "workload_identity_provider: projects/1/locations/global/workloadIdentityPools/p/providers/gh"],
    [
      "a full SHA pin with a version comment",
      "aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2",
      "role-to-assume: arn:aws:iam::123456789012:role/deploy",
    ],
    ["a major-only ref", "aws-actions/configure-aws-credentials@v4", "role-to-assume: arn:aws:iam::123456789012:role/deploy"],
    ["an exact tag", "aws-actions/configure-aws-credentials@v4.0.2", "role-to-assume: arn:aws:iam::123456789012:role/deploy"],
  ])("matches %s on the action path whatever the ref", (_label, uses, input) => {
    const step = `      - uses: ${uses}\n        with:\n          ${input}\n`;
    const diags = gha069.check(makeCtx(workflow({ job: "\n      contents: read\n", step })));
    expect(diags).toHaveLength(1);
  });

  test("a job block of {} drops id-token too", () => {
    const diags = gha069.check(makeCtx(workflow({ job: "{}", step: AWS_STEP })));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("`permissions: {}`");
  });

  test("a job block of read-all drops id-token too", () => {
    const diags = gha069.check(makeCtx(workflow({ job: "read-all", step: AWS_STEP })));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("`permissions: read-all`");
  });

  test("a job block of write-all grants id-token, so it does not fire", () => {
    expect(gha069.check(makeCtx(workflow({ job: "write-all", step: AWS_STEP })))).toHaveLength(0);
  });

  test("a workflow block of write-all grants id-token, so a narrower job block drops it", () => {
    const yaml = workflow({ wf: "permissions: write-all\n", job: "\n      contents: read\n", step: AWS_STEP });
    expect(gha069.check(makeCtx(yaml))).toHaveLength(1);
  });

  test("a workflow block of read-all never granted id-token, so it does not fire", () => {
    const yaml = workflow({ wf: "permissions: read-all\n", job: "\n      contents: read\n", step: AWS_STEP });
    expect(gha069.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("a job block setting id-token: none still drops it", () => {
    const diags = gha069.check(makeCtx(workflow({ job: "\n      id-token: none\n", step: AWS_STEP })));
    expect(diags).toHaveLength(1);
  });

  test.each([
    ["aws-actions/configure-aws-credentials@v4", "aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}"],
    ["azure/login@v2", "creds: ${{ secrets.AZURE_CREDENTIALS }}"],
    ["google-github-actions/auth@v2", "credentials_json: ${{ secrets.GCP_SA_KEY }}"],
  ])("does not fire when %s is given a static credential", (uses, input) => {
    const step = `      - uses: ${uses}\n        with:\n          ${input}\n`;
    expect(gha069.check(makeCtx(workflow({ job: "\n      contents: read\n", step })))).toHaveLength(0);
  });

  test("reports each affected job once, and only those", () => {
    const yaml = `name: Deploy
on: push
permissions:
  id-token: write
jobs:
  staging:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/staging
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/1/locations/global/workloadIdentityPools/p/providers/gh
  prod:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/prod
`;
    const diags = gha069.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("staging");
    expect(diags[0].message).toContain("aws-actions/configure-aws-credentials, google-github-actions/auth");
  });
});
