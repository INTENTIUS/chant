import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { carveBridge } from "./carve-bridge";
import { loadHcl2json } from "../../terraform/parse";
import type { ImportResult, LiveImportOptions } from "./import";
import type { LexiconPlugin } from "../../lexicon";

/**
 * `carve emit` over the kubernetes provider (#999), end to end: a Terraform
 * estate that manages Kubernetes objects through `kubernetes_manifest`, carved
 * into a buildable chant project for the k8s lexicon.
 *
 * The point of the fixture is the second resource. A `kubernetes_manifest` has
 * no fixed entity type — the kind is inside the body — so a cert-manager
 * Certificate and a core ConfigMap go through the identical path, which is what
 * "one rule covers every CRD" has to mean in practice.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = `
resource "kubernetes_namespace" "web" {
  metadata {
    name = "web"
  }
}

resource "kubernetes_manifest" "app_config" {
  manifest = {
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata = {
      name      = "app-config"
      namespace = kubernetes_namespace.web.metadata[0].name
    }
    data = {
      LOG_LEVEL = "info"
    }
  }
}

resource "kubernetes_manifest" "web_cert" {
  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "Certificate"
    metadata = {
      name      = "web-tls"
      namespace = "web"
    }
    spec = {
      secretName = "web-tls"
      dnsNames   = ["web.example.com"]
    }
  }
}

resource "kubernetes_config_map" "legacy" {
  metadata {
    name      = "legacy"
    namespace = "web"
  }
  data = {
    OLD = "true"
  }
}
`;

const TFSTATE = JSON.stringify({
  version: 4,
  resources: [
    {
      mode: "managed",
      type: "kubernetes_manifest",
      name: "app_config",
      instances: [
        {
          attributes: {
            manifest: {
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: { name: "app-config", namespace: "web", labels: { "app.kubernetes.io/name": "web" } },
              data: { LOG_LEVEL: "info" },
            },
            computed_fields: ["metadata.labels", "metadata.annotations"],
            field_manager: null,
          },
        },
      ],
    },
    {
      mode: "managed",
      type: "kubernetes_manifest",
      name: "web_cert",
      instances: [
        {
          attributes: {
            manifest: {
              apiVersion: "cert-manager.io/v1",
              kind: "Certificate",
              metadata: { name: "web-tls", namespace: "web" },
              spec: { secretName: "web-tls", dnsNames: ["web.example.com"] },
            },
          },
        },
      ],
    },
    {
      mode: "managed",
      type: "kubernetes_config_map",
      name: "legacy",
      instances: [{ attributes: { id: "web/legacy", data: { OLD: "true" } } }],
    },
  ],
});

const fakeImport = () =>
  vi.fn(
    async (_plugins: LexiconPlugin[], _options: LiveImportOptions): Promise<ImportResult> => ({
      success: true,
      generatedFiles: ["infra/main.ts"],
      warnings: [],
    }),
  );

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-k8s-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    writeFileSync(join(dir, "terraform.tfstate"), TFSTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carve emit — kubernetes_manifest (#999)", () => {
  test("carves a ConfigMap manifest into a buildable k8s project", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const liveImport = fakeImport();
      const res = await carveEmit(
        { from: dir, select: "kubernetes_manifest.app_config", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );

      expect(res.ok).toBe(true);
      expect(res.source).toBe("tfstate");
      expect(liveImport).not.toHaveBeenCalled();

      const source = readFileSync(join(out, "src", "app_config.ts"), "utf-8");
      expect(source).toContain('import { k8sManifest } from "@intentius/chant-lexicon-k8s";');
      expect(source).toContain("export const app_config = k8sManifest({");
      expect(source).toContain('apiVersion: "v1"');
      expect(source).toContain('kind: "ConfigMap"');
      expect(source).toContain('"app.kubernetes.io/name": "web"');
      expect(source).toContain("-> v1 ConfigMap");

      // The scaffold targets the provider's lexicon, so the emitted project
      // builds with `npm install && npm run build` as it stands.
      const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8"));
      expect(pkg.scripts.build).toBe("chant build src --lexicon k8s");
      expect(Object.keys(pkg.dependencies)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-k8s"]);
      expect(readFileSync(join(out, "chant.config.ts"), "utf-8")).toContain('lexicons: ["k8s"]');

      // The namespace the manifest read is a survivor, so it is an outbound
      // edge and becomes a declared build parameter.
      expect(res.params?.map((p) => p.name)).toEqual(["manifest"]);
      expect(source).toContain("Deferred deploy-time input: manifest read kubernetes_namespace.web");
      // Nothing is substituted: state resolved `manifest` to the whole object.
      expect(source).not.toContain("params.");

      expect(res.manifestPath).toBe(join(out, "kubernetes_manifest-app_config.carve.json"));
      expect(formatCarveEmit(res)).toContain("Adopted from Terraform state (offline).");
    });
  });

  test("a CRD manifest carves through the same path as a core kind", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveEmit(
        { from: dir, select: "kubernetes_manifest.web_cert", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport: fakeImport() },
      );

      expect(res.ok).toBe(true);
      const source = readFileSync(join(out, "src", "web_cert.ts"), "utf-8");
      expect(source).toContain("-> cert-manager.io/v1 Certificate");
      expect(source).toContain('apiVersion: "cert-manager.io/v1"');
      expect(source).toContain('kind: "Certificate"');
      expect(source).toContain('secretName: "web-tls"');
      expect(source).toContain('"web.example.com",');
      // No CRD-specific mapping was needed, so nothing was left behind.
      expect(source).not.toContain("TODO");
    });
  });

  test("--env refuses: the kind is in the body, so a live export has nothing to filter on", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const liveImport = fakeImport();
      const res = await carveEmit(
        { from: dir, select: "kubernetes_manifest.app_config", env: "prod" },
        { plugins: [], liveImport },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("no live adoption path");
      expect(res.error).toContain("--state");
      expect(liveImport).not.toHaveBeenCalled();
    });
  });

  test("a typed kubernetes resource ranks but is refused identically on both paths", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const liveImport = fakeImport();
      const live = await carveEmit(
        { from: dir, select: "kubernetes_config_map.legacy", env: "prod" },
        { plugins: [], liveImport },
      );
      const state = await carveEmit(
        { from: dir, select: "kubernetes_config_map.legacy", statePath: join(dir, "terraform.tfstate") },
        { plugins: [], liveImport },
      );
      expect(live.ok).toBe(false);
      expect(state.error).toBe(live.error);
      expect(live.error).toContain("kubernetes_config_map cannot be emitted yet");
      expect(live.error).toContain("kubernetes_manifest");
      expect(liveImport).not.toHaveBeenCalled();
    });
  });

  test("bridge still refuses the carved manifest, so emit writes no half-bridged estate", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const emitted = await carveEmit(
        { from: dir, select: "kubernetes_manifest.app_config", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport: fakeImport() },
      );
      expect(emitted.ok).toBe(true);

      // Emit does not unlock bridge: `manifest.metadata.name` is a path into
      // nested blocks and a data-source body is flat `attr = value`, so the
      // survivors' references cannot be repointed yet.
      const bridged = await carveBridge({ from: dir, select: "kubernetes_manifest.app_config", output: out });
      expect(bridged.ok).toBe(false);
      expect(bridged.error).toContain("cannot be bridged");
      expect(bridged.error).toContain("manifest.metadata.name");
      expect(existsSync(join(out, "kubernetes_manifest-app_config-runbook.md"))).toBe(false);
    });
  });
});
