/**
 * Compiling one environment of a release, and building its artifacts once
 * (#4026, ws-104 question 5), against fixture projects in temp directories.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type DeployContext } from "./capability";
import type { DriverComponent } from "./driver";
import {
  buildReleaseArtifacts,
  buildStepsOf,
  compileEnvironment,
  recordedInputRefs,
  ReleaseCompileError,
  templateRefs,
  withOnlyArchiveSteps,
} from "./release-compile";

const api: DriverComponent = {
  name: "api",
  dependsOn: ["db"],
  deploy: [
    { phase: "Build", steps: [{ kind: "docker-build", context: "api", into: "api.tar" }, { kind: "zip-package", source: "fn", into: "fn.zip" }] },
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar", template: "not-a-template.json" }] },
    {
      phase: "Apply",
      steps: [
        { kind: "gate", gate: "prod" },
        { kind: "cfn-deploy", template: "dist/api.template.json", imageRef: "@Publish.digest" },
        { kind: "cfn-deploy", template: "archive:dist/edge.template.json" },
        { kind: "helm-upgrade", chart: "charts/api", values: ["values/base.yaml", "$env.VALUES"] },
        { kind: "kubectl-apply", manifest: "@Render.path" },
        { phase: "Nested", steps: [{ kind: "kubectl-apply", manifest: "k8s/api.yaml" }] },
      ],
    },
  ],
};

describe("templateRefs", () => {
  test("lists the literal paths in template, manifest and values of deploy steps, without build or publish steps", () => {
    expect(templateRefs(api).map((r) => [r.kind, r.field, r.path])).toEqual([
      ["cfn-deploy", "template", "dist/api.template.json"],
      ["cfn-deploy", "template", "dist/edge.template.json"],
      ["helm-upgrade", "values", "values/base.yaml"],
      ["kubectl-apply", "manifest", "k8s/api.yaml"],
    ]);
  });
});

describe("recordedInputRefs (#4155)", () => {
  test("adds each kind's own fields to the template fields: a chart; a missing one need not exist", () => {
    expect(recordedInputRefs(api).map((r) => [r.kind, r.field, r.path, r.required])).toEqual([
      ["cfn-deploy", "template", "dist/api.template.json", true],
      ["cfn-deploy", "template", "dist/edge.template.json", true],
      ["helm-upgrade", "values", "values/base.yaml", true],
      ["helm-upgrade", "chart", "charts/api", false],
      ["kubectl-apply", "manifest", "k8s/api.yaml", true],
    ]);
  });
});

describe("withOnlyArchiveSteps", () => {
  test("keeps the archive steps alone, drops gates and every other step, and the dependencies", () => {
    expect(withOnlyArchiveSteps(api)).toEqual({
      name: "api",
      dependsOn: [],
      deploy: [{ phase: "Build", steps: [{ kind: "docker-build", context: "api", into: "api.tar" }, { kind: "zip-package", source: "fn", into: "fn.zip" }] }],
    });
    expect(withOnlyArchiveSteps({ name: "x", deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "t.json" }] }] })).toBeUndefined();
  });

  test("buildStepsOf lists the build-time steps in order", () => {
    expect(buildStepsOf(api).map((s) => s.kind)).toEqual(["docker-build", "zip-package"]);
  });
});

function project(dir: string): void {
  writeFileSync(
    join(dir, "api.component.ts"),
    `export const api = {
      name: "api",
      dependsOn: [],
      deploy: [
        { phase: "Build", steps: [{ kind: "docker-build", context: "svc", into: "api.tar" }] },
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
        { phase: "Apply", steps: [{ kind: "gate", gate: "go" }, { kind: "cfn-deploy", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
      ],
    };
    export const off = { name: "off", dependsOn: [], enabled: false, deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/missing.json" }] }] };
    `,
  );
  mkdirSync(join(dir, "svc"), { recursive: true });
  writeFileSync(join(dir, "svc", "Dockerfile"), "FROM scratch\n");
}

describe("compileEnvironment", () => {
  test("runs the build command with CHANT_ENV, then reads the templates the enabled components name", async () => {
    await withTestDir(async (dir) => {
      project(dir);
      const target = await compileEnvironment(
        { projectDir: dir, buildCommand: `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json` },
        "staging",
      );
      expect(target.env).toBe("staging");
      expect(target.components).toEqual(["api"]);
      expect(target.templates).toEqual([{ component: "api", path: "dist/api.template.json", content: `{"env":"staging"}` }]);
      expect(target.buildSteps).toEqual({ api: [{ kind: "docker-build", context: "svc", into: "api.tar" }] });
      expect(target.buildInputs).toEqual({ api: ["svc", "svc/Dockerfile"] });
      expect(target.componentFiles).toEqual({ api: "api.component.ts" });
    });
  });

  test("records a chart directory file by file and names it in trees; a file that is not UTF-8 as base64 (#4155)", async () => {
    await withTestDir(async (dir) => {
      writeFileSync(
        join(dir, "web.component.ts"),
        `export const web = { name: "web", dependsOn: [], deploy: [{ phase: "Deploy", steps: [
          { kind: "helm-upgrade", release: "web", chart: "chart" },
          { kind: "helm-upgrade", release: "remote", chart: "bitnami/nginx", repo: "https://charts.example" },
        ] }] };`,
      );
      mkdirSync(join(dir, "chart", "charts"), { recursive: true });
      writeFileSync(join(dir, "chart", "Chart.yaml"), "name: web\n");
      writeFileSync(join(dir, "chart", "charts", "dep.tgz"), Buffer.from([0x1f, 0x8b, 0xff, 0x00]));
      const target = await compileEnvironment({ projectDir: dir }, "prod");
      expect(target.trees).toEqual([{ component: "web", path: "chart" }]);
      expect(target.templates).toEqual([
        { component: "web", path: "chart/Chart.yaml", content: "name: web\n" },
        { component: "web", path: "chart/charts/dep.tgz", content: Buffer.from([0x1f, 0x8b, 0xff, 0x00]).toString("base64"), encoding: "base64" },
      ]);
    });
  });

  test("refuses when a template a deploy names does not exist after the build", async () => {
    await withTestDir(async (dir) => {
      project(dir);
      const err = await compileEnvironment({ projectDir: dir }, "dev").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReleaseCompileError);
      expect((err as Error).message).toMatch(/reads template "dist\/api.template.json", and no such file exists after the build for "dev"/);
    });
  });

  test("refuses when the build command fails", async () => {
    await withTestDir(async (dir) => {
      project(dir);
      await expect(compileEnvironment({ projectDir: dir, buildCommand: "exit 3" }, "dev")).rejects.toThrow(/the build command for "dev" exited 3/);
    });
  });
});

describe("buildReleaseArtifacts", () => {
  test("runs only the archive steps, once, and names each image and asset with its digest", async () => {
    await withTestDir(async (dir) => {
      writeFileSync(
        join(dir, "api.component.ts"),
        `export const api = {
          name: "api",
          dependsOn: [],
          deploy: [
            { phase: "Build", steps: [{ kind: "docker-build", context: ".", into: "api.tar" }, { kind: "zip-package", source: "fn", into: "fn.zip" }] },
            { phase: "Apply", steps: [{ kind: "gate", gate: "go" }, { kind: "cfn-deploy", template: "t.json" }] },
          ],
        };`,
      );
      const ran: string[] = [];
      const registry = new CapabilityRegistry();
      registry.register({ kind: "docker-build", async run(ctx: DeployContext, input: { into: string }) { ran.push(`${ctx.env}:docker-build`); return { archivePath: input.into, digest: "sha256:img" }; } } as never);
      registry.register({ kind: "zip-package", async run(ctx: DeployContext, input: { into: string }) { ran.push(`${ctx.env}:zip-package`); return { archivePath: input.into, digest: "sha256:zip" }; } } as never);
      registry.register({ kind: "cfn-deploy", async run() { ran.push("cfn-deploy"); return {}; } } as never);
      const artifacts = await buildReleaseArtifacts({ projectDir: dir }, "dev", ["api"], registry);
      expect(ran).toEqual(["dev:docker-build", "dev:zip-package"]);
      expect(artifacts).toEqual([
        { component: "api", kind: "image", path: "api.tar", digest: "sha256:img" },
        { component: "api", kind: "asset", path: "fn.zip", digest: "sha256:zip" },
      ]);
    });
  });
});
