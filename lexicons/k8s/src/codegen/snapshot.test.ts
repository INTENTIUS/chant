import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-k8s.json"));

describe("snapshot", () => {
  test.skipIf(!hasGenerated)("lexicon-k8s.json is valid JSON", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  test.skipIf(!hasGenerated)("lexicon entries have required fields", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.resourceType).toBeDefined();
      expect(entry.kind).toBeDefined();
      expect(["resource", "property"]).toContain(entry.kind);
    }
  });

  test.skipIf(!hasGenerated)("contains Deployment entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const deployment = Object.values(registry).find(
      (e: any) => e.resourceType === "K8s::Apps::Deployment",
    );
    expect(deployment).toBeDefined();
    expect(deployment!.kind).toBe("resource");
    expect(deployment!.apiVersion).toBe("apps/v1");
    expect(deployment!.gvkKind).toBe("Deployment");
  });

  test.skipIf(!hasGenerated)("contains Pod entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const pod = Object.values(registry).find(
      (e: any) => e.resourceType === "K8s::Core::Pod",
    );
    expect(pod).toBeDefined();
    expect(pod!.kind).toBe("resource");
  });

  test.skipIf(!hasGenerated)("contains Service entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const svc = Object.values(registry).find(
      (e: any) => e.resourceType === "K8s::Core::Service",
    );
    expect(svc).toBeDefined();
    expect(svc!.kind).toBe("resource");
    expect(svc!.apiVersion).toBe("v1");
  });

  test.skipIf(!hasGenerated)("contains ConfigMap entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const cm = Object.values(registry).find(
      (e: any) => e.resourceType === "K8s::Core::ConfigMap",
    );
    expect(cm).toBeDefined();
  });

  test.skipIf(!hasGenerated)("contains Container property type", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const container = Object.values(registry).find(
      (e: any) => e.resourceType === "K8s::Core::Container",
    );
    expect(container).toBeDefined();
    expect(container!.kind).toBe("property");
  });

  test.skipIf(!hasGenerated)("index.d.ts contains class declarations", () => {
    const dtsPath = join(generatedDir, "index.d.ts");
    if (!existsSync(dtsPath)) return;

    const dts = readFileSync(dtsPath, "utf-8");
    expect(dts).toContain("class Deployment");
    expect(dts).toContain("class Service");
    expect(dts).toContain("class Pod");
  });

  // chant #1372 — CRD field schemas ship in the registry; built-ins do not carry one.
  test.skipIf(!hasGenerated)("every CRD-derived resource entry carries a specSchema, built-ins none", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-k8s.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const crd = registry.Certificate;
    expect(crd.resourceType).toBe("K8s::CertManager::Certificate");
    expect(crd.specSchema.type).toBe("object");
    expect(crd.specSchema.fields.issuerRef.fields.name.type).toBe("string");
    expect(crd.specSchema.required).toContain("secretName");

    expect(registry.Deployment.specSchema).toBeUndefined();
    expect(registry.Certificate_Status.specSchema).toBeUndefined();

    // Each schema is written on one line so the file stays reviewable; the
    // pretty-printed form is four times the size for no reader's benefit.
    const line = raw.split("\n").find((l) => l.includes('"specSchema": {'));
    expect(line).toMatch(/^\s+"specSchema": \{.*\}$/);
  });
});
