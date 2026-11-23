import { describe, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bumpForSeverity, bumpPackageJsonVersion, followWorkspaceRanges } from "./version-bump";

describe("bumpForSeverity", () => {
  test("pre-1.0: additive bumps the patch, breaking bumps the minor (never auto-1.0.0)", () => {
    expect(bumpForSeverity("0.13.1", "additive")).toBe("0.13.2");
    expect(bumpForSeverity("0.13.1", "breaking")).toBe("0.14.0");
    expect(bumpForSeverity("0.0.9", "breaking")).toBe("0.1.0");
  });

  test(">= 1.0.0: additive bumps the minor, breaking bumps the major", () => {
    expect(bumpForSeverity("1.2.3", "additive")).toBe("1.3.0");
    expect(bumpForSeverity("1.2.3", "breaking")).toBe("2.0.0");
  });

  test("tolerates a leading v", () => {
    expect(bumpForSeverity("v0.14.0", "additive")).toBe("0.14.1");
  });

  test("returns null for none or an unparseable version", () => {
    expect(bumpForSeverity("0.13.1", "none")).toBeNull();
    expect(bumpForSeverity("1.2", "additive")).toBeNull();
    expect(bumpForSeverity("not-a-version", "breaking")).toBeNull();
  });
});

describe("bumpPackageJsonVersion", () => {
  test("rewrites only the version, preserving other fields + trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "vbump-"));
    try {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ name: "x", version: "0.13.1", scripts: { build: "tsc" } }, null, 2));
      bumpPackageJsonVersion(pkgPath, "0.14.0");
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { name: string; version: string; scripts: Record<string, string> };
      expect(pkg.version).toBe("0.14.0");
      expect(pkg.name).toBe("x");
      expect(pkg.scripts.build).toBe("tsc");
      expect(raw.endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followWorkspaceRanges (#5556)", () => {
  const K8S = "@intentius/chant-lexicon-k8s";

  /** A workspace like chant's: k8s just bumped to 0.125.0, grafana and helm still on ^0.124.34. */
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "vbump-ws-"));
    const write = (rel: string, doc: unknown) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), JSON.stringify(doc, null, 2) + "\n");
    };
    write("package.json", { name: "root", private: true, workspaces: ["packages/*", "lexicons/*", "lexicons/grafana/examples/*"] });
    write("packages/core/package.json", { name: "@intentius/chant", version: "0.124.34" });
    write("lexicons/k8s/package.json", { name: K8S, version: "0.125.0", peerDependencies: { "@intentius/chant": "^0.124.34" } });
    write("lexicons/grafana/package.json", { name: "@intentius/chant-lexicon-grafana", version: "0.124.34", dependencies: { [K8S]: "^0.124.34", "js-yaml": "^4.3.1" } });
    write("lexicons/helm/package.json", { name: "@intentius/chant-lexicon-helm", version: "0.124.34", peerDependencies: { [K8S]: "^0.124.34" } });
    write("lexicons/grafana/examples/demo/package.json", { name: "demo", private: true, dependencies: { [K8S]: "*" } });
    write("package-lock.json", {
      name: "root",
      lockfileVersion: 3,
      packages: {
        "": { name: "root", workspaces: ["packages/*", "lexicons/*"] },
        "lexicons/k8s": { name: K8S, version: "0.124.34" },
        "lexicons/grafana": { name: "@intentius/chant-lexicon-grafana", version: "0.124.34", dependencies: { [K8S]: "^0.124.34" } },
        "lexicons/helm": { name: "@intentius/chant-lexicon-helm", version: "0.124.34", peerDependencies: { [K8S]: "^0.124.34" } },
        "node_modules/@intentius/chant-lexicon-k8s": { resolved: "lexicons/k8s", link: true },
        "lexicons/grafana/node_modules/@intentius/chant-lexicon-k8s": { version: "0.124.34", dependencies: { "@intentius/chant-lexicon-otel": "^0.124.34" } },
      },
    });
    return root;
  }
  const read = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), "utf-8"));

  test("moves every workspace range on the bumped package, and the lockfile beside them", () => {
    const root = workspace();
    try {
      const changed = followWorkspaceRanges(join(root, "lexicons/k8s"), "0.125.0");
      expect(changed.map((p) => p.slice(root.length + 1)).sort()).toEqual([
        "lexicons/grafana/package.json",
        "lexicons/helm/package.json",
        "package-lock.json",
      ]);
      expect(read(root, "lexicons/grafana/package.json").dependencies).toEqual({ [K8S]: "^0.125.0", "js-yaml": "^4.3.1" });
      expect(read(root, "lexicons/helm/package.json").peerDependencies).toEqual({ [K8S]: "^0.125.0" });
      const lock = read(root, "package-lock.json").packages;
      expect(lock["lexicons/k8s"].version).toBe("0.125.0");
      expect(lock["lexicons/grafana"].dependencies[K8S]).toBe("^0.125.0");
      expect(lock["lexicons/helm"].peerDependencies[K8S]).toBe("^0.125.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves `*` ranges, other packages' own versions, and installed copies under node_modules", () => {
    const root = workspace();
    try {
      followWorkspaceRanges(join(root, "lexicons/k8s"), "0.125.0");
      expect(read(root, "lexicons/grafana/examples/demo/package.json").dependencies[K8S]).toBe("*");
      expect(read(root, "lexicons/grafana/package.json").version).toBe("0.124.34");
      expect(read(root, "lexicons/k8s/package.json").peerDependencies["@intentius/chant"]).toBe("^0.124.34");
      const lock = read(root, "package-lock.json").packages;
      expect(lock["lexicons/grafana/node_modules/@intentius/chant-lexicon-k8s"].version).toBe("0.124.34");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second run changes nothing, and a package in no workspace changes nothing", () => {
    const root = workspace();
    const lone = mkdtempSync(join(tmpdir(), "vbump-lone-"));
    try {
      followWorkspaceRanges(join(root, "lexicons/k8s"), "0.125.0");
      expect(followWorkspaceRanges(join(root, "lexicons/k8s"), "0.125.0")).toEqual([]);
      writeFileSync(join(lone, "package.json"), JSON.stringify({ name: K8S, version: "0.125.0" }));
      expect(followWorkspaceRanges(lone, "0.125.0")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(lone, { recursive: true, force: true });
    }
  });
});
