/**
 * A CRD source that fails to load fails generation, naming the source (#3310).
 */

import { describe, expect, it } from "vitest";
import { loadCrdSources } from "./generate";
import type { CRDSource } from "../crd/types";
import type { K8sParseResult } from "../spec/parse";

const good: CRDSource = { type: "url", url: "https://example.test/good.yaml" };
const down: CRDSource = { type: "helm", chart: "oci://registry.example.test/charts/operator", version: "1.0.0" };
const moved: CRDSource = { type: "url", url: "https://example.test/moved.yaml" };

const fakeResult = { resource: { typeName: "K8s::Example::Thing" } } as unknown as K8sParseResult;

async function fakeLoad(sources: CRDSource[]): Promise<K8sParseResult[]> {
  const [source] = sources;
  if (source === down) throw new Error("registry unreachable");
  if (source === moved) throw new Error("404 Not Found");
  return [fakeResult];
}

describe("loadCrdSources (#3310)", () => {
  it("returns every source's types when all load", async () => {
    const out = await loadCrdSources([good], () => {}, { load: fakeLoad });
    expect(out.results).toEqual([fakeResult]);
    expect(out.warnings).toEqual([]);
  });

  it("fails naming each source that failed to load, after trying them all", async () => {
    const attempted: CRDSource[] = [];
    const load = async (sources: CRDSource[]) => {
      attempted.push(...sources);
      return fakeLoad(sources);
    };
    const run = loadCrdSources([down, good, moved], () => {}, { load });
    await expect(run).rejects.toThrow(/2 CRD source\(s\) failed to load/);
    await expect(run).rejects.toThrow(/oci:\/\/registry\.example\.test\/charts\/operator: registry unreachable/);
    await expect(run).rejects.toThrow(/https:\/\/example\.test\/moved\.yaml: 404 Not Found/);
    await expect(run).rejects.toThrow(/CHANT_K8S_ALLOW_CRD_FAILURES=1/);
    expect(attempted).toEqual([down, good, moved]);
  });

  it("generates without a failed source, as a warning, only when allowed", async () => {
    const out = await loadCrdSources([down, good], () => {}, { load: fakeLoad, allowFailures: true });
    expect(out.results).toEqual([fakeResult]);
    expect(out.warnings).toEqual([{ file: "oci://registry.example.test/charts/operator", error: "registry unreachable" }]);
  });
});
