/**
 * What `chant import` generates for manifests with embedded content (#2962,
 * #3031)
 * type-checks: the k8s module that references the owners' declarations, and
 * the owners' modules. Compiling takes longer than the unit-test budget
 * allows, so this runs with the e2e tests.
 */
import { describe, expect, test } from "vitest";
import { join } from "path";
import * as ts from "typescript";
import { importManifest, read, removeDir, repoRoot } from "./testdata/embedded/fixtures";

/** Type errors in the generated files, compiled with the repo's compiler options. */
function typeErrors(srcDir: string, paths: string[]): string[] {
  const files = paths.map((p) => join(srcDir, p));
  const configFile = ts.readConfigFile(join(repoRoot, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const real = (f: string) => ts.sys.realpath?.(f) ?? f;
  const fileSet = new Set(files.map(real));
  // A program that saw none of the files would pass vacuously.
  expect(files.every((f) => program.getSourceFile(f) !== undefined)).toBe(true);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && fileSet.has(real(d.file.fileName)))
    .map((d) => `${real(d.file!.fileName).slice(real(srcDir).length + 1)}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("the source generated for embedded content type-checks", () => {
  test.each([
    "otel-collector-daemonset.yaml",
    "node-exporter-prometheusrule.yaml",
    "grafana-dashboard-configmap.yaml",
    "agent-observability.yaml",
    "alertmanager-configmap.yaml",
  ])("%s", async (fixture) => {
    const imported = await importManifest(read(fixture));
    try {
      expect(imported.result.success).toBe(true);
      expect(typeErrors(imported.srcDir, Object.keys(imported.files))).toEqual([]);
    } finally {
      removeDir(imported.dir);
    }
  }, 180_000);
});
