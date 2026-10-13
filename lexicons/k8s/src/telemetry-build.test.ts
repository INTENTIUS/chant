/**
 * Telemetry attribution through a real k8s build (#3059): inside a workspace
 * the workloads are stamped with the workspace and the member,
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

const APP = `import { Deployment } from "@intentius/chant-lexicon-k8s";

export const api = new Deployment({
  metadata: { name: "api" },
  spec: {
    selector: { matchLabels: { app: "api" } },
    template: {
      metadata: { labels: { app: "api" } },
      spec: { containers: [{ name: "api", image: "nginx:1.27" }] },
    },
  },
});
`;

/** A k8s project, inside a one-member workspace or on its own, built to YAML. */
async function build(options: { workspace: boolean; attribution?: boolean }): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "chant-3059-"));
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
  writeFileSync(join(project, "chant.config.ts"), `export default {\n  lexicons: ["k8s"],\n${telemetry}};\n`);
  writeFileSync(join(project, "src", "app.ts"), APP);
  symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"), "dir");

  const src = join(project, "src");
  const plugins = await loadPlugins(await resolveProjectLexicons(src));
  const serializers = plugins.map((p) => p.serializer).filter((s) => s.name === "k8s");
  const output = join(project, "k8s.yaml");
  const result = await buildCommand({ path: src, output, format: "yaml", serializers, plugins });
  expect(result.success, result.errors.join("\n")).toBe(true);
  return readFileSync(output, "utf-8");
}

describe("telemetry attribution in a k8s build (#3059)", () => {
  test("inside a workspace the containers name the workspace, the member and the declaration", async () => {
    const out = await build({ workspace: true });
    expect(out).toContain("value: api");
    expect(out).toContain("value: chant.workspace=acme,chant.member=svc,chant.decl=api");
  });

  test("telemetry.attribution false turns it off inside a workspace", async () => {
    expect(await build({ workspace: true, attribution: false })).not.toContain("OTEL_");
  });

  test("outside a workspace nothing is stamped, and telemetry.attribution true opts in without workspace or member", async () => {
    expect(await build({ workspace: false })).not.toContain("OTEL_");
    const optedIn = await build({ workspace: false, attribution: true });
    expect(optedIn).toContain("value: chant.decl=api");
    expect(optedIn).not.toContain("chant.workspace");
  });
});
