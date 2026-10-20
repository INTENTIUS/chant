import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PLANNERS,
  PLAN_PREVIEWS_DOC,
  PLUGINS,
  capabilityRows,
  extractPlanPreviewsBlock,
  renderPlanPreviewsBlock,
  replacePlanPreviewsBlock,
} from "./plan-previews";

const ROOT = join(import.meta.dirname, "..");

describe("plan previews page (chant #4001)", () => {
  test("the committed table matches the capability plugins (npm run generate:plan-previews if this fails)", () => {
    const doc = readFileSync(join(ROOT, PLAN_PREVIEWS_DOC), "utf-8");
    expect(extractPlanPreviewsBlock(doc)).toBe(renderPlanPreviewsBlock());
  });

  test("every capability with plan has a PLANNERS entry, and every entry has plan", () => {
    const rows = capabilityRows();
    const planners = rows.filter((r) => r.plan).map((r) => r.kind).sort();
    expect(Object.keys(PLANNERS).sort()).toEqual(planners);
  });

  test("each PLANNERS entry names the file that declares its kind and a section the page has", () => {
    const doc = readFileSync(join(ROOT, PLAN_PREVIEWS_DOC), "utf-8");
    for (const [kind, note] of Object.entries(PLANNERS)) {
      const source = readFileSync(join(ROOT, note.source), "utf-8");
      expect(source, `${note.source} declares ${kind}`).toContain(`kind: "${kind}"`);
      expect(doc, `the page has a "### \`${kind}\`" section`).toContain(`### \`${kind}\``);
      expect(doc, `the page cites ${note.source}`).toContain(note.source);
    }
  });

  test("every lexicon that exports a capability plugin is listed", () => {
    const exported: string[] = [];
    for (const name of readdirSync(join(ROOT, "lexicons"))) {
      const entry = join(ROOT, "lexicons", name, "src", "index.ts");
      if (!existsSync(entry)) continue;
      for (const m of readFileSync(entry, "utf-8").matchAll(/\b([a-z][A-Za-z0-9]*CapabilityPlugin)\b/g)) exported.push(m[1]);
    }
    const listed = PLUGINS.filter((p) => p.lexicon !== "core").map((p) => p.exportName);
    expect([...new Set(exported)].sort()).toEqual([...listed].sort());
  });

  test("a capability that gains plan or outputs changes the table", () => {
    const rows = capabilityRows();
    const before = renderPlanPreviewsBlock(rows);
    const helm = rows.map((r) => (r.kind === "helm-upgrade" ? { ...r, outputs: true } : r));
    expect(renderPlanPreviewsBlock(helm)).not.toBe(before);
    expect(renderPlanPreviewsBlock(helm)).toContain("| `helm-upgrade` | helm | no | yes |");
  });

  test("replace rewrites only the block", () => {
    const rows = capabilityRows();
    const doc = `before\n\n{/* BEGIN GENERATED plan-previews */}\nstale\n{/* END GENERATED plan-previews */}\n\nafter\n`;
    const out = replacePlanPreviewsBlock(doc, rows);
    expect(out.startsWith("before\n\n")).toBe(true);
    expect(out.endsWith("\n\nafter\n")).toBe(true);
    expect(out).not.toContain("stale");
  });
});
