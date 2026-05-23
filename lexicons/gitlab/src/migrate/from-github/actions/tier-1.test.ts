import { describe, test, expect, beforeAll } from "vitest";
import { createRegistry, lookupAction } from "./registry";
import { registerTier1 } from "./tier-1";
import type { ActionMapCtx } from "./registry";

const ctx: ActionMapCtx = { logicalId: "build", jobName: "build", stepIndex: 0 };

const reg = createRegistry();
beforeAll(() => registerTier1(reg));

function callAction(uses: string, withProps: Record<string, unknown> = {}) {
  const m = lookupAction(uses, reg);
  if (!m) throw new Error(`No mapping for ${uses}`);
  return m.translate({ uses, with: withProps }, ctx);
}

describe("Tier 1 mappings", () => {
  test("actions/checkout removes step + may set GIT_DEPTH", () => {
    const r = callAction("actions/checkout@v4");
    expect(r.scriptLines).toEqual([]);
    expect(r.provenance[0].category).toBe("skipped");
  });

  test("actions/checkout with fetch-depth sets GIT_DEPTH", () => {
    const r = callAction("actions/checkout@v4", { "fetch-depth": 0 });
    expect(r.variables?.GIT_DEPTH).toBe(0);
  });

  test("actions/setup-node sets image: node:<v>", () => {
    const r = callAction("actions/setup-node@v4", { "node-version": "20" });
    expect(r.image).toBe("node:20");
  });

  test("actions/setup-node with cache: npm sets cache paths", () => {
    const r = callAction("actions/setup-node@v4", { "node-version": "20", cache: "npm" });
    expect(r.cache?.paths).toEqual([".npm/"]);
  });

  test("actions/setup-python sets image: python:<v>", () => {
    const r = callAction("actions/setup-python@v5", { "python-version": "3.11" });
    expect(r.image).toBe("python:3.11");
  });

  test("actions/setup-java sets eclipse-temurin", () => {
    const r = callAction("actions/setup-java@v3", { "java-version": "17" });
    expect(r.image).toBe("eclipse-temurin:17");
  });

  test("actions/setup-go sets image: golang:<v>", () => {
    const r = callAction("actions/setup-go@v5", { "go-version": "1.21" });
    expect(r.image).toBe("golang:1.21");
  });

  test("actions/setup-ruby sets image: ruby:<v>", () => {
    const r = callAction("actions/setup-ruby@v1", { "ruby-version": "3.3" });
    expect(r.image).toBe("ruby:3.3");
  });

  test("actions/cache → cache: keyword", () => {
    const r = callAction("actions/cache@v3", { path: "node_modules\n.npm", key: "v1-${{ runner.os }}" });
    expect(r.cache?.paths).toEqual(["node_modules", ".npm"]);
    expect(r.cache?.key).toContain("v1-");
  });

  test("actions/upload-artifact → artifacts: keyword", () => {
    const r = callAction("actions/upload-artifact@v4", { name: "out", path: "dist", "retention-days": 7 });
    expect(r.artifacts?.paths).toEqual(["dist"]);
    expect(r.artifacts?.name).toBe("out");
    expect(r.artifacts?.expire_in).toBe("7 days");
  });

  test("actions/download-artifact → no-op (GitLab auto-passes)", () => {
    const r = callAction("actions/download-artifact@v4");
    expect(r.scriptLines).toEqual([]);
  });

  test("docker/login-action emits docker login", () => {
    const r = callAction("docker/login-action@v3", {
      registry: "ghcr.io",
      username: "${{ github.actor }}",
      password: "${{ secrets.GH_TOKEN }}",
    });
    expect(r.scriptLines.join("\n")).toContain("docker login");
    expect(r.scriptLines.join("\n")).toContain("ghcr.io");
  });

  test("docker/build-push-action emits docker build/push + dind", () => {
    const r = callAction("docker/build-push-action@v5", {
      tags: "ghcr.io/me/img:latest",
      push: true,
    });
    expect(r.image).toBe("docker:latest");
    expect(r.services?.[0]).toMatchObject({ name: "docker:dind" });
    expect(r.scriptLines.some((l) => l.startsWith("docker build"))).toBe(true);
    expect(r.scriptLines.some((l) => l.startsWith("docker push"))).toBe(true);
  });

  test("docker/setup-buildx-action emits buildx create", () => {
    const r = callAction("docker/setup-buildx-action@v3");
    expect(r.scriptLines.some((l) => l.includes("buildx create"))).toBe(true);
    expect(r.image).toBe("docker:latest");
  });

  test("docker/setup-qemu-action emits binfmt", () => {
    const r = callAction("docker/setup-qemu-action@v3", { platforms: "linux/arm64" });
    expect(r.scriptLines.some((l) => l.includes("tonistiigi/binfmt"))).toBe(true);
  });

  test("actions/github-script → needs-review with TODO comment", () => {
    const r = callAction("actions/github-script@v7");
    expect(r.scriptLines.some((l) => l.startsWith("# TODO"))).toBe(true);
    expect(r.provenance[0].category).toBe("needs-review");
  });

  test("registry contains all 14 Tier 1 actions", () => {
    const names = [
      "actions/checkout", "actions/setup-node", "actions/setup-python",
      "actions/setup-java", "actions/setup-go", "actions/setup-ruby",
      "actions/cache", "actions/upload-artifact", "actions/download-artifact",
      "docker/login-action", "docker/build-push-action",
      "docker/setup-buildx-action", "docker/setup-qemu-action",
      "actions/github-script",
    ];
    for (const n of names) {
      expect(lookupAction(`${n}@v1`, reg)).toBeDefined();
    }
  });
});
