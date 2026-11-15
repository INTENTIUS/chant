/**
 * `chant import <directory>` (#5115): the files the k8s lexicon reads, and
 * what a directory import writes and builds.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import { importCommand, type ImportResult } from "@intentius/chant/cli/commands/import";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";
import { k8sPlugin } from "../plugin";
import { k8sSerializer } from "../serializer";
import { selectManifestFiles } from "./directory";
import { pkgDir, read } from "./testdata/embedded/fixtures";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` under a fresh directory inside this package, so the lexicons resolve as they would in a project. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "name": "k8s-directory-import", "private": true, "type": "module" }\n');
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["k8s", "prometheus"] };\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "in", path)), { recursive: true });
    writeFileSync(join(dir, "in", path), content);
  }
  return dir;
}

function walk(dir: string, root: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out[relative(root, path)] = readFileSync(path, "utf-8");
  }
  return out;
}

async function importTree(files: Record<string, string>, options: { detect?: boolean } = {}) {
  const dir = tree(files);
  const output = join(dir, "src");
  const result: ImportResult = await importCommand({ templatePath: join(dir, "in"), output, ...(options.detect ? {} : { lexicon: "k8s" }) });
  return { dir, output, result, files: existsSync(output) ? walk(output, output) : {} };
}

async function buildAndCheck(output: string) {
  const built = await build(output, [k8sSerializer, prometheusSerializer]);
  const out = built.outputs.get("k8s");
  const diagnostics = runPostSynthChecks(k8sPlugin.postSynthChecks!(), {
    ...built,
    outputs: new Map(out === undefined ? [] : [["k8s", out]]),
  });
  const primary = typeof out === "string" ? out : (out?.primary ?? "");
  return { built, diagnostics, objects: loadAll(primary).filter(Boolean) as Array<Record<string, any>> };
}

const roleBinding = `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: reader
  namespace: web
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
subjects:
  - kind: ServiceAccount
    name: app
    namespace: web
`;
const role = `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: web
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list]
`;
const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: web
spec:
  selector:
    matchLabels: { app: app }
  template:
    metadata:
      labels: { app: app }
    spec:
      containers:
        - name: app
          image: example/app:1.0
          envFrom:
            - secretRef: { name: app-credentials }
`;
const secret = `apiVersion: v1
kind: Secret
metadata:
  name: app-credentials
  namespace: web
stringData:
  token: placeholder
`;

describe("selectManifestFiles", () => {
  test("reads files at any depth, skips chart templates and a kustomization, and reads only what a kustomization lists", () => {
    const dir = tree({
      "plain/a.yaml": role,
      "plain/deep/b.yml": roleBinding,
      "chart/t.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Values.name }}\n",
      "kust/kustomization.yaml": "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\n  - sub/secret.yaml\npatches:\n  - path: patch.yaml\n",
      "kust/deploy.yaml": deployment,
      "kust/patch.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  replicas: 3\n",
      "kust/sub/secret.yaml": secret,
      "kust/values.yaml": "replicas: 2\n",
    });
    const root = join(dir, "in");
    const files = [
      "chart/t.yaml",
      "kust/deploy.yaml",
      "kust/kustomization.yaml",
      "kust/patch.yaml",
      "kust/sub/secret.yaml",
      "kust/values.yaml",
      "plain/a.yaml",
      "plain/deep/b.yml",
    ].map((f) => join(root, f));
    const { files: selected, warnings } = selectManifestFiles({ directory: root, files });
    expect(selected.map((f) => relative(root, f))).toEqual(["kust/deploy.yaml", "kust/sub/secret.yaml", "plain/a.yaml", "plain/deep/b.yml"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.startsWith("chart/t.yaml"))).toContain("template syntax");
    const kust = warnings.find((w) => w.startsWith("kust/kustomization.yaml"))!;
    expect(kust).toContain("kust/patch.yaml, kust/values.yaml");
    expect(kust).toContain("chant import --kustomize kust");
  });

  test("a Flux Kustomization named kustomization.yaml is an object and is read", () => {
    const dir = tree({
      "flux/kustomization.yaml": "apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: apps\nspec:\n  path: ./apps\n",
    });
    const root = join(dir, "in");
    const { files, warnings } = selectManifestFiles({ directory: root, files: [join(root, "flux/kustomization.yaml")] });
    expect(files).toEqual([join(root, "flux/kustomization.yaml")]);
    expect(warnings).toEqual([]);
  });
});

describe("chant import <directory>", () => {
  test("one module per file at the file's own path, a skip warning for each file that is not a manifest", async () => {
    const { result, files } = await importTree({
      "rbac/binding.yaml": roleBinding,
      "rbac/role.yml": role,
      "chart/t.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Values.name }}\n",
      "values.yaml": "replicaCount: 2\n",
      "empty.yaml": "# nothing here\n",
    });
    expect(result.success).toBe(true);
    expect(Object.keys(files).sort()).toEqual(["rbac/binding.ts", "rbac/role.ts"]);
    expect(files["rbac/binding.ts"]).toContain("// Source: rbac/binding.yaml");
    expect(files["rbac/role.ts"]).toContain("// Source: rbac/role.yml");
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain("chart/t.yaml holds template syntax");
    expect(warnings).toContain("values.yaml is not a k8s template and was skipped");
    expect(warnings).toContain("empty.yaml is not a k8s template and was skipped");
  });

  test("the lexicon is detected from the directory when none is named", async () => {
    const { result, files } = await importTree({ "a.yaml": role }, { detect: true });
    expect(result.success).toBe(true);
    expect(result.detected).toBe(true);
    expect(Object.keys(files)).toEqual(["a.ts"]);
  });

  test("a directory with no template of the lexicon fails", async () => {
    const { result } = await importTree({ "values.yaml": "replicaCount: 2\n" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No k8s templates found");
  });

  test("cross-file rules see the whole directory: a Secret in another file is produced, a Role in another file is read", async () => {
    const together = await importTree({ "deploy.yaml": deployment, "secrets/app.yaml": secret, "rbac/b.yaml": roleBinding, "rbac/r.yaml": role });
    const joined = await buildAndCheck(together.output);
    expect(joined.built.errors).toEqual([]);
    expect(joined.diagnostics.filter((d) => d.checkId === "WK8503")).toEqual([]);

    // The same Deployment imported alone reports the Secret as missing.
    const alone = await importTree({ "deploy.yaml": deployment });
    const lonely = await buildAndCheck(alone.output);
    expect(lonely.diagnostics.filter((d) => d.checkId === "WK8503")).toHaveLength(1);

    // And a Secret that is in no file is still reported over the whole directory.
    const missing = await importTree({ "deploy.yaml": deployment, "rbac/r.yaml": role });
    expect((await buildAndCheck(missing.output)).diagnostics.filter((d) => d.checkId === "WK8503")).toHaveLength(1);
  });

  test("identifiers stay unique across files, and the build gives back every object", async () => {
    const cm = (name: string, namespace?: string) =>
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${JSON.stringify(name)}\n${namespace ? `  namespace: ${namespace}\n` : ""}data:\n  k: v\n`;
    const input = {
      "one.yaml": cm("a:b"),
      "two/two.yaml": cm("a-b"),
      "two/three.yaml": cm("a-b", "other"),
      "four.yaml": cm("a-b", "other") + "---\n" + cm("a_b"),
    };
    const { result, files, output } = await importTree(input);
    expect(result.success).toBe(true);
    const names = Object.values(files).flatMap((src) => [...src.matchAll(/^export const (\w+) = /gm)].map((m) => m[1]));
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    const { built, objects } = await buildAndCheck(output);
    expect(built.errors).toEqual([]);
    expect(objects.map((o) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`).sort()).toEqual(["/a-b", "/a:b", "/a_b", "other/a-b", "other/a-b"]);
  });

  test("two AlertmanagerConfigs in one directory keep their own routes and receivers and build back unchanged", async () => {
    const first = read("alertmanagerconfig.yaml");
    const second = first.replace("name: main", "name: second").replace("namespace: monitoring", "namespace: other").replace("alertmanagerConfig: main", "alertmanagerConfig: second");
    const { result, files, output } = await importTree({ "monitoring/first.yaml": first, "other/second.yaml": second });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const dirs = [...new Set(Object.keys(files).filter((p) => /^(main|second)-/.test(p)).map((p) => p.split("/")[0]))].sort();
    expect(dirs).toEqual(["main-inhibit-rules", "main-mute-time-intervals", "main-receivers", "main-route", "second-inhibit-rules", "second-mute-time-intervals", "second-receivers", "second-route"]);
    expect(files["monitoring/first.ts"]).toContain('from "../main-route/routes"');
    expect(files["other/second.ts"]).toContain('from "../second-route/routes"');
    for (const dir of ["main-route", "second-route"]) expect(files[`${dir}/routes.ts`]).toMatch(/export const declared = \{ root \};/);

    const { built, objects } = await buildAndCheck(output);
    expect(built.errors).toEqual([]);
    expect(objects).toEqual([...(loadAll(first).filter(Boolean) as object[]), ...(loadAll(second).filter(Boolean) as object[])]);
    // The declarations are not exported one by one, so no alertmanager.yml is built from them.
    expect([...built.outputs.keys()].filter((k) => k !== "k8s")).toEqual([]);
  });
});
