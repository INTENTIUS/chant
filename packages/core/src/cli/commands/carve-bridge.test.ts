import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveBridge, formatCarveBridge } from "./carve-bridge";
import { loadHcl2json } from "../../terraform/parse";
import { registerCarveProvider } from "../../terraform/carve-provider";
import { readCarveManifest, writeCarveManifest, type CarveManifest } from "../../terraform/manifest";

let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const BUCKET_TF = `resource "aws_s3_bucket" "assets" {
  bucket = "myapp-assets-prod"
}
`;
const API_TF = `resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
    }
  }
}
`;

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-bridge-"));
  try {
    writeFileSync(join(dir, "bucket.tf"), BUCKET_TF);
    writeFileSync(join(dir, "api.tf"), API_TF);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifestFor(target: string, dir: string): CarveManifest {
  return {
    version: 1,
    target,
    from: dir,
    boundary: {
      target,
      carveSet: [{ address: target, type: target.split(".")[0] }],
      peelability: 90,
      inbound: [],
      outbound: [],
      reversible: true,
      diagnostics: [],
    },
  };
}

describe("carveBridge", () => {
  test("requires --from; without --select it needs a carve manifest", async () => {
    expect((await carveBridge({})).error).toContain("--from");
    await withEstate(async (dir) => {
      const res = await carveBridge({ from: dir });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("--select");
      expect(res.error).toContain("carve emit");
    });
  });

  test("composes with the carve manifest: target resolved without --select, bridge recorded", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      writeCarveManifest(out, manifestFor("aws_s3_bucket.assets", dir));

      const res = await carveBridge({ from: dir, output: out });
      expect(res.ok).toBe(true);
      expect(res.selectFromManifest).toBe(true);
      expect(res.plan!.target).toBe("aws_s3_bucket.assets");
      expect(formatCarveBridge(res)).toContain("target from the carve manifest");

      const m = readCarveManifest(res.manifestPath!)!;
      expect(m.bridge!.written.length).toBeGreaterThan(0);
      expect(m.bridge!.appliedInPlace).toBe(false);
      // The boundary is refreshed from the estate, not left as the stub.
      expect(m.boundary.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);
    });
  });

  test("dry-run: writes runbook + data sources + proposed survivor, touches no .tf in place", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.appliedInPlace).toBeFalsy();

      // Runbook + data sources + proposed api.tf were written to the output dir.
      expect(existsSync(join(out, "aws_s3_bucket-assets-runbook.md"))).toBe(true);
      const ds = readFileSync(join(out, "aws_s3_bucket-assets-datasources.tf"), "utf-8");
      expect(ds).toContain('data "aws_s3_bucket" "assets"');
      const proposed = readFileSync(join(out, "api.tf"), "utf-8");
      expect(proposed).toContain("data.aws_s3_bucket.assets.bucket");

      // The ORIGINAL api.tf in the estate is untouched.
      expect(readFileSync(join(dir, "api.tf"), "utf-8")).toBe(API_TF);
    });
  });

  test("emits one git-applyable patch carrying the whole survivor edit", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.patchPath).toBe(join(out, "aws_s3_bucket-assets-bridge.patch"));
      expect(res.written).toContain(res.patchPath);

      const patch = readFileSync(res.patchPath!, "utf-8");
      expect(patch).toContain("diff --git a/aws_s3_bucket-assets-datasources.tf b/aws_s3_bucket-assets-datasources.tf");
      expect(patch).toContain("new file mode 100644");
      expect(patch).toContain("diff --git a/api.tf b/api.tf");
      expect(patch).toContain("-      ASSETS_BUCKET = aws_s3_bucket.assets.bucket");
      expect(patch).toContain("+      ASSETS_BUCKET = data.aws_s3_bucket.assets.bucket");

      const m = readCarveManifest(res.manifestPath!)!;
      // The manifest records the patch relative to its own directory (#2039).
      expect(m.bridge!.patch).toBe("aws_s3_bucket-assets-bridge.patch");
      expect(formatCarveBridge(res)).toContain("git apply");

      // The patch really applies: `git apply` from the estate reproduces the
      // rewired survivor and the new data-source file.
      try {
        execFileSync("git", ["apply", res.patchPath!], { cwd: dir });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no git on this machine
        throw err;
      }
      expect(readFileSync(join(dir, "api.tf"), "utf-8")).toContain("data.aws_s3_bucket.assets.bucket");
      expect(readFileSync(join(dir, "aws_s3_bucket-assets-datasources.tf"), "utf-8")).toContain('data "aws_s3_bucket" "assets"');
    });
  });

  test("--apply-rewrites edits the survivor .tf in place", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveBridge({
        from: dir,
        select: "aws_s3_bucket.assets",
        output: join(dir, "carveout"),
        applyRewrites: true,
      });
      expect(res.ok).toBe(true);
      expect(res.appliedInPlace).toBe(true);

      // api.tf rewritten in place; bucket.tf's carved declaration excised
      // (#998 — after `terraform state rm`, the block would re-create it).
      const api = readFileSync(join(dir, "api.tf"), "utf-8");
      expect(api).toContain("data.aws_s3_bucket.assets.bucket");
      expect(readFileSync(join(dir, "bucket.tf"), "utf-8")).not.toContain('resource "aws_s3_bucket" "assets"');
    });
  });

  test("an output-only dependency is patched, not left dangling (#1638)", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-outputs-"));
    try {
      // Nothing but an output reads the bucket. Before outputs entered the
      // graph this produced no data source and no rewrite at all, so the
      // surviving plan broke on the dangling reference at handoff.
      writeFileSync(join(dir, "bucket.tf"), BUCKET_TF);
      writeFileSync(
        join(dir, "outputs.tf"),
        `output "assets_bucket" {\n  value = aws_s3_bucket.assets.bucket\n}\n`,
      );
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.plan!.outputRewrites).toEqual(["output.assets_bucket"]);

      expect(readFileSync(join(out, "aws_s3_bucket-assets-datasources.tf"), "utf-8")).toContain(
        'data "aws_s3_bucket" "assets"',
      );
      expect(readFileSync(join(out, "outputs.tf"), "utf-8")).toContain("value = data.aws_s3_bucket.assets.bucket");

      const patch = readFileSync(res.patchPath!, "utf-8");
      expect(patch).toContain("diff --git a/outputs.tf b/outputs.tf");
      expect(patch).toContain("-  value = aws_s3_bucket.assets.bucket");
      expect(patch).toContain("+  value = data.aws_s3_bucket.assets.bucket");
      expect(formatCarveBridge(res)).toContain("1 output block(s) repointed at the data source: output.assets_bucket");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a dotted-identity type no provider declares a shape for (#2015, #2034)", async () => {
    if (!parserAvailable) return;
    // A dotted identity attribute is a path into nested values, and a data body
    // is flat `attr = value` — `spec.metadata.name = "x"` is not valid HCL. The
    // guard now turns on the missing shape, not on the dot, so the message says
    // what would lift it.
    const unregister = registerCarveProvider({
      name: "carve-bridge-test-nested",
      tfTypePrefixes: ["nested_"],
      lexicon: "aws",
      tiers: { nested_widget: { tier: 1, mapsTo: "Test::Widget" } },
      identityAttrs: { nested_widget: "spec.metadata.name" },
    });
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-nested-"));
    try {
      writeFileSync(
        join(dir, "main.tf"),
        `resource "nested_widget" "demo" {\n  spec {\n    metadata {\n      name = "demo"\n    }\n  }\n}\n`,
      );
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "nested_widget.demo", output: out });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("cannot be bridged");
      expect(res.error).toContain("spec.metadata.name");
      expect(res.error).toContain("no carve provider declares a data-source shape for it");
      expect(res.error).toContain("dataSourceShapes");
      expect(res.plan).toBeUndefined();
      expect(existsSync(out)).toBe(false);
    } finally {
      unregister();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

/**
 * `kubernetes_manifest` reads back through a different type (#2034). The
 * kubernetes provider ships no `kubernetes_manifest` data source — verified
 * against hashicorp/kubernetes v3.2.1 — so the bridge renders
 * `data "kubernetes_resource"` from the manifest's own apiVersion, kind and
 * metadata, and repoints survivors at that data source's attribute path.
 */
describe("carveBridge — kubernetes_manifest (#2034)", () => {
  const MANIFEST_TF = `resource "kubernetes_manifest" "app_config" {
  manifest = {
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata = {
      name      = "app-config"
      namespace = "apps"
    }
    data = {
      LOG_LEVEL = "info"
    }
  }
}
`;
  // Three shapes of inbound reference: the issue's own example, one deeper into
  // `object`, and one through `manifest` — the attribute the data source does
  // NOT have, which is why the rewrite maps it rather than only swapping heads.
  const SURVIVOR_TF = `resource "kubernetes_config_map" "mirror" {
  metadata {
    name      = kubernetes_manifest.app_config.object.metadata.name
    namespace = "apps"
  }
  data = {
    LOG_LEVEL = kubernetes_manifest.app_config.manifest.data.LOG_LEVEL
    UPSTREAM  = kubernetes_manifest.app_config.object.data.LOG_LEVEL
  }
}
`;
  const OUTPUTS_TF = `output "app_config_name" {
  value = kubernetes_manifest.app_config.object.metadata.name
}
`;

  async function withManifestEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-manifest-"));
    try {
      writeFileSync(join(dir, "manifest.tf"), MANIFEST_TF);
      writeFileSync(join(dir, "survivor.tf"), SURVIVOR_TF);
      writeFileSync(join(dir, "outputs.tf"), OUTPUTS_TF);
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("bridges to a data \"kubernetes_resource\" block built from the manifest body", async () => {
    if (!parserAvailable) return;
    await withManifestEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "kubernetes_manifest.app_config", output: out });
      expect(res.ok).toBe(true);

      // The data source is the provider's generic read, not the carved type.
      expect(res.plan!.dataSources).toHaveLength(1);
      expect(res.plan!.dataSources[0]).toMatchObject({
        address: "kubernetes_manifest.app_config",
        type: "kubernetes_resource",
        name: "app_config",
      });
      expect(res.plan!.dataSources[0].hcl).toBe(
        `data "kubernetes_resource" "app_config" {\n` +
          `  api_version = "v1"\n` +
          `  kind        = "ConfigMap"\n` +
          `\n` +
          `  metadata {\n` +
          `    name      = "app-config"\n` +
          `    namespace = "apps"\n` +
          `  }\n` +
          `}`,
      );
      expect(formatCarveBridge(res)).toContain(
        "data.kubernetes_resource.app_config  (was kubernetes_manifest.app_config)",
      );
    });
  });

  test("the emitted data source parses as HCL and is terraform-fmt clean", async () => {
    if (!parserAvailable) return;
    await withManifestEstate(async (dir) => {
      const out = join(dir, "carveout");
      await carveBridge({ from: dir, select: "kubernetes_manifest.app_config", output: out });
      const dsPath = join(out, "kubernetes_manifest-app_config-datasources.tf");
      const hcl = readFileSync(dsPath, "utf-8");

      // The repo's own parser: `metadata` has to come out as a block, since the
      // provider declares it Block List (Min 1, Max 1), not an attribute.
      const parsed = await (await loadHcl2json()).parse("datasources.tf", hcl);
      const ds = (parsed.data as Record<string, Record<string, unknown[]>>).kubernetes_resource.app_config[0] as Record<
        string,
        unknown
      >;
      expect(ds.api_version).toBe("v1");
      expect(ds.kind).toBe("ConfigMap");
      expect(ds.metadata).toEqual([{ name: "app-config", namespace: "apps" }]);

      // And Terraform's own formatter accepts it byte for byte.
      try {
        execFileSync("terraform", ["fmt", "-check", "-diff", dsPath], { stdio: "pipe" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no terraform on this machine
        throw err;
      }
    });
  });

  test("survivor references follow the data source's own attribute path", async () => {
    if (!parserAvailable) return;
    await withManifestEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "kubernetes_manifest.app_config", output: out });
      expect(res.ok).toBe(true);

      const survivor = readFileSync(join(out, "survivor.tf"), "utf-8");
      // The issue's example, and a reference that goes deeper into `object`.
      expect(survivor).toContain("name      = data.kubernetes_resource.app_config.object.metadata.name");
      expect(survivor).toContain("UPSTREAM  = data.kubernetes_resource.app_config.object.data.LOG_LEVEL");
      // `manifest` is an attribute of the resource that the data source does not
      // have; left alone it would be an "Unsupported attribute" at validate.
      expect(survivor).toContain("LOG_LEVEL = data.kubernetes_resource.app_config.object.data.LOG_LEVEL");
      expect(survivor).not.toContain(".manifest.");
      expect(survivor).not.toMatch(/(?<!data\.)\bkubernetes_manifest\.app_config\b/);

      // An output reading the manifest is repointed the same way (#1638).
      expect(res.plan!.outputRewrites).toEqual(["output.app_config_name"]);
      expect(readFileSync(join(out, "outputs.tf"), "utf-8")).toContain(
        "value = data.kubernetes_resource.app_config.object.metadata.name",
      );

      // The carved block leaves the survivor source, as for any other type.
      expect(res.plan!.excised).toEqual(["kubernetes_manifest.app_config"]);
      expect(readFileSync(join(out, "manifest.tf"), "utf-8").trim()).toBe("");
    });
  });

  test("a namespace-less manifest omits the optional argument", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-clusterwide-"));
    try {
      // A cluster-scoped kind has no namespace, and `metadata.namespace` is
      // optional on the data source — so it is left out, not emitted empty.
      writeFileSync(
        join(dir, "main.tf"),
        `resource "kubernetes_manifest" "reader" {\n` +
          `  manifest = {\n` +
          `    apiVersion = "rbac.authorization.k8s.io/v1"\n` +
          `    kind       = "ClusterRole"\n` +
          `    metadata = {\n` +
          `      name = "reader"\n` +
          `    }\n` +
          `  }\n` +
          `}\n`,
      );
      writeFileSync(
        join(dir, "outputs.tf"),
        `output "reader" {\n  value = kubernetes_manifest.reader.object.metadata.name\n}\n`,
      );
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "kubernetes_manifest.reader", output: out });
      expect(res.ok).toBe(true);
      const hcl = res.plan!.dataSources[0].hcl;
      expect(hcl).toContain('api_version = "rbac.authorization.k8s.io/v1"');
      expect(hcl).toContain('name = "reader"');
      expect(hcl).not.toContain("namespace");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an interpolated manifest name falls back to the TODO body, never a half-written block", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-interp-"));
    try {
      writeFileSync(
        join(dir, "main.tf"),
        `variable "suffix" {\n  type = string\n}\n\n` +
          `resource "kubernetes_manifest" "app_config" {\n` +
          `  manifest = {\n` +
          `    apiVersion = "v1"\n` +
          `    kind       = "ConfigMap"\n` +
          `    metadata = {\n` +
          `      name = "app-\${var.suffix}"\n` +
          `    }\n` +
          `  }\n` +
          `}\n`,
      );
      writeFileSync(
        join(dir, "outputs.tf"),
        `output "name" {\n  value = kubernetes_manifest.app_config.object.metadata.name\n}\n`,
      );
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "kubernetes_manifest.app_config", output: out });
      expect(res.ok).toBe(true);
      // `metadata.name` is required on the data source; guessing it would be
      // worse than saying so.
      expect(res.plan!.dataSources[0].hcl).toContain("# TODO: identify the resource");
      expect(res.plan!.dataSources[0].hcl).not.toContain("api_version");
      // The reference is still repointed, so the survivor plan is one edit away.
      expect(readFileSync(join(out, "outputs.tf"), "utf-8")).toContain(
        "value = data.kubernetes_resource.app_config.object.metadata.name",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("carveBridge — formatting", () => {
  test("formatCarveBridge summarizes data sources, rewires, and safety", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: join(dir, "carveout") });
      const text = formatCarveBridge(res);
      expect(text).toContain("data.aws_s3_bucket.assets");
      expect(text).toContain("Nothing in your Terraform changed");
      expect(text).toContain("runbook");
    });
  });
});
