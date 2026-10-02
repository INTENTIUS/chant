import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { build } from "@intentius/chant/build";
import type { Serializer } from "@intentius/chant/serializer";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { k8sPlugin } from "@intentius/chant-lexicon-k8s";
import { prometheusPlugin } from "@intentius/chant-lexicon-prometheus";
import { grafanaPlugin } from "./plugin";
import { postSynthChecks } from "./lint/post-synth";

// Every template builds with the lexicons its chant.config.ts names, and its
// output passes every GRAF check, and the other lexicon's checks, with
// nothing to report.
const cases: Array<[string | undefined, Serializer[], string[]]> = [
  [undefined, [grafanaPlugin.serializer], ["grafana"]],
  ["red", [grafanaPlugin.serializer], ["grafana"]],
  ["k8s-pods", [k8sPlugin.serializer, grafanaPlugin.serializer], ["k8s", "grafana"]],
  ["slo", [prometheusPlugin.serializer, grafanaPlugin.serializer], ["prometheus", "grafana"]],
];

describe("init templates", () => {
  test.each(cases)("%s builds, lints clean and passes every check", async (name, serializers, outputs) => {
    const set = grafanaPlugin.initTemplates!(name);
    const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
    try {
      mkdirSync(join(dir, "src"));
      for (const [file, text] of Object.entries(set.src)) writeFileSync(join(dir, "src", file), text);
      for (const [file, text] of Object.entries(set.root ?? {})) writeFileSync(join(dir, file), text);
      const result = await build(join(dir, "src"), serializers);
      expect(result.errors).toEqual([]);
      for (const lexicon of outputs) expect(result.outputs.get(lexicon), lexicon).toBeTruthy();

      expect(runPostSynthChecks(postSynthChecks, result)).toEqual([]);
      const other = name === "k8s-pods" ? k8sPlugin : name === "slo" ? prometheusPlugin : undefined;
      if (other) {
        expect(runPostSynthChecks(other.postSynthChecks!(), result)).toEqual([]);
      }

      const lint = await lintCommand({ path: join(dir, "src"), format: "stylish", fix: false });
      expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the RED template puts its dashboard in the pinned folder and counts served spans only", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
    try {
      mkdirSync(join(dir, "src"));
      for (const [file, text] of Object.entries(grafanaPlugin.initTemplates!("red").src)) writeFileSync(join(dir, "src", file), text);
      const result = await build(join(dir, "src"), [grafanaPlugin.serializer]);
      const out = result.outputs.get("grafana") as { primary: string; files: Record<string, string> };
      const index = JSON.parse(out.primary) as { dashboards: Array<{ uid: string; folderUid?: string }>; datasources: unknown[] };
      expect(index.dashboards).toEqual([expect.objectContaining({ uid: "services-red", folderUid: "observability" })]);
      // An ExternalDatasource is checked against, never provisioned.
      expect(index.datasources).toEqual([]);
      const dashboard = Object.entries(out.files).find(([path]) => path.endsWith("services-red.json"))![1];
      expect(dashboard).toContain("SPAN_KIND_SERVER|SPAN_KIND_CONSUMER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the k8s-pods and slo templates build every lexicon their config names", () => {
    for (const name of ["k8s-pods", "slo"]) {
      const set = grafanaPlugin.initTemplates!(name);
      expect(set.root?.["chant.config.ts"]).toContain('"grafana"');
      expect(set.scripts?.build).toBe("chant build src");
    }
    expect(grafanaPlugin.initTemplates!("no-such-template")).toBe(grafanaPlugin.initTemplates!());
  });
});
