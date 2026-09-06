/**
 * Every shipped terraform example builds, and the scheduled-watch one
 * generates the CI it documents (#2087).
 *
 * `chant dev check-lexicon` already gates "builds". What it does not cover is
 * the second half of `examples/scheduled-watch`: the Op there exists to be put
 * on a cron by something, and the something this example ships is
 * `generateOpsPipeline` against the github lexicon. So the emitted workflow is
 * asserted here, field by field, against the real generator and the real Op
 * discovery, rather than described in a README nothing checks.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import { generateOpsPipeline } from "@intentius/chant/op";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { terraformSerializer } from "../src/serializer";

const examplesDir = dirname(fileURLToPath(import.meta.url));

const exampleNames = readdirSync(examplesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(examplesDir, e.name, "src")))
  .map((e) => e.name)
  .sort();

describe("terraform examples", () => {
  it("ships at least one example", () => {
    expect(exampleNames.length).toBeGreaterThan(0);
  });

  for (const name of exampleNames) {
    it(`${name} builds with no structural error`, async () => {
      const result = await build(join(examplesDir, name, "src"), [terraformSerializer]);
      expect(result.errors).toEqual([]);
    });
  }
});

/**
 * The terraform install the runner needs. `beforeScript` lines are emitted as
 * plain `run:` steps (`lexicons/github/src/components/generate-op-pipeline.ts`),
 * so this is a shell line rather than a `uses: hashicorp/setup-terraform`,
 * which would need a `uses:`-shaped option that does not exist today.
 *
 * A pinned release unzip, not the apt repo: the version the Op plans with is
 * then the version this file names, which matters for an estate whose state
 * has a `required_version` floor.
 */
const TERRAFORM_VERSION = "1.13.3";
const INSTALL_TERRAFORM =
  `curl -fsSL https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip ` +
  `-o /tmp/terraform.zip && unzip -q -o /tmp/terraform.zip -d /usr/local/bin && terraform version`;

const WATCH_SPEC: ScheduledOpSpec = {
  name: "app-watch",
  schedule: "0 6 * * *",
  findingMode: "issue",
};

const scheduledWatchDir = join(examplesDir, "scheduled-watch");

async function watchWorkflow(): Promise<string> {
  const result = await generateOpsPipeline(
    [WATCH_SPEC],
    "github",
    { beforeScript: [INSTALL_TERRAFORM] },
    scheduledWatchDir,
  );
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  const file = result.files?.find((f) => f.name === "app-watch.yml");
  expect(file, "one workflow file per scheduled Op").toBeDefined();
  return file!.yaml;
}

describe("scheduled-watch generates its GitHub Actions cron (#2087)", () => {
  it("discovers the example's own Op, and only that one", async () => {
    // `discoverOps` roots at the nearest chant.config.ts, so this resolves the
    // example's `ops/watch.op.ts` and not the repo's other `*.op.ts` files.
    const result = await generateOpsPipeline([WATCH_SPEC], "github", {}, scheduledWatchDir);
    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      {
        jobName: "app-watch",
        op: "app-watch",
        trigger: { kind: "cron", schedule: "0 6 * * *" },
        findingMode: "issue",
      },
    ]);
  });

  it("fails on an Op the example does not declare", async () => {
    const result = await generateOpsPipeline(
      [{ name: "not-an-op", schedule: "0 6 * * *" }],
      "github",
      {},
      scheduledWatchDir,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown Op\(s\): not-an-op/);
  });

  it("carries the cron and workflow_dispatch", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("- cron: '0 6 * * *'");
    expect(yaml).toContain("workflow_dispatch:");
  });

  it("carries a per-Op concurrency group that does not cancel a run in flight", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("concurrency:");
    expect(yaml).toContain("group: app-watch");
    expect(yaml).toContain("cancel-in-progress: false");
  });

  it("grants issues: write and nothing wider", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("issues: write");
    expect(yaml).toContain("contents: read");
    expect(yaml).not.toContain("contents: write");
    expect(yaml).not.toContain("pull-requests: write");
    expect(yaml).not.toContain("write-all");
  });

  it("installs terraform before running the Op", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain(`releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/`);
    expect(yaml).toContain("unzip -q -o /tmp/terraform.zip -d /usr/local/bin");
    // The install must precede the invocation, or the Op's first step is a
    // missing binary.
    expect(yaml.indexOf("/tmp/terraform.zip")).toBeLessThan(yaml.indexOf("chant run app-watch"));
  });

  it("runs the Op through `chant run`, with the token the issue mode needs", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("chant run app-watch");
    expect(yaml).toContain("GH_TOKEN:");
  });
});
