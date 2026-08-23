import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { classifyFiles, discoverByDetection, hintLexiconForFile, loadAuditPlugins, unclaimedFiles } from "./discover";
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

  test("loadAuditPlugins skips an uninstalled lexicon instead of throwing", async () => {
    const plugins = await loadAuditPlugins(["github", "definitely-not-a-real-lexicon"]);
    expect(plugins.map((p) => p.name)).toEqual(["github"]);
  });
});

describe("lexicon hints for unclaimed files (#1623)", () => {
  test("hintLexiconForFile guesses by path, name, and cheap content markers", () => {
    expect(hintLexiconForFile(".github/workflows/ci.yml", "on: push\n")).toBe("github");
    expect(hintLexiconForFile(".forgejo/workflows/ci.yml", "on: push\n")).toBe("forgejo");
    expect(hintLexiconForFile(".gitlab-ci.yml", "build:\n  script: [echo]\n")).toBe("gitlab");
    expect(hintLexiconForFile("app/Dockerfile", "FROM x\n")).toBe("docker");
    expect(hintLexiconForFile("charts/x/Chart.yaml", "name: x\n")).toBe("helm");
    expect(hintLexiconForFile("infra/main.tf", "resource {}\n")).toBe("terraform");
    expect(hintLexiconForFile("k8s/deploy.yaml", "apiVersion: apps/v1\nkind: Deployment\n")).toBe("k8s");
    expect(hintLexiconForFile("gcp/bucket.yaml", "apiVersion: storage.cnrm.cloud.google.com/v1beta1\nkind: StorageBucket\n")).toBe("gcp");
    expect(hintLexiconForFile("cfn/stack.yaml", "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n")).toBe("aws");
    expect(hintLexiconForFile("cfn/stack.json", '{"Resources":{"B":{"Type":"AWS::S3::Bucket"}}}')).toBe("aws");
    expect(hintLexiconForFile("arm/azuredeploy.json", '{"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"}')).toBe("azure");
    expect(hintLexiconForFile("docker-compose.yml", "services:\n  web:\n    image: x\n")).toBe("docker");
    expect(hintLexiconForFile("package.json", '{"name":"x"}')).toBeUndefined();
    expect(hintLexiconForFile("config.yaml", "foo: bar\n")).toBeUndefined();
  });

  test("unclaimedFiles reports only files whose guessed lexicon is absent", () => {
    const files = [
      { path: ".github/workflows/ci.yml", content: "on: push\n" },
      { path: "k8s/deploy.yaml", content: "apiVersion: v1\nkind: Pod\n" },
      { path: "odd.yaml", content: "apiVersion: v1\nkind: Pod\n" },
      { path: "main.tf", content: "" },
      { path: "README.json", content: "{}" },
    ];
    const github = { name: "github" };
    const k8s = { name: "k8s", detectTemplate: () => true };
    // github loaded and claimed its file; k8s absent, so both manifests are unclaimed; tf always surfaces.
    const inputs = classifyFiles(files, [github]);
    expect(unclaimedFiles(files, inputs, [github])).toEqual([
      { path: "k8s/deploy.yaml", lexicon: "k8s" },
      { path: "odd.yaml", lexicon: "k8s" },
      { path: "main.tf", lexicon: "terraform" },
    ]);
    // With k8s loaded, its files are claimed and drop out; only terraform remains.
    const inputs2 = classifyFiles(files, [github, k8s]);
    expect(unclaimedFiles(files, inputs2, [github, k8s])).toEqual([{ path: "main.tf", lexicon: "terraform" }]);
    // Zero plugins: everything that looks like something is unclaimed.
    expect(unclaimedFiles(files, [], []).map((u) => u.lexicon)).toEqual(["github", "k8s", "k8s", "terraform"]);
  });

  test("helm bundles claim their whole chart directory", () => {
    const files = [
      { path: "chart/Chart.yaml", content: "name: c\nversion: 1.0.0\n" },
      { path: "chart/templates/deploy.yaml", content: "apiVersion: v1\nkind: Pod\n" },
    ];
    const helm = { name: "helm", detectTemplate: () => true };
    const inputs = classifyFiles(files, [helm]);
    expect(inputs).toHaveLength(1);
    expect(unclaimedFiles(files, inputs, [helm])).toEqual([]);
  });
});
