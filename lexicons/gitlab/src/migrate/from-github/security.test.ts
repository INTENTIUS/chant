import { describe, test, expect } from "vitest";
import { analyzeSecurity, runSecurityChecks, renderSecurityPosture } from "./security";
import { transform } from "./index";

const WORKFLOW = `name: CI
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11
      - run: echo "title is \${{ github.event.pull_request.title }}"
      - run: deploy --token \${{ secrets.DEPLOY_TOKEN }}
`;

describe("analyzeSecurity (#306)", () => {
  test("classifies each security property's fate", () => {
    const records = analyzeSecurity(WORKFLOW, { sourceFile: "ci.yml" });
    const byRule = new Map(records.map((r) => [r.rule, r]));

    expect(byRule.get("MIG-PIN-LOST")?.security?.fate).toBe("lost");
    expect(byRule.get("MIG-SECRET-UNSCOPED")?.security?.fate).toBe("needs-review");
    expect(byRule.get("MIG-INJECTION-CARRIED")?.security?.fate).toBe("translated");
    expect(byRule.get("MIG-TRUST-BOUNDARY")?.security?.fate).toBe("needs-review");
    expect(byRule.get("MIG-PERMISSIONS-001")?.security?.fate).toBe("needs-review");

    // each cross-references the endpoint that re-establishes the property
    expect(byRule.get("MIG-PIN-LOST")?.security?.reestablish).toBe("#297");
    expect(byRule.get("MIG-SECRET-UNSCOPED")?.security?.reestablish).toBe("#300");
  });

  test("does not flag a clean workflow", () => {
    const clean = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    expect(analyzeSecurity(clean)).toHaveLength(0);
  });
});

describe("runSecurityChecks (#306)", () => {
  test("runs the GitLab post-synth checks against migrated YAML", async () => {
    // A migrated pipeline whose image is unpinned should trip WGL031.
    const yaml = `stages:
  - build

build:
  stage: build
  image:
    name: node:20
  script:
    - npm ci
`;
    const records = await runSecurityChecks(yaml);
    expect(records.some((r) => r.rule === "WGL031")).toBe(true);
    expect(records.every((r) => r.security !== undefined)).toBe(true);
  });
});

describe("renderSecurityPosture (#306)", () => {
  test("renders a posture table", () => {
    const records = analyzeSecurity(WORKFLOW, { sourceFile: "ci.yml" });
    const md = renderSecurityPosture(records);
    expect(md).toContain("## Security posture");
    expect(md).toContain("MIG-PIN-LOST");
    expect(md).toContain("lost");
  });

  test("reports nothing for a clean workflow", () => {
    expect(renderSecurityPosture([])).toContain("No security-relevant properties");
  });
});

describe("transform with security: true (#306)", () => {
  test("security findings flow into provenance + diagnostics + posture", async () => {
    const result = await transform(WORKFLOW, { sourceFile: "ci.yml", security: true });
    const ruleIds = new Set(result.diagnostics.map((d) => d.ruleId));
    expect(ruleIds.has("MIG-PIN-LOST")).toBe(true);
    expect(ruleIds.has("MIG-TRUST-BOUNDARY")).toBe(true);
    expect(result.securityPosture).toContain("## Security posture");
    expect(result.provenance.some((p) => p.security)).toBe(true);
  });

  test("security analysis is off by default", async () => {
    const result = await transform(WORKFLOW, { sourceFile: "ci.yml" });
    const ruleIds = new Set(result.diagnostics.map((d) => d.ruleId));
    expect(ruleIds.has("MIG-PIN-LOST")).toBe(false);
    expect(result.provenance.some((p) => p.security)).toBe(false);
  });
});
