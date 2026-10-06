/**
 * Typed Helm values end to end: a project lists charts under `helm.charts`,
 * `chant generate` writes a values type and a render factory per chart, the
 * types catch a misspelled value, a remote chart is read through an injected
 * fetch, and editing a local chart's schema without regenerating is drift.
 * The one step that renders needs the helm binary and is skipped without it.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { loadPlugins } from "@intentius/chant/cli";
import { loadChantConfig } from "@intentius/chant/config";
import { checkProjectCodegen, generateProjectCode } from "@intentius/chant/project-codegen";
import { helmPlugin } from "./plugin";
import { factoryBase, helmProjectCodegen } from "./project-codegen";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function helmOnPath(): boolean {
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const EDGE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["image"],
  properties: {
    image: { $ref: "#/$defs/image" },
    logLevel: { type: "string", enum: ["debug", "info", "error"] },
    ports: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: { port: { type: "integer" }, expose: { type: "boolean" } },
      },
    },
    podLabels: { type: "object", additionalProperties: { type: "string" } },
    "app.kubernetes.io/part-of": { type: "string" },
    "use-forwarded-headers": { type: "boolean" },
    replicas: { oneOf: [{ type: "integer" }, { type: "string", pattern: "^auto$" }] },
  },
  $defs: {
    image: {
      type: "object",
      additionalProperties: false,
      required: ["repository"],
      properties: { repository: { type: "string" }, tag: { type: "string" } },
    },
  },
};

const EDGE_VALUES = `image:\n  repository: nginx\n  tag: "1.27"\nlogLevel: info\nports:\n  web:\n    port: 8000\n`;
const EDGE_TEMPLATE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-settings
data:
  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
  logLevel: {{ .Values.logLevel | quote }}
`;

const PLAIN_VALUES = `replicaCount: 1\nservice:\n  type: ClusterIP\n  port: 80\nextraEnv: []\nresources:\n`;

/** A minimal ustar writer, enough to stand in for a chart archive. */
function tarGz(entries: Array<{ name: string; body: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body } of entries) {
    const data = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A classic chart repository at https://charts.example.test serving one chart, as a fetch. */
function fakeRepository(): { fetch: typeof fetch; seen: string[] } {
  const tgz = tarGz([
    { name: "remote/Chart.yaml", body: "apiVersion: v2\nname: remote\nversion: 1.2.3\n" },
    { name: "remote/values.yaml", body: "enabled: true\nmode: fast\n" },
    { name: "remote/charts/sub/Chart.yaml", body: "apiVersion: v2\nname: sub\nversion: 0.1.0\n" },
  ]);
  const index = `apiVersion: v1\nentries:\n  remote:\n    - version: 1.2.3\n      urls: [remote-1.2.3.tgz]\n      digest: ${createHash("sha256").update(tgz).digest("hex")}\n`;
  const seen: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url === "https://charts.example.test/index.yaml") return new Response(index);
    if (url === "https://charts.example.test/remote-1.2.3.tgz") return new Response(new Uint8Array(tgz));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, seen };
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "chant-helm-codegen-"));
  made.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  const edge = join(root, "charts", "edge");
  mkdirSync(join(edge, "templates"), { recursive: true });
  writeFileSync(join(edge, "Chart.yaml"), "apiVersion: v2\nname: edge\nversion: 0.3.0\n");
  writeFileSync(join(edge, "values.yaml"), EDGE_VALUES);
  writeFileSync(join(edge, "values.schema.json"), JSON.stringify(EDGE_SCHEMA, null, 2));
  writeFileSync(join(edge, "templates", "configmap.yaml"), EDGE_TEMPLATE);
  const plain = join(root, "charts", "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "Chart.yaml"), "apiVersion: v2\nname: plain\nversion: 2.0.0\n");
  writeFileSync(join(plain, "values.yaml"), PLAIN_VALUES);
  writeFileSync(
    join(root, "chant.config.ts"),
    `export default {
  lexicons: ["helm", "k8s"],
  helm: {
    charts: {
      edge: { path: "charts/edge" },
      "plain-app": { path: "charts/plain" },
      remote: { repo: "https://charts.example.test", chart: "remote", version: "1.2.3" },
    },
  },
};
`,
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

async function config(root: string): Promise<Record<string, unknown>> {
  return (await loadChantConfig(root)).config as unknown as Record<string, unknown>;
}

function typecheck(root: string, app: string): string[] {
  writeFileSync(join(root, "src", "app.ts"), app);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["development"],
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules", "@types")],
  };
  const files = [join(root, "src", "app.ts"), join(root, "src", "generated", "helm", "index.ts")];
  const program = ts.createProgram(files, options);
  return files
    .flatMap((f) => [...program.getSyntacticDiagnostics(program.getSourceFile(f)), ...program.getSemanticDiagnostics(program.getSourceFile(f))])
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("typed Helm values (helm.charts)", () => {
  test("factory names come from the chart key", () => {
    expect(factoryBase("traefik")).toBe("Traefik");
    expect(factoryBase("ingress-nginx")).toBe("IngressNginx");
    expect(factoryBase("cert_manager")).toBe("CertManager");
  });

  test("generate writes a values type and a factory per chart, and the types catch bad values", async () => {
    const root = project();
    const repository = fakeRepository();
    const result = await generateProjectCode(helmPlugin, root, await config(root), { fetch: repository.fetch });
    expect(result?.files).toEqual(["index.ts"]);
    expect(result?.summary).toEqual([
      "EdgeRender (edge 0.3.0, values from values.schema.json)",
      "PlainAppRender (plain 2.0.0, values from values.yaml)",
      "RemoteRender (remote 1.2.3, values from values.yaml)",
    ]);
    expect(repository.seen).toEqual(["https://charts.example.test/index.yaml", "https://charts.example.test/remote-1.2.3.tgz"]);

    const module = readFileSync(join(root, "src", "generated", "helm", "index.ts"), "utf8");
    expect(module).toContain("export type EdgeValuesImage = {");
    expect(module).toContain("  image?: EdgeValuesImage;");
    expect(module).toContain(`  "app.kubernetes.io/part-of"?: string;`);
    expect(module).toContain(`  logLevel?: "debug" | "info" | "error";`);
    expect(module).toContain("  replicas?: number | string;");
    expect(module).toContain(`chart: chartPath("../../../charts/edge"),`);
    expect(module).toContain(`repo: "https://charts.example.test",`);
    expect(module).toContain(`version: "1.2.3",`);
    expect(module).toContain("export type RemoteValues = {\n  enabled?: boolean;\n  mode?: string;\n};");

    const good = `import { EdgeRender, PlainAppRender, RemoteRender } from "./generated/helm";
export const edge = EdgeRender({
  name: "edge",
  namespace: "edge",
  values: { image: { tag: "1.28" }, ports: { web: { port: 9000 } }, podLabels: { team: "a" }, "use-forwarded-headers": true },
});
export const plain = PlainAppRender({ name: "plain", values: { service: { port: 8080 }, resources: { limits: {} } } });
export const remote = RemoteRender({ name: "remote", values: { mode: "slow" } });
`;
    expect(typecheck(root, good)).toEqual([]);

    const bad = (values: string) => `import { EdgeRender, PlainAppRender } from "./generated/helm";
export const x = ${values.startsWith("plain:") ? `PlainAppRender({ name: "p", values: ${values.slice(6)} })` : `EdgeRender({ name: "e", values: ${values} })`};
`;
    expect(typecheck(root, bad(`{ imgae: { tag: "x" } }`)).join("\n")).toMatch(/'imgae' does not exist/);
    expect(typecheck(root, bad(`{ ports: { web: { prot: 1 } } }`)).join("\n")).toMatch(/'prot' does not exist/);
    expect(typecheck(root, bad(`{ logLevel: "verbose" }`))).not.toEqual([]);
    expect(typecheck(root, bad(`plain:{ service: { prot: 1 } }`)).join("\n")).toMatch(/'prot' does not exist/);
    // The chart is fixed by the config, not by the caller.
    expect(typecheck(root, bad(`{}, version: "9.9.9"`))).not.toEqual([]);
  }, 120_000);

  test("editing a local chart's schema without regenerating is drift; a remote chart is checked by its pin", async () => {
    const root = project();
    const repository = fakeRepository();
    await generateProjectCode(helmPlugin, root, await config(root), { fetch: repository.fetch });
    expect(await checkProjectCodegen(helmPlugin, root, await config(root))).toEqual({ status: "current" });

    // The check is offline: the remote chart is not fetched again.
    expect(repository.seen).toHaveLength(2);

    const schemaPath = join(root, "charts", "edge", "values.schema.json");
    writeFileSync(schemaPath, readFileSync(schemaPath, "utf8").replace('"error"', '"warn"'));
    const check = await checkProjectCodegen(helmPlugin, root, await config(root));
    expect(check.status).toBe("drift");
  });

  test("a remote chart needs a version and a repo or an oci reference", () => {
    const codegen = helmProjectCodegen();
    const ctx = (charts: Record<string, unknown>) => ({ projectRoot: "/p", outDir: "/p/out", config: { helm: { charts } } });
    expect(() => codegen.inputs(ctx({ a: { repo: "https://x.test", chart: "a", version: "" } }))).toThrow(/needs a version/);
    expect(() => codegen.inputs(ctx({ a: { chart: "a", version: "1.0.0" } }))).toThrow(/needs a repo, or must be an oci:\/\/ reference/);
    expect(() => codegen.inputs(ctx({ "1a": { chart: "oci://x.test/a", version: "1.0.0" } }))).toThrow(/must start with a letter/);
  });

  test("an archive whose digest does not match the repository index is refused", async () => {
    const codegen = helmProjectCodegen();
    const tampered = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("index.yaml")) {
        return new Response(`entries:\n  r:\n    - version: 1.0.0\n      urls: [r.tgz]\n      digest: ${"0".repeat(64)}\n`);
      }
      return new Response(new Uint8Array(tarGz([{ name: "r/Chart.yaml", body: "name: r\nversion: 1.0.0\n" }])));
    }) as typeof fetch;
    await expect(
      codegen.generate({
        projectRoot: "/p",
        outDir: "/p/out",
        config: { helm: { charts: { r: { repo: "https://r.test", chart: "r", version: "1.0.0" } } } },
        fetch: tampered,
      }),
    ).rejects.toThrow(/the repository index says 0{64}/);
  });

  test.skipIf(!helmOnPath())("a generated factory renders its local chart in a build", async () => {
    const root = project();
    // Only the local chart, so the build needs no network.
    writeFileSync(
      join(root, "chant.config.ts"),
      `export default { lexicons: ["helm", "k8s"], helm: { charts: { edge: { path: "charts/edge" } } } };\n`,
    );
    await generateProjectCode(helmPlugin, root, await config(root));
    writeFileSync(
      join(root, "src", "app.ts"),
      `import { EdgeRender } from "./generated/helm";\nexport const edge = EdgeRender({ name: "edge", namespace: "edge", noCache: true, values: { image: { repository: "nginx", tag: "1.28" }, logLevel: "debug" } });\n`,
    );
    const plugins = await loadPlugins(["helm", "k8s"]);
    const output = join(root, "out.yaml");
    const result = await buildCommand({
      path: join(root, "src"),
      output,
      format: "yaml",
      serializers: plugins.map((p) => p.serializer).filter((s) => s.name === "k8s"),
      plugins,
    });
    expect(result.errors).toEqual([]);
    const yamlOut = readFileSync(output, "utf8");
    expect(yamlOut).toContain("image: nginx:1.28");
    expect(yamlOut).toContain("logLevel: debug");
  }, 120_000);
});
