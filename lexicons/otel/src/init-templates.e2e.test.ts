import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { otelPlugin } from "./plugin";
import { postSynthChecks } from "./lint/post-synth";
import { TEMPLATE_NAMES } from "./init-templates";
import type { CollectorConfig } from "./model";

async function buildTemplate(name: string | undefined): Promise<{ dir: string; result: Awaited<ReturnType<typeof build>> }> {
  const set = otelPlugin.initTemplates!(name);
  const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
  mkdirSync(join(dir, "src"));
  for (const [file, text] of Object.entries(set.src)) writeFileSync(join(dir, "src", file), text);
  for (const [file, text] of Object.entries(set.root ?? {})) writeFileSync(join(dir, file), text);
  return { dir, result: await build(join(dir, "src"), [otelPlugin.serializer]) };
}

function configOf(result: Awaited<ReturnType<typeof build>>): CollectorConfig {
  return load(result.outputs.get("otel") as string) as CollectorConfig;
}

// Every template builds with the otel lexicon alone, and its output passes
// every OTEL check and lints with nothing to report.
describe("init templates", () => {
  test.each([undefined, ...TEMPLATE_NAMES])("%s builds, lints clean and passes every check", async (name) => {
    const { dir, result } = await buildTemplate(name);
    try {
      expect(result.errors).toEqual([]);
      expect(result.outputs.get("otel")).toBeTruthy();
      expect(runPostSynthChecks(postSynthChecks, result)).toEqual([]);
      const lint = await lintCommand({ path: join(dir, "src"), format: "stylish", fix: false });
      expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the k8s-agent template sends traces and logs to the gateway and serves metrics on the node", async () => {
    const { dir, result } = await buildTemplate("k8s-agent");
    try {
      const config = configOf(result);
      const pipelines = config.service?.pipelines ?? {};
      expect(pipelines.traces.exporters).toEqual(["otlp/gateway"]);
      expect(pipelines.logs.exporters).toEqual(["otlp/gateway"]);
      expect(pipelines.metrics.exporters).toEqual(["prometheus"]);
      expect(pipelines.metrics.receivers).toEqual(["otlp", "hostmetrics", "kubeletstats"]);
      expect(config.processors?.resource).toEqual({ attributes: [{ key: "k8s.cluster.name", value: "my-cluster", action: "upsert" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the genai template derives the conventions' client metrics and removes content", async () => {
    const { dir, result } = await buildTemplate("genai");
    try {
      const config = configOf(result);
      expect(Object.keys(config.connectors ?? {})).toContain("signaltometrics/genai_client");
      expect(config.service?.pipelines?.traces?.processors).toContain("transform/genai_content");
      expect(config.service?.pipelines?.["metrics/genai"]?.exporters).toEqual(["prometheus"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown template name falls back to the default", () => {
    expect(otelPlugin.initTemplates!("no-such-template")).toBe(otelPlugin.initTemplates!());
  });
});
