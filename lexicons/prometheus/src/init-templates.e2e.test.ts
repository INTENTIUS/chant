import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { prometheusPlugin } from "./plugin";
import { TEMPLATE_NAMES } from "./init-templates";
import { postSynthChecks } from "./lint/post-synth";

async function built(name: string | undefined) {
  const dir = mkdtempSync(join(import.meta.dirname, "..", ".init-template-"));
  mkdirSync(join(dir, "src"));
  for (const [file, text] of Object.entries(prometheusPlugin.initTemplates!(name).src)) writeFileSync(join(dir, "src", file), text);
  return { dir, result: await build(join(dir, "src"), [prometheusPlugin.serializer]) };
}

// Every template builds, passes every PROM check with nothing to report, and
// lints clean.
describe("init templates", () => {
  test.each([undefined, ...TEMPLATE_NAMES])("%s builds, lints clean and passes every check", async (name) => {
    const { dir, result } = await built(name);
    try {
      expect(result.errors).toEqual([]);
      expect(result.outputs.get("prometheus")).toBeTruthy();
      // As `chant build` reports them: through the default (`recommended`) preset.
      const recommended = new Set(prometheusPlugin.lintPresets!().recommended);
      expect(runPostSynthChecks(postSynthChecks, result).filter((d) => recommended.has(d.checkId))).toEqual([]);
      const lint = await lintCommand({ path: join(dir, "src"), format: "stylish", fix: false });
      expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the slo template builds the SLO's rules and routes both severities its alerts carry", async () => {
    const { dir, result } = await built("slo");
    try {
      const out = result.outputs.get("prometheus") as { primary: string; files: Record<string, string> };
      const rules = load(out.primary) as { groups: Array<{ name: string; rules: Array<{ alert?: string; labels?: Record<string, string> }> }> };
      expect(rules.groups.map((g) => g.name)).toEqual(["slo-checkout"]);
      const severities = new Set(rules.groups[0].rules.filter((r) => r.alert).map((r) => r.labels?.severity));
      expect([...severities].sort()).toEqual(["page", "ticket"]);
      const am = load(out.files["alertmanager.yml"]) as { route: { routes: Array<{ matchers: string[] }> }; inhibit_rules: unknown[] };
      expect(am.route.routes.flatMap((r) => r.matchers)).toEqual(['severity="page"', 'severity="ticket"']);
      expect(am.inhibit_rules).toEqual([{ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["slo"] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown template name falls back to the default", () => {
    expect(prometheusPlugin.initTemplates!("no-such-template")).toBe(prometheusPlugin.initTemplates!());
    for (const name of TEMPLATE_NAMES) expect(prometheusPlugin.initTemplates!(name)).not.toBe(prometheusPlugin.initTemplates!());
  });
});
