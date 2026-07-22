import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readStateInstanceCounts, applyStateCounts } from "./state";
import { buildGraph } from "./graph";
import { scoreEstate } from "./score";
import type { Hcl2JsonTree } from "./types";

function withState<T>(state: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chant-tfstate-"));
  const path = join(dir, "terraform.tfstate");
  try {
    writeFileSync(path, JSON.stringify(state));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATE = {
  version: 4,
  resources: [
    { mode: "managed", type: "aws_instance", name: "web", instances: [{}, {}, {}] },
    { mode: "managed", type: "aws_sqs_queue", name: "solo", instances: [{}] },
    // data source — ignored
    { mode: "data", type: "aws_ami", name: "ubuntu", instances: [{}] },
    // nested in a module — no top-level node, ignored
    { module: "module.cdn", mode: "managed", type: "aws_s3_bucket", name: "logs", instances: [{}, {}] },
  ],
};

describe("readStateInstanceCounts", () => {
  test("counts root-module managed instances, skips data + module-nested", () => {
    withState(STATE, (path) => {
      const counts = readStateInstanceCounts(path);
      expect(counts.get("aws_instance.web")).toBe(3);
      expect(counts.get("aws_sqs_queue.solo")).toBe(1);
      expect(counts.has("aws_ami.ubuntu")).toBe(false); // data source
      expect(counts.has("aws_s3_bucket.logs")).toBe(false); // module-nested
    });
  });
});

describe("applyStateCounts", () => {
  test("overlays counts; nodes absent from state keep 1", () => {
    const graph = buildGraph({
      resource: {
        aws_instance: { web: [{ count: 3, ami: "x" }] },
        aws_sqs_queue: { orphan: [{ name: "q" }] },
      },
    } as Hcl2JsonTree);
    applyStateCounts(graph, new Map([["aws_instance.web", 3]]));
    const byAddr = Object.fromEntries(graph.nodes.map((n) => [n.address, n]));
    expect(byAddr["aws_instance.web"].instances).toBe(3);
    expect(byAddr["aws_sqs_queue.orphan"].instances).toBe(1);
  });

  test("state-accurate fan-out lowers peelability via the instances penalty", () => {
    const tree: Hcl2JsonTree = {
      resource: { aws_sqs_queue: { fan: [{ count: 5, name: "q" }] } },
    };
    // Without state: instances=1, only the -10 dynamic penalty → 90.
    const noState = scoreEstate(buildGraph(tree))[0];
    expect(noState.score).toBe(90);
    expect(noState.breakdown.instances).toBe(1);

    // With state: 5 instances → -10 dynamic -3*(5-1)=-12 → 78, drops out of "clean leaf".
    const withCounts = buildGraph(tree);
    applyStateCounts(withCounts, new Map([["aws_sqs_queue.fan", 5]]));
    const stated = scoreEstate(withCounts)[0];
    expect(stated.breakdown.instances).toBe(5);
    expect(stated.score).toBe(78);
    expect(stated.band).toBe("carvable w/ edits");
  });
});
