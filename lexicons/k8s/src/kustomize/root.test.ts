/**
 * Kustomize build roots (#1548 piece 3). What must hold: a configured root
 * renders through the shared runner (kustomize first, kubectl fallback) and
 * its documents become verbatim manifest entities that reach the BUILD
 * output — serialized by the k8s serializer with ownership stamped, carrying
 * the overlay-dir provenance annotation, visible to post-synth checks — and
 * the offline failure modes are sentences naming the problem (the dir, the
 * kustomization file, the binaries), never a stack trace out of a subprocess.
 */
import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { renderKustomizeRoots } from "./root";
import { renderCommand } from "./render";
import { KUSTOMIZE_ROOT_ANNOTATION, isRenderedManifestEntity } from "./rendered-entity";
import { k8sSerializer } from "../serializer";
import { k8sPlugin } from "../plugin";
import { wk8005 } from "../lint/post-synth/wk8005";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "testdata", "kustomize-root");

/** What `kustomize build overlays/prod` over the fixture would emit. */
const RENDERED = `apiVersion: v1
kind: Service
metadata:
  name: prod-web
spec:
  ports:
    - port: 80
  selector:
    app: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prod-web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          env:
            - name: DB_PASSWORD
              value: hunter2
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: prod-web-tls
spec:
  secretName: prod-web-tls
  dnsNames:
    - web.example.com
`;

const cannedRunner = (commands: string[]) => async (command: string) => {
  commands.push(command);
  return { stdout: RENDERED };
};

describe("renderKustomizeRoots", () => {
  test("renders a configured root into verbatim entities with deterministic keys and provenance", async () => {
    const commands: string[] = [];
    const { entities, warnings } = await renderKustomizeRoots({
      projectRoot: fixtureRoot,
      roots: ["overlays/prod"],
      run: cannedRunner(commands),
    });

    expect(commands).toEqual([renderCommand(join(fixtureRoot, "overlays/prod"), "kustomize")]);
    expect(warnings).toEqual([]);
    expect([...entities.keys()]).toEqual([
      "overlays/prod/serviceProdWeb",
      "overlays/prod/deploymentProdWeb",
      "overlays/prod/certificateProdWebTls",
    ]);

    const deployment = entities.get("overlays/prod/deploymentProdWeb")!;
    expect(isRenderedManifestEntity(deployment)).toBe(true);
    expect(deployment.lexicon).toBe("k8s");
    // The generated operation surface's naming, so `lifecycle diff --live`
    // observes a rendered Deployment through the same reader a declared one uses.
    expect(deployment.entityType).toBe("K8s::Apps::Deployment");
    expect(entities.get("overlays/prod/certificateProdWebTls")!.entityType).toBe("K8s::Cert-manager::Certificate");

    const props = (deployment as unknown as { props: Record<string, unknown> }).props;
    const metadata = props.metadata as { annotations: Record<string, string> };
    expect(metadata.annotations[KUSTOMIZE_ROOT_ANNOTATION]).toBe("overlays/prod");
    expect((props.spec as { replicas: number }).replicas).toBe(3);
  });

  test("falls back to kubectl's vendored kustomize when the standalone binary is missing", async () => {
    const commands: string[] = [];
    const { entities } = await renderKustomizeRoots({
      projectRoot: fixtureRoot,
      roots: ["overlays/prod"],
      run: async (command) => {
        commands.push(command);
        if (command.startsWith("kustomize ")) throw new Error("spawn kustomize ENOENT");
        return { stdout: RENDERED };
      },
    });
    const dir = join(fixtureRoot, "overlays/prod");
    expect(commands).toEqual([renderCommand(dir, "kustomize"), renderCommand(dir, "kubectl")]);
    expect(entities.size).toBe(3);
  });

  test("both binaries missing fails with a message naming them, not a stack trace", async () => {
    await expect(
      renderKustomizeRoots({
        projectRoot: fixtureRoot,
        roots: ["overlays/prod"],
        run: async (command) => {
          throw new Error(command.startsWith("kustomize ") ? "spawn kustomize ENOENT" : "spawn kubectl ENOENT");
        },
      }),
    ).rejects.toThrow(/neither the `kustomize` binary nor `kubectl`.*found on PATH/);
  });

  test("a root that does not exist refuses before any subprocess runs", async () => {
    let ran = false;
    await expect(
      renderKustomizeRoots({
        projectRoot: fixtureRoot,
        roots: ["overlays/staging"],
        run: async () => {
          ran = true;
          return { stdout: "" };
        },
      }),
    ).rejects.toThrow(/overlays\/staging.*directory not found/);
    expect(ran).toBe(false);
  });

  test("a dir without a kustomization file refuses, naming the expected files", async () => {
    await expect(
      renderKustomizeRoots({
        projectRoot: fixtureRoot,
        roots: ["base/../.."], // the testdata parent — exists, holds no kustomization
        run: async () => ({ stdout: "" }),
      }),
    ).rejects.toThrow(/no kustomization file.*kustomization\.yaml/);
  });

  test("a rendered document without apiVersion/kind is skipped with a warning", async () => {
    const { entities, warnings } = await renderKustomizeRoots({
      projectRoot: fixtureRoot,
      roots: ["overlays/prod"],
      run: async () => ({ stdout: "just: data\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: web\n" }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("without apiVersion/kind");
    expect([...entities.keys()]).toEqual(["overlays/prod/namespaceWeb"]);
  });
});

describe("kustomize roots through the build pipeline", () => {
  test("rendered docs reach the build output, ownership-stamped, and post-synth checks fire on them", async () => {
    // An empty source dir: the estate keeps its overlay tree and declares no
    // typed manifest — the whole point of a build root.
    const srcDir = join(tmpdir(), `kustomize-root-int-${Date.now()}-${Math.random()}`);
    await mkdir(srcDir, { recursive: true });
    try {
      const result = await build(srcDir, [k8sSerializer], undefined, {
        ownership: { stack: "web", env: "prod" },
        buildRoots: [
          () =>
            renderKustomizeRoots({
              projectRoot: fixtureRoot,
              roots: ["overlays/prod"],
              run: cannedRunner([]),
            }),
        ],
      });

      expect(result.errors).toEqual([]);
      expect(result.entities.size).toBe(3);

      const output = result.outputs.get("k8s");
      expect(output).toBeDefined();
      const yaml = typeof output === "string" ? output : output!.primary;

      // Verbatim manifests, ownership stamped by the serializer's normal merge.
      expect(yaml).toContain("kind: Deployment");
      expect(yaml).toContain("name: prod-web");
      expect(yaml).toContain("app.kubernetes.io/managed-by: chant");
      expect(yaml).toContain("chant.intentius.io/stack: web");
      // Provenance names the overlay the doc came from.
      expect(yaml).toContain(`${KUSTOMIZE_ROOT_ANNOTATION}: overlays/prod`);
      // Render-final shape survives: the CRD instance keeps its own spec.
      expect(yaml).toContain("kind: Certificate");
      expect(yaml).toContain("secretName: prod-web-tls");

      // Post-synth checks see the rendered docs like any other manifests —
      // the fixture Deployment hardcodes a sensitive env var, so WK8005 fires.
      const ctx: PostSynthContext = {
        outputs: result.outputs,
        entities: result.entities,
        buildResult: {
          outputs: result.outputs,
          entities: result.entities,
          warnings: result.warnings,
          errors: [],
          sourceFileCount: result.sourceFileCount,
        },
      };
      const diagnostics = wk8005.check(ctx);
      expect(diagnostics.some((d) => d.message.includes("DB_PASSWORD"))).toBe(true);
    } finally {
      await rm(srcDir, { recursive: true, force: true });
    }
  });

  test("a missing renderer surfaces as a build error naming the binaries", async () => {
    const srcDir = join(tmpdir(), `kustomize-root-miss-${Date.now()}-${Math.random()}`);
    await mkdir(srcDir, { recursive: true });
    try {
      const result = await build(srcDir, [k8sSerializer], undefined, {
        buildRoots: [
          () =>
            renderKustomizeRoots({
              projectRoot: fixtureRoot,
              roots: ["overlays/prod"],
              run: async () => {
                throw new Error("spawn kustomize ENOENT");
              },
            }),
        ],
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain("neither the `kustomize` binary nor `kubectl`");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
    }
  });
});

describe("k8sPlugin.buildRoots", () => {
  test("no configured roots contributes nothing", async () => {
    const contribution = await k8sPlugin.buildRoots!({ projectRoot: fixtureRoot, config: {} });
    expect(contribution.entities.size).toBe(0);
  });

  test("reads k8s.kustomize.roots from the project config namespace", async () => {
    // The real hook uses the subprocess runner, so only the config plumbing is
    // asserted here: a configured root that fails its offline existence check
    // proves the hook read the namespace (no subprocess involved).
    await expect(
      k8sPlugin.buildRoots!({
        projectRoot: fixtureRoot,
        config: { k8s: { kustomize: { roots: ["overlays/missing"] } } },
      }),
    ).rejects.toThrow(/overlays\/missing.*directory not found/);
  });
});
