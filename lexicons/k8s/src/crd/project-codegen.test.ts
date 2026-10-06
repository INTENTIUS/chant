/**
 * Project-local CRD classes end to end: a project declares a CRD file under
 * `k8s.crds`, `chant generate` writes typed classes into it, a source file
 * constructs one, the build emits the CRD's apiVersion and kind, the CRD spec
 * checks flag a value the schema rejects, and editing the CRD without
 * regenerating fails the build.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { loadPlugins } from "@intentius/chant/cli";
import { loadChantConfig } from "@intentius/chant/config";
import { checkProjectCodegen, generateProjectCode } from "@intentius/chant/project-codegen";
import { k8sPlugin } from "../plugin";
import { clearProjectKinds } from "../project-kinds";
import { k8sProjectCodegen } from "./project-codegen";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => clearProjectKinds());

const WIDGET_CRD = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec:
  group: example.com
  scope: Namespaced
  names: { kind: Widget, plural: widgets }
  versions:
    - name: v1alpha1
      served: true
      storage: false
      schema: { openAPIV3Schema: { type: object } }
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              description: What the widget should be.
              required: [size]
              properties:
                size: { type: integer, description: How many. }
                color: { type: string, enum: [red, blue] }
                labels:
                  type: object
                  additionalProperties: { type: string }
                "app.kubernetes.io/part-of": { type: string }
            status:
              type: object
              properties:
                ready: { type: boolean }
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gadgets.example.com
spec:
  group: example.com
  scope: Cluster
  names: { kind: Gadget, plural: gadgets }
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec: { type: object, properties: { mode: { type: string } } }
`;

const APP = (spec: string) => `import { Widget } from "./generated/k8s";

export const widget = new Widget({
  metadata: { name: "w1", labels: { app: "demo" } },
  spec: ${spec},
});
`;

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "chant-crd-codegen-"));
  made.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "crds"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "crds", "widgets.yaml"), WIDGET_CRD);
  writeFileSync(
    join(root, "chant.config.ts"),
    `export default {\n  lexicons: ["k8s"],\n  k8s: { crds: [{ type: "file", path: "crds/widgets.yaml" }] },\n};\n`,
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

async function config(root: string): Promise<Record<string, unknown>> {
  return (await loadChantConfig(root)).config as unknown as Record<string, unknown>;
}

async function build(root: string) {
  const src = join(root, "src");
  const plugins = await loadPlugins(["k8s"]);
  const serializers = plugins.map((p) => p.serializer).filter((s) => s.name === "k8s");
  const output = join(root, "k8s.yaml");
  const result = await buildCommand({ path: src, output, format: "yaml", serializers, plugins });
  let yaml = "";
  try {
    yaml = readFileSync(output, "utf8");
  } catch {
    // No output on a failed build.
  }
  return { result, yaml };
}

/** Type-check the project's sources against the real lexicon declarations. */
function typecheck(root: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // The workspace packages' sources, as the repo's own typecheck reads them.
    customConditions: ["development"],
    types: [],
  };
  const files = [join(root, "src", "app.ts"), join(root, "src", "generated", "k8s", "index.ts")];
  const program = ts.createProgram(files, options);
  return files
    .flatMap((f) => [...program.getSyntacticDiagnostics(program.getSourceFile(f)), ...program.getSemanticDiagnostics(program.getSourceFile(f))])
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("project CRD classes (k8s.crds)", () => {
  test("generate, build, spec check, and drift", async () => {
    const root = project();
    const generated = await generateProjectCode(k8sPlugin, root, await config(root));
    expect(generated?.files).toEqual(["index.ts", "kinds.json"]);
    expect(generated?.summary).toEqual(["Gadget (example.com/v1, cluster-scoped)", "Widget (example.com/v1, namespaced)"]);

    const module = readFileSync(join(root, "src/generated/k8s/index.ts"), "utf8");
    expect(module).toContain("export type WidgetSpec = {");
    expect(module).toContain("  size: number;");
    expect(module).toContain(`  color?: "red" | "blue";`);
    expect(module).toContain(`  "app.kubernetes.io/part-of"?: string;`);
    expect(module).toContain("  labels?: Record<string, string>;");
    expect(module).toContain(`createResource("K8s::Example::Widget", "k8s"`);

    // A correct resource builds with the CRD's storage version and kind.
    writeFileSync(join(root, "src", "app.ts"), APP(`{ size: 3, color: "red" }`));
    expect(typecheck(root)).toEqual([]);
    const ok = await build(root);
    expect(ok.result.errors).toEqual([]);
    expect(ok.yaml).toContain("apiVersion: example.com/v1\nkind: Widget");
    expect(ok.yaml).toContain("size: 3");

    // A spec the CRD rejects fails to typecheck and is flagged by the spec checks.
    writeFileSync(join(root, "src", "app.ts"), APP(`{ size: "three", colour: "red" }`));
    const typeErrors = typecheck(root).join("\n");
    expect(typeErrors).toMatch(/'colour' does not exist|not assignable/);
    const bad = await build(root);
    const findings = [...bad.result.errors, ...bad.result.warnings].join("\n");
    expect(findings).toMatch(/spec\.colour/);
    expect(findings).toMatch(/spec\.size/);

    // Editing the CRD without regenerating fails the build.
    writeFileSync(join(root, "src", "app.ts"), APP(`{ size: 3 }`));
    writeFileSync(join(root, "crds", "widgets.yaml"), WIDGET_CRD.replace("enum: [red, blue]", "enum: [red, blue, green]"));
    const drifted = await build(root);
    expect(drifted.result.success).toBe(false);
    expect(drifted.result.errors.join("\n")).toMatch(/src\/generated\/k8s is out of date.*chant generate/);

    await generateProjectCode(k8sPlugin, root, await config(root));
    expect((await build(root)).result.errors).toEqual([]);
  }, 120_000);

  test("a URL source must be pinned, and its content must match the pin", async () => {
    const root = project();
    const url = "https://example.test/crds.yaml";
    const pin = "0".repeat(64);
    const codegen = k8sProjectCodegen({ fetchUrl: async () => WIDGET_CRD });
    const ctx = (crds: unknown[]) => ({ projectRoot: root, outDir: join(root, "out"), config: { k8s: { crds } } });

    expect(() => codegen.inputs(ctx([{ type: "url", url }]))).toThrow(/needs a sha256 pin/);
    await expect(codegen.generate(ctx([{ type: "url", url, sha256: pin }]))).rejects.toThrow(/has sha256 [0-9a-f]{64}, but the config pins 0{64}/);

    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update(WIDGET_CRD).digest("hex");
    const out = await codegen.generate(ctx([{ type: "url", url, sha256: `sha256:${real}`, kinds: ["Gadget"] }]));
    expect(out.summary).toEqual(["Gadget (example.com/v1, cluster-scoped)"]);
  });

  test("a helm chart source needs a version", () => {
    const codegen = k8sProjectCodegen();
    const ctx = { projectRoot: "/p", outDir: "/p/out", config: { k8s: { crds: [{ type: "helm", chart: "oci://example.test/c" }] } } };
    expect(() => codegen.inputs(ctx)).toThrow(/needs a version/);
  });

  test("two kinds of one name from different groups take the group as a prefix", async () => {
    const other = WIDGET_CRD.split("---")[0].replace(/example\.com/g, "acme.io");
    const codegen = k8sProjectCodegen({ fetchUrl: async (u) => (u.includes("acme") ? other : WIDGET_CRD) });
    const { createHash } = await import("node:crypto");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const out = await codegen.generate({
      projectRoot: "/p",
      outDir: "/p/out",
      config: {
        k8s: {
          crds: [
            { type: "url", url: "https://example.test/a.yaml", sha256: sha(WIDGET_CRD), kinds: ["Widget"] },
            { type: "url", url: "https://acme.test/b.yaml", sha256: sha(other) },
          ],
        },
      },
    });
    expect(out.files["index.ts"]).toMatch(/export const AcmeWidget: new/);
    expect(out.files["index.ts"]).toMatch(/export const ExampleWidget: new/);
  });

  test("the build's check reports nothing when no CRDs are declared", async () => {
    expect(await checkProjectCodegen(k8sPlugin, "/nonexistent", {})).toEqual({ status: "none" });
  });
});
