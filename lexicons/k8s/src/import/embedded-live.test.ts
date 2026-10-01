/**
 * Embedded content through `chant import --from <env>` (#2995): a ConfigMap
 * holding a collector config, or a PrometheusRule's groups, read from a
 * (fake) cluster imports as the owning lexicon's typed declarations, exactly
 * as `chant import <manifest>` does (embedded-roundtrip.test.ts).
 *
 * The cluster is `fakeCluster`: a real k8s client with the socket replaced.
 * The objects are the round trip's fixtures with the fields a server adds.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { load, loadAll } from "js-yaml";
import { liveImportFromPlugins } from "@intentius/chant/cli/commands/import";
import type { LexiconPlugin, ResourceSelector } from "@intentius/chant/lexicon";
import { build } from "@intentius/chant/build";
import type { K8sObject } from "@intentius/chant-k8s-client";
import { otelSerializer } from "@intentius/chant-lexicon-otel";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";
import { k8sPlugin } from "../plugin";
import { k8sSerializer } from "../serializer";
import { exportResources } from "../export-resources";
import { fakeCluster, objectKey } from "../api/fake-cluster";
import { pkgDir, read, removeDir } from "./testdata/embedded/fixtures";

type Json = Record<string, unknown>;

/** The fixture's documents as the API server returns them. */
function liveObjects(fixture: string): Record<string, K8sObject> {
  const objects: Record<string, K8sObject> = {};
  for (const doc of loadAll(read(fixture)) as Json[]) {
    if (!doc) continue;
    const metadata = doc.metadata as Json;
    const live = {
      ...doc,
      metadata: { ...metadata, uid: `uid-${metadata.name}`, resourceVersion: "7", managedFields: [{ manager: "helm" }] },
    } as K8sObject;
    const key = objectKey(doc.apiVersion as string, doc.kind as string, metadata.name as string, metadata.namespace as string | undefined);
    objects[key] = live;
  }
  return objects;
}

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out[relative(root, path)] = readFileSync(path, "utf-8");
  }
}

/** `chant import --from test` against a cluster holding the fixture's objects, in a project inside this package. */
async function importLive(fixture: string, selector?: ResourceSelector) {
  const cluster = fakeCluster({ objects: liveObjects(fixture) });
  const plugin: LexiconPlugin = {
    ...k8sPlugin,
    exportResources: (options) => exportResources(options, cluster.connector),
  };
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-live-"));
  writeFileSync(join(dir, "package.json"), '{ "name": "k8s-live-embedded", "private": true, "type": "module" }\n');
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["k8s"] };\n');
  const srcDir = join(dir, "src");
  mkdirSync(srcDir);
  const result = await liveImportFromPlugins([plugin], { environment: "test", output: srcDir, selector, force: true });
  const files: Record<string, string> = {};
  walk(srcDir, srcDir, files);
  return { result, dir, srcDir, files };
}

function primary(out: unknown): string {
  return typeof out === "string" ? out : ((out as { primary?: string } | undefined)?.primary ?? "");
}

function find(docs: Json[], kind: string, name: string): Json {
  const doc = docs.find((d) => d.kind === kind && (d.metadata as Json | undefined)?.name === name);
  if (!doc) throw new Error(`no ${kind} ${name}`);
  return doc;
}

/** A collector config as the collector reads it: an empty component is `{}` whether written `{}` or left null. */
function collectorConfig(text: string): Json {
  const doc = (load(text) ?? {}) as Json;
  for (const section of ["receivers", "processors", "exporters", "connectors", "extensions"]) {
    const s = doc[section] as Json | undefined;
    if (!s) continue;
    for (const id of Object.keys(s)) if (s[id] === null) s[id] = {};
  }
  return doc;
}

describe("chant import --from: embedded content imported by its owner (#2995)", () => {
  test("a live collector ConfigMap becomes typed otel declarations and builds back to the same config", async () => {
    const out = await importLive("otel-collector-daemonset.yaml");
    try {
      expect(out.result.error).toBeUndefined();
      expect(out.result.success).toBe(true);
      expect(out.result.warnings.filter((w) => w.includes("kept as written"))).toEqual([]);

      const name = "example-opentelemetry-collector-agent";
      const host = Object.entries(out.files).find(([p]) => !p.includes("/") && p !== "index.ts" && out.files[p].includes("collectorYaml("));
      expect(host, Object.keys(out.files).join(", ")).toBeDefined();
      expect(host![1]).toContain('import { collectorYaml } from "@intentius/chant-lexicon-otel";');
      expect(out.files[`${name}/receivers.ts`]).toContain("new OtlpReceiver(");
      expect(out.result.generatedFiles).toContain(`${name}/pipelines.ts`);

      const result = await build(out.srcDir, [k8sSerializer, otelSerializer, prometheusSerializer]);
      expect(result.errors).toEqual([]);
      const rebuilt = (loadAll(primary(result.outputs.get("k8s"))) as Json[]).filter((d) => d);
      const source = (loadAll(read("otel-collector-daemonset.yaml")) as Json[]).filter((d) => d);
      const before = find(source, "ConfigMap", name).data as Json;
      const after = find(rebuilt, "ConfigMap", name).data as Json;
      expect(collectorConfig(after.relay as string)).toEqual(collectorConfig(before.relay as string));
    } finally {
      removeDir(out.dir);
    }
  });

  test("a live PrometheusRule's spec.groups become prometheus RuleGroups", async () => {
    const out = await importLive("node-exporter-prometheusrule.yaml", { type: "K8s::Monitoring::PrometheusRule" });
    try {
      expect(out.result.error).toBeUndefined();
      expect(out.result.generatedFiles).toEqual(["main.ts", "node-exporter-rules/rules.ts"]);
      expect(out.files["main.ts"]).toContain('from "./node-exporter-rules/rules";');
      expect(out.files["node-exporter-rules/rules.ts"]).toContain("new RuleGroup(");
    } finally {
      removeDir(out.dir);
    }
  });

  test("the export keeps embedded content as read when no context is given", async () => {
    const cluster = fakeCluster({ objects: liveObjects("otel-collector-daemonset.yaml") });
    const ir = await exportResources({ environment: "test", selector: { type: "K8s::Core::ConfigMap" } }, cluster.connector);
    const [configMap] = ir.resources;
    expect(typeof (configMap.properties.data as Json).relay).toBe("string");
    expect(typeof ir.reparse).toBe("function");
  });
});
