/**
 * Telemetry attribution through a real fly build (#3060): inside a workspace
 * each Machine's env names the workspace and the member,
 * `telemetry.attribution: false` turns that off, and outside a workspace
 * nothing is stamped unless `telemetry.attribution: true` opts in.
 */
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const APP = `import { App, Machine, MachineConfig } from "@intentius/chant-lexicon-fly";

export const app = new App({ name: "notes", org_slug: "acme" });

export const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({ image: "node:22-slim", env: { PORT: "8080" } }),
});
`;

/** A fly project, inside a one-member workspace or on its own, built to its flaps plan. */
async function build(options: { workspace: boolean; attribution?: boolean }): Promise<Record<string, { body: { config?: { env?: Record<string, string> } } }>> {
  const root = mkdtempSync(join(tmpdir(), "chant-3060-"));
  made.push(root);
  mkdirSync(join(root, ".git"));
  const project = options.workspace ? join(root, "svc") : root;
  mkdirSync(join(project, "src"), { recursive: true });
  if (options.workspace) {
    writeFileSync(
      join(root, "chant.workspace.json"),
      JSON.stringify({ name: "acme", schema: 1, members: [{ name: "svc", dir: "svc", kind: "chant" }] }, null, 2),
    );
  }
  const telemetry = options.attribution === undefined ? "" : `  telemetry: { attribution: ${options.attribution} },\n`;
  writeFileSync(join(project, "chant.config.ts"), `export default {\n  lexicons: ["fly"],\n${telemetry}};\n`);
  writeFileSync(join(project, "src", "app.ts"), APP);
  symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"), "dir");

  const src = join(project, "src");
  const plugins = await loadPlugins(await resolveProjectLexicons(src));
  const serializers = plugins.map((p) => p.serializer).filter((s) => s.name === "fly");
  const output = join(project, "fly.json");
  const result = await buildCommand({ path: src, output, format: "json", serializers, plugins });
  expect(result.success, result.errors.join("\n")).toBe(true);
  return JSON.parse(readFileSync(output, "utf-8"));
}

describe("telemetry attribution in a fly build (#3060)", () => {
  test("inside a workspace the Machine names the workspace, the member and the declaration", async () => {
    const env = (await build({ workspace: true })).web.body.config!.env!;
    expect(env.OTEL_SERVICE_NAME).toBe("notes");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("chant.workspace=acme,chant.member=svc,chant.decl=web");
  });

  test("telemetry.attribution false turns it off inside a workspace", async () => {
    expect(JSON.stringify(await build({ workspace: true, attribution: false }))).not.toContain("OTEL_");
  });

  test("outside a workspace nothing is stamped, and telemetry.attribution true opts in without workspace or member", async () => {
    expect(JSON.stringify(await build({ workspace: false }))).not.toContain("OTEL_");
    const env = (await build({ workspace: false, attribution: true })).web.body.config!.env!;
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("chant.decl=web");
  });
});
