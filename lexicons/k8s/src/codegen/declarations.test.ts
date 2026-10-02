/**
 * The generated declarations check nested objects (chant #3093). Before,
 * `Deployment.spec` was `Record<string, unknown>` and the property classes
 * had no members, so a wrong type or an unknown key below a resource's top
 * level type-checked.
 *
 * Compiled against `src/generated/index.d.ts`, the file the package ships as
 * `@intentius/chant-lexicon-k8s/types` (which entry consumers get is #2224).
 */
import { describe, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as ts from "typescript";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dts = join(pkgDir, "src", "generated", "index.d.ts");

/** Type errors in each probe, by probe name, compiled against the generated declarations. */
function typeErrors(probes: Record<string, string>): Record<string, string[]> {
  const dir = mkdtempSync(join(tmpdir(), "chant-k8s-dts-"));
  try {
    copyFileSync(dts, join(dir, "k8s.d.ts"));
    const files = Object.entries(probes).map(([name, body]) => {
      const file = join(dir, `${name}.ts`);
      writeFileSync(file, body);
      return file;
    });
    const program = ts.createProgram(files, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    });
    const out: Record<string, string[]> = Object.fromEntries(Object.keys(probes).map((n) => [n, []]));
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const name = d.file ? d.file.fileName.split("/").pop()!.replace(/(\.d)?\.ts$/, "") : "global";
      (out[name] ??= []).push(`TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IMPORT = `import { ConfigMap, Container, ControllerRevision, CustomResourceDefinition, Deployment, Probe, Role, StatefulSet } from "./k8s";\n`;

describe.skipIf(!existsSync(dts))("the generated declarations type nested objects", () => {
  test("nested mistakes are errors, valid manifests are not", () => {
    const errors = typeErrors({
      replicasString: `${IMPORT}new Deployment({ spec: { replicas: "three", selector: {}, template: {} } });`,
      unknownSpecKey: `${IMPORT}new Deployment({ spec: { bogusField: true, selector: {}, template: {} } });`,
      unknownContainerKey: `${IMPORT}new Deployment({ spec: { selector: {}, template: { spec: { containers: [{ name: "a", imag: "b" }] } } } });`,
      wrongProbeField: `${IMPORT}new Container({ name: "a", livenessProbe: new Probe({ httpGet: { path: "/", port: 80, verb: "GET" } }) });`,
      missingSelector: `${IMPORT}new Deployment({ spec: { template: {} } });`,
      valid: `${IMPORT}
export const deployment = new Deployment({
  metadata: { name: "app", labels: { app: "app" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: "app" } },
    strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: 0 } },
    template: {
      metadata: { labels: { app: "app" } },
      spec: {
        securityContext: { runAsNonRoot: true, fsGroup: 1000 },
        containers: [
          new Container({
            name: "app",
            image: "app:1.0",
            ports: [{ containerPort: 8080, name: "http" }],
            resources: { limits: { cpu: 1, memory: "256Mi" }, requests: { cpu: "100m" } },
            readinessProbe: new Probe({ httpGet: { path: "/readyz", port: "http" } }),
          }),
        ],
      },
    },
  },
});
export const sts = new StatefulSet({
  spec: {
    serviceName: "db",
    selector: { matchLabels: { app: "db" } },
    template: { spec: { containers: [{ name: "db", image: "postgres:16" }] } },
    volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }],
  },
});
export const role = new Role({ rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }] });
export const cm = new ConfigMap({ data: { key: "value" } });
// RawExtension stays open.
export const rev = new ControllerRevision({ revision: 1, data: { anything: { goes: true } } });
// JSONSchemaProps refers to itself.
export const crd = new CustomResourceDefinition({
  spec: {
    group: "example.com",
    names: { kind: "Widget", plural: "widgets" },
    scope: "Namespaced",
    versions: [{
      name: "v1", served: true, storage: true,
      schema: { openAPIV3Schema: { type: "object", properties: { spec: { type: "object", properties: { size: { type: "integer" } } } } } },
    }],
  },
});
`,
    });

    expect(errors.global ?? []).toEqual([]);
    expect(errors.valid).toEqual([]);
    expect(errors.replicasString).toEqual(["TS2322: Type 'string' is not assignable to type 'number'."]);
    expect(errors.unknownSpecKey.join("\n")).toMatch(/TS2353: .*'bogusField' does not exist in type 'DeploymentSpec'/);
    expect(errors.unknownContainerKey.join("\n")).toMatch(/TS2561: .*'imag' does not exist in type 'Container'/);
    expect(errors.wrongProbeField.join("\n")).toMatch(/'verb' does not exist in type 'HTTPGetAction'/);
    expect(errors.missingSelector.join("\n")).toMatch(/TS2741: Property 'selector' is missing/);
  });
});
