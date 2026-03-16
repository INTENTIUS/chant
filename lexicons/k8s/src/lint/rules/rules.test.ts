import { describe, test, expect } from "bun:test";
import { hardcodedNamespaceRule } from "./hardcoded-namespace";
import { latestImageTagRule } from "./latest-image-tag";
import { missingResourceLimitsRule } from "./missing-resource-limits";
import * as ts from "typescript";

function createContext(code: string) {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return { sourceFile } as any;
}

describe("WK8001: Hardcoded Namespace", () => {
  test("rule metadata", () => {
    expect(hardcodedNamespaceRule.id).toBe("WK8001");
    expect(hardcodedNamespaceRule.severity).toBe("warning");
    expect(hardcodedNamespaceRule.category).toBe("correctness");
  });

  test("flags namespace: 'production' string literal", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "production" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WK8001");
    expect(diags[0].message).toContain("production");
  });

  test("flags namespace: 'default' string literal", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "default" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("default");
  });

  test("does NOT flag namespace: myVar (variable reference)", () => {
    const ctx = createContext(
      `const ns = "production"; new Deployment({ metadata: { namespace: ns } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    // Only the string literal assignment to `namespace` key counts
    // Variable references should not be flagged
    const nsFlags = diags.filter((d) => d.ruleId === "WK8001");
    expect(nsFlags.length).toBe(0);
  });

  test("does NOT flag empty namespace string", () => {
    const ctx = createContext(
      `new Deployment({ metadata: { namespace: "" } });`,
    );
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags multiple hardcoded namespaces", () => {
    const ctx = createContext(`
      const a = new Deployment({ metadata: { namespace: "staging" } });
      const b = new Service({ metadata: { namespace: "prod" } });
    `);
    const diags = hardcodedNamespaceRule.check(ctx);
    expect(diags.length).toBe(2);
  });
});

// ── WK8002: Latest Image Tag ────────────────────────────────────────

describe("WK8002: Latest Image Tag", () => {
  test("rule metadata", () => {
    expect(latestImageTagRule.id).toBe("WK8002");
    expect(latestImageTagRule.severity).toBe("warning");
    expect(latestImageTagRule.category).toBe("security");
  });

  test("flags image: 'nginx:latest'", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "nginx:latest" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WK8002");
    expect(diags[0].message).toContain(":latest");
  });

  test("flags untagged image: 'nginx'", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "nginx" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WK8002");
    expect(diags[0].message).toContain("no tag");
  });

  test("flags registry-prefixed untagged image: 'ghcr.io/org/app'", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "ghcr.io/org/app" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
  });

  test("does NOT flag explicitly tagged image: 'nginx:1.25'", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "nginx:1.25" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does NOT flag image with digest", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "nginx@sha256:abc123" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags :latest in StatefulSet", () => {
    const ctx = createContext(
      `new StatefulSet({ spec: { template: { spec: { containers: [{ name: "db", image: "postgres:latest" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
  });

  test("flags :latest in DaemonSet", () => {
    const ctx = createContext(
      `new DaemonSet({ spec: { template: { spec: { containers: [{ name: "agent", image: "datadog:latest" }] } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
  });

  test("flags :latest in CronJob", () => {
    const ctx = createContext(
      `new CronJob({ spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "job", image: "worker:latest" }] } } } } } });`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(1);
  });

  test("does NOT flag image property outside workload constructor", () => {
    const ctx = createContext(
      `const config = { image: "nginx:latest" };`,
    );
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags multiple containers with bad images", () => {
    const ctx = createContext(`
      new Deployment({
        spec: {
          template: {
            spec: {
              containers: [
                { name: "app", image: "nginx:latest" },
                { name: "sidecar", image: "envoy" },
              ],
            },
          },
        },
      });
    `);
    const diags = latestImageTagRule.check(ctx);
    expect(diags.length).toBe(2);
  });
});

// ── WK8003: Missing Resource Limits ─────────────────────────────────

describe("WK8003: Missing Resource Limits", () => {
  test("rule metadata", () => {
    expect(missingResourceLimitsRule.id).toBe("WK8003");
    expect(missingResourceLimitsRule.severity).toBe("warning");
    expect(missingResourceLimitsRule.category).toBe("correctness");
  });

  test("flags container without resources property", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "app:1.0" }] } } } });`,
    );
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WK8003");
    expect(diags[0].message).toContain("app");
    expect(diags[0].message).toContain("resource limits");
  });

  test("does NOT flag container with resources property", () => {
    const ctx = createContext(
      `new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "app:1.0", resources: { limits: { cpu: "500m", memory: "256Mi" } } }] } } } });`,
    );
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags container in StatefulSet", () => {
    const ctx = createContext(
      `new StatefulSet({ spec: { template: { spec: { containers: [{ name: "db", image: "postgres:15" }] } } } });`,
    );
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("db");
  });

  test("flags only containers without resources in mixed array", () => {
    const ctx = createContext(`
      new Deployment({
        spec: {
          template: {
            spec: {
              containers: [
                { name: "app", image: "app:1.0", resources: { limits: { cpu: "1" } } },
                { name: "sidecar", image: "envoy:1.0" },
              ],
            },
          },
        },
      });
    `);
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("sidecar");
  });

  test("does NOT flag outside workload constructor", () => {
    const ctx = createContext(
      `const containers = [{ name: "app", image: "app:1.0" }];`,
    );
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags multiple containers without resources", () => {
    const ctx = createContext(`
      new Deployment({
        spec: {
          template: {
            spec: {
              containers: [
                { name: "web", image: "nginx:1.25" },
                { name: "api", image: "api:2.0" },
              ],
            },
          },
        },
      });
    `);
    const diags = missingResourceLimitsRule.check(ctx);
    expect(diags.length).toBe(2);
  });
});
