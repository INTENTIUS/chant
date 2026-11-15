import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCommand } from "./audit";
import { loadAuditPlugins } from "../../audit/discover";
import { PULL_REQUEST_PRESET, readBaselineIdentities } from "../../audit/pull-request-preset";

/**
 * #5118: `chant audit --preset pull-request --baseline <base report>` reports
 * only the preset's rules, only the findings the head added, and fails on a
 * merge-blocking one.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let plugins: Awaited<ReturnType<typeof loadAuditPlugins>>;
beforeAll(async () => {
  plugins = await loadAuditPlugins(["k8s"]);
}, 120_000);

/**
 * An Argo CD ApplicationSet with a field the API server prunes (WK8501,
 * merge-blocking) and no labels (WK8102, report-only), as on the replay.
 */
const deployment = (name: string) => `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ${name}
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: in-cluster
  template:
    metadata:
      name: ${name}
    spec:
      project: default
      managedNamespaceMetadata:
        labels:
          istio-injection: enabled
      source:
        repoURL: https://example.com/repo.git
        path: apps/${name}
        targetRevision: main
      destination:
        name: in-cluster
        namespace: ${name}
`;

function tree(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-5118-"));
  dirs.push(dir);
  for (const n of names) writeFileSync(join(dir, `${n}.yaml`), deployment(n));
  return dir;
}

const run = (path: string, extra: Partial<Parameters<typeof auditCommand>[0]> = {}) =>
  auditCommand({ path, format: "json", now: "2026-11-15T00:00:00.000Z", toolVersion: "0.0.0", plugins, preset: PULL_REQUEST_PRESET, ...extra });

describe("chant audit --preset pull-request (#5118)", () => {
  test("reports only the preset's rules, each with its gate", async () => {
    const r = await run(tree("web"));
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) expect(["merge-blocking", "report-only"]).toContain(f.gate);
    expect(r.findings.some((f) => f.checkId === "WK8501" && f.gate === "merge-blocking")).toBe(true);
    const all = await auditCommand({ path: tree("web"), format: "json", plugins });
    expect(all.findings.every((f) => f.gate === undefined)).toBe(true);
  });

  test("with a baseline, reports what the head added and fails on a merge-blocking finding", async () => {
    const base = await run(tree("web"));
    const baseline = readBaselineIdentities(base.output);
    const head = await run(tree("web", "worker"), { baseline });
    expect(head.findings.length).toBeGreaterThan(0);
    expect(head.findings.every((f) => f.file === "worker.yaml")).toBe(true);
    expect(head.findings.some((f) => f.gate === "merge-blocking")).toBe(true);
    expect(head.exitCode).toBe(1);
    const json = JSON.parse(head.output) as { findings: Array<{ identity: string; gate: string }> };
    for (const f of json.findings) expect(baseline.has(f.identity)).toBe(false);
  });

  test("an unchanged tree reports nothing and passes", async () => {
    const base = await run(tree("web"));
    const head = await run(tree("web"), { baseline: readBaselineIdentities(base.output) });
    expect(head.findings).toEqual([]);
    expect(head.exitCode).toBe(0);
  });

  test("--fail-on none keeps a preset run read-only", async () => {
    const r = await run(tree("web"), { failOn: "none" });
    expect(r.findings.some((f) => f.gate === "merge-blocking")).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("the text report splits merge-blocking from report-only and ends with the preset's line", async () => {
    const r = await run(tree("web"), { format: "stylish" });
    expect(r.output).toContain("Merge-blocking:");
    expect(r.output).toMatch(/Preset pull-request: \d+ merge-blocking finding/);
  });
});
