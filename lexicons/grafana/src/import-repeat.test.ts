/**
 * A second `chant import` into the same directory names the findings about
 * what it wrote, not the ones about files an earlier import wrote (#5084).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { importCommand } from "@intentius/chant/cli/commands/import";

const pkgDir = resolve(import.meta.dirname, "..");

/** Two panels with the same id: GRAF104 is an error, so import says the build will stop. */
function dashboard(uid: string, title: string): string {
  const panel = { type: "stat", id: 124, title: "p", gridPos: { x: 0, y: 0, w: 6, h: 4 } };
  return JSON.stringify({ uid, title, schemaVersion: 39, panels: [panel, { ...panel, gridPos: { x: 6, y: 0, w: 6, h: 4 } }] });
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("repeated grafana imports", () => {
  test("the second import does not repeat the first one's GRAF104 warning", async () => {
    const dir = mkdtempSync(join(pkgDir, ".import-repeat-tmp-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), '{ "name": "grafana-import-repeat", "private": true, "type": "module" }\n');
    writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["grafana"] };\n');
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(dir, "first.json"), dashboard("first-board", "First board"));
    writeFileSync(join(dir, "second.json"), dashboard("second-board", "Second board"));

    const first = await importCommand({ templatePath: join(dir, "first.json"), output: src, lexicon: "grafana" });
    const second = await importCommand({ templatePath: join(dir, "second.json"), output: src, lexicon: "grafana" });

    const stops = (warnings: string[]) => warnings.filter((w) => w.startsWith("GRAF104:"));
    expect(stops(first.warnings)).toHaveLength(1);
    expect(stops(first.warnings)[0]).toContain("First board");
    expect(stops(second.warnings)).toHaveLength(1);
    expect(stops(second.warnings)[0]).toContain("Second board");
    expect(stops(second.warnings)[0]).not.toContain("First board");
  });
});
