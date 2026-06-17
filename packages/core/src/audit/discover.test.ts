import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { discoverByDetection, loadAuditPlugins } from "./discover";
import type { AuditInput } from "./core";

const fixture = (name: string) => fileURLToPath(new URL(`../cli/commands/__fixtures__/${name}`, import.meta.url));

/** Compare on (lexicon, path) pairs — content normalization differs in spelling, not target. */
const targets = (inputs: AuditInput[]) => inputs.map((i) => `${i.lexicon}:${i.path}`).sort();

describe("discoverByDetection (unified, detectTemplate-driven)", () => {
  test("detects Kubernetes manifests", async () => {
    const plugins = await loadAuditPlugins();
    expect(targets(discoverByDetection(fixture("audit-k8s"), plugins))).toEqual(["k8s:manifests/deploy.yaml"]);
  });

  test("detects Docker artifacts (nested Dockerfile by name + compose by content)", async () => {
    const plugins = await loadAuditPlugins();
    expect(targets(discoverByDetection(fixture("audit-docker"), plugins))).toEqual([
      "docker:app/Dockerfile",
      "docker:docker-compose.yml",
    ]);
  });

  test("detects CloudFormation (JSON + YAML), normalizing to JSON", async () => {
    const plugins = await loadAuditPlugins();
    const found = discoverByDetection(fixture("audit-aws"), plugins);
    expect(targets(found)).toEqual(["aws:stack.yaml", "aws:template.json"]);
    // YAML template is normalized to a JSON string the aws checks can JSON.parse.
    expect(() => JSON.parse(found.find((f) => f.path === "stack.yaml")!.content)).not.toThrow();
  });

  test("detects Azure ARM templates", async () => {
    const plugins = await loadAuditPlugins();
    expect(targets(discoverByDetection(fixture("audit-azure"), plugins))).toEqual(["azure:azuredeploy.json"]);
  });

  test("gcp wins over k8s for Config Connector resources (no double-audit)", async () => {
    const plugins = await loadAuditPlugins();
    const found = discoverByDetection(fixture("audit-gcp"), plugins);
    expect(targets(found)).toEqual(["gcp:bucket.yaml", "gcp:firewall.yaml"]);
    expect(found.some((i) => i.lexicon === "k8s")).toBe(false);
  });

  test("detects a Helm chart as a bundle, not loose manifests", async () => {
    const plugins = await loadAuditPlugins();
    const found = discoverByDetection(fixture("audit-helm"), plugins);
    const helm = found.filter((i) => i.lexicon === "helm");
    expect(helm).toHaveLength(1);
    expect(helm[0].path).toBe("mychart");
    expect(helm[0].files!["Chart.yaml"]).toContain("name: mychart");
    expect(helm[0].files!["templates/deployment.yaml"]).toContain("privileged");
    // chart-internal templates are NOT also picked up as loose k8s manifests.
    expect(found.some((i) => i.lexicon === "k8s")).toBe(false);
  });

  test("detects CI workflows by path (github)", async () => {
    const plugins = await loadAuditPlugins();
    const found = discoverByDetection(fixture("audit-repo"), plugins);
    expect(targets(found)).toEqual(["github:.github/workflows/ci.yml"]);
  });

  test("scopes detection to the provided plugins (k8s omitted → no k8s findings)", async () => {
    const plugins = await loadAuditPlugins(["github", "gitlab", "forgejo", "docker", "aws", "azure", "gcp", "helm"]);
    expect(discoverByDetection(fixture("audit-k8s"), plugins).some((i) => i.lexicon === "k8s")).toBe(false);
  });
});
