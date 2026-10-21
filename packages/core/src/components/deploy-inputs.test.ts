import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { componentDeployInputs, directoryDigest, directoryFiles, stepInputRefs } from "./deploy-inputs";
import { componentPlanDigest } from "./gate-plan";
import type { DriverComponent, DriverPhase } from "./driver";

let root: string;

const write = (path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const deploy = (...steps: Array<Record<string, unknown>>): DriverPhase[] => [{ phase: "Deploy", steps: steps as never }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-inputs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stepInputRefs", () => {
  test("a kind's own fields and the template fields, literal paths only", () => {
    const refs = stepInputRefs("Deploy", { kind: "helm-upgrade", release: "web", chart: "chart", values: ["a.yaml", "@Cfg.values"] } as never);
    expect(refs.map((r) => [r.field, r.path])).toEqual([["values", "a.yaml"], ["chart", "chart"]]);
  });

  test("an archive path or a wired value is a build output and is not named", () => {
    expect(stepInputRefs("Deploy", { kind: "cfn-deploy", template: "archive:stack.json" } as never)).toEqual([]);
    expect(stepInputRefs("Deploy", { kind: "s3-sync", from: "@Build.dir", to: "s3://b" } as never)).toEqual([]);
  });

  test("a Docker build's Dockerfile is named under its context", () => {
    const refs = stepInputRefs("Build", { kind: "docker-build", context: "app", dockerfile: "Dockerfile.prod" } as never);
    expect(refs.map((r) => r.path)).toEqual(["app", "app/Dockerfile.prod"]);
  });
});

describe("componentDeployInputs", () => {
  test("a file by its bytes, a directory by its files; a missing path is left out", () => {
    write("values.yaml", "a: 1\n");
    write("chart/Chart.yaml", "name: c\n");
    const read = componentDeployInputs(deploy({ kind: "helm-upgrade", chart: "chart", values: ["values.yaml", "gone.yaml"] }), root);
    expect(read.inputs.map((i) => i.path)).toEqual(["chart", "values.yaml"]);
    expect(read.inputs.find((i) => i.path === "values.yaml")?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(read.unbound).toEqual([]);
  });

  test("a directory's digest moves with a file's bytes, a new file and a renamed one", () => {
    write("site/index.html", "<h1>a</h1>");
    const before = directoryDigest(root, "site");
    write("site/index.html", "<h1>b</h1>");
    const edited = directoryDigest(root, "site");
    expect(edited).not.toBe(before);
    write("site/about.html", "x");
    expect(directoryDigest(root, "site")).not.toBe(edited);
  });

  test("the same files under another parent hash the same: the digest reads paths from the directory", () => {
    write("a/chart/Chart.yaml", "name: c\n");
    write("b/chart/Chart.yaml", "name: c\n");
    expect(directoryDigest(root, "a/chart")).toBe(directoryDigest(root, "b/chart"));
  });

  test("in a git repository, a directory leaves out what git ignores, and a directory git ignores is a build output", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(".gitignore", "node_modules/\ndist/\n");
    write("app/server.js", "1");
    write("app/node_modules/dep/index.js", "1");
    write("dist/index.html", "1");
    expect(directoryFiles(root, "app")).toEqual(["app/server.js"]);
    const read = componentDeployInputs(deploy({ kind: "docker-build", context: "app" }, { kind: "s3-sync", from: "dist", to: "s3://b" }), root);
    expect(read.inputs.map((i) => i.path)).toEqual(["app"]);
    expect(read.unbound).toEqual([{ phase: "Deploy", kind: "s3-sync", reason: expect.stringMatching(/"dist" is a directory git ignores, so a build output/) }]);
  });

  test("a file git ignores is still hashed when a step names it, as a template chant build writes", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(".gitignore", "dist/\n");
    write("dist/stack.json", "{}");
    expect(componentDeployInputs(deploy({ kind: "cfn-deploy", template: "dist/stack.json" }), root).inputs.map((i) => i.path)).toEqual(["dist/stack.json"]);
  });

  test("a shell step is unbound; `include` limits the steps read", () => {
    write("chart/Chart.yaml", "x");
    const phases = deploy({ kind: "shell", cmd: "./go.sh", reason: "t" }, { kind: "helm-upgrade", chart: "chart" });
    expect(componentDeployInputs(phases, root).unbound.map((u) => u.kind)).toEqual(["shell"]);
    expect(componentDeployInputs(phases, root, (s) => s.kind !== "helm-upgrade").inputs).toEqual([]);
  });
});

describe("componentPlanDigest with inputs", () => {
  const component: DriverComponent = { name: "web", dependsOn: [], deploy: deploy({ kind: "helm-upgrade", chart: "chart" }) };

  test("no inputs keeps the digest a composition had before #4155", () => {
    expect(componentPlanDigest({ environment: "prod", component, inputs: [] })).toBe(componentPlanDigest({ environment: "prod", component }));
  });

  test("an input's digest moves the plan digest", () => {
    const a = componentPlanDigest({ environment: "prod", component, inputs: [{ path: "chart", digest: "sha256:aa" }] });
    const b = componentPlanDigest({ environment: "prod", component, inputs: [{ path: "chart", digest: "sha256:bb" }] });
    expect(a).not.toBe(b);
  });
});
