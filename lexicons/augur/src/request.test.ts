/**
 * The golden request (#2357).
 *
 * `chant build` reaches no network and is byte-identical on re-run
 * (`packages/core/src/components/verbs/reproducibility.ts`). The engine's
 * request is built the same way, offline, from the same typed source, and this
 * file holds it to the same standard against a real example project rather
 * than a hand-written entity map: `lexicons/augur/examples/getting-started` is
 * an ordinary aws estate — a VPC with four subnets and its routing, an RDS
 * instance, a queue, a bucket and its policy — plus two augur profiles.
 *
 * Two assertions, and the second is the one that would catch a real
 * regression:
 *
 *  1. The request matches the committed golden file byte for byte. A change to
 *     the coverage table, to a size lookup or to the wire shape shows up as a
 *     diff a reader can read.
 *  2. Building the project twice produces the same bytes. A golden file alone
 *     does not prove reproducibility — it proves one run agreed with a file
 *     somebody committed, which a run seeded from a sorted-once map also does.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngineRequest, renderEngineRequest, sizeOf } from "./request";
import { byCodeUnit, ENGINE_KINDS_BY_ENTITY_TYPE } from "./mapping";
import {
  DECLARED_EDGE_COVERAGE,
  exampleRequestOptions,
} from "./__fixtures__/example-request";

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "golden-request.json");

describe("the golden request (#2357)", () => {
  it("matches the committed golden, byte for byte", async () => {
    const rendered = renderEngineRequest(buildEngineRequest(await exampleRequestOptions()));
    expect(rendered).toBe(readFileSync(goldenPath, "utf-8"));
  });

  it("is byte-identical on a second build of the same source", async () => {
    // Not the same options object twice: the whole project is discovered,
    // serialized and walked again, so discovery order, property-bag insertion
    // order and every map iteration are exercised a second time.
    const first = renderEngineRequest(buildEngineRequest(await exampleRequestOptions()));
    const second = renderEngineRequest(buildEngineRequest(await exampleRequestOptions()));
    expect(second).toBe(first);
  });

  it("names every entity the estate declares, in nodes or in withheld, and never in neither", async () => {
    const options = await exampleRequestOptions();
    const request = buildEngineRequest(options);
    const accounted = new Set([
      ...request.nodes.map((n) => n.name),
      ...request.withheld.map((w) => w.name),
    ]);
    expect([...options.entityNames].filter((n) => !accounted.has(n))).toEqual([]);
    expect(accounted.size).toBe(options.entityNames.length);
  });

  it("sends the database and the queue, and withholds the boundaries around them", async () => {
    const request = buildEngineRequest(await exampleRequestOptions());
    const kinds = Object.fromEntries(request.nodes.map((n) => [n.name, n.kind]));
    expect(kinds.databaseDb).toBe("database");
    expect(kinds.arrivalsQueue).toBe("queue");
    expect(kinds["arrièreQueue"]).toBe("queue");
    expect(kinds.receipts).toBe("object-store");

    const withheld = Object.fromEntries(request.withheld.map((w) => [w.name, w]));
    expect(withheld.networkVpc?.status).toBe("declared-unmapped");
    expect(withheld.networkVpc?.detail).toContain("AWS::EC2::VPC");
    expect(withheld.networkPrivateSubnet1?.status).toBe("declared-unmapped");
    expect(withheld.receiptsPolicy?.detail).toContain("grant on the bucket beside it");
    // This lexicon's own entities are the request's input, not part of the
    // estate the request is about.
    expect(withheld.steady?.detail).toContain("the request's own input");
  });

  it("carries the caller's coverage claim through unchanged", async () => {
    const request = buildEngineRequest(await exampleRequestOptions());
    expect(request.coverage).toEqual(DECLARED_EDGE_COVERAGE);
  });

  it("answers a different traffic level with a different request", async () => {
    const steady = renderEngineRequest(buildEngineRequest(await exampleRequestOptions()));
    const peak = renderEngineRequest(buildEngineRequest(await exampleRequestOptions("1000 rps, p99")));
    expect(peak).not.toBe(steady);
    expect(peak).toContain('"traffic": "1000 rps, p99"');
  });
});

describe("what reaches the wire, and what does not", () => {
  it("renders a declared size verbatim, and a number as its digits", () => {
    expect(sizeOf({ InstanceType: "t3.medium" }, "InstanceType", "string")).toBe("t3.medium");
    expect(sizeOf({ MemorySize: 512 }, "MemorySize", "number")).toBe("512");
  });

  it("leaves a size the engine could not read absent rather than stringifying it", () => {
    // An unresolved intrinsic, a nested object, a NaN. A size an engine cannot
    // match against a price table is worse than no size: it is either ignored
    // in silence or matched against nothing.
    expect(sizeOf({ InstanceType: { Ref: "InstanceTypeParam" } }, "InstanceType", "string")).toBeUndefined();
    expect(sizeOf({ MemorySize: Number.NaN }, "MemorySize", "number")).toBeUndefined();
    expect(sizeOf({ InstanceType: "" }, "InstanceType", "string")).toBeUndefined();
    expect(sizeOf({}, "InstanceType", "string")).toBeUndefined();
    expect(sizeOf({ InstanceType: "t3.medium" }, undefined, "string")).toBeUndefined();
  });

  it("reads a dotted size path, and misses a broken one without throwing", () => {
    const props = { spec: { resources: { requests: { storage: "20Gi" } } } };
    expect(sizeOf(props, "spec.resources.requests.storage", "string")).toBe("20Gi");
    expect(sizeOf(props, "spec.resources.limits.storage", "string")).toBeUndefined();
    expect(sizeOf(props, "spec.template.spec.containers", "string")).toBeUndefined();
  });

  it("sorts keys canonically, so the bytes are a function of the content", () => {
    const request = buildEngineRequest({
      traffic: "100 rps, p50",
      region: "us-east-1",
      edges: [],
      edgeCoverage: { verdict: "unknown" as const },
      entityNames: ["a"],
      entities: new Map([["a", { entityType: "AWS::SQS::Queue", props: {} }]]),
    });
    // The object is assembled in the order the shape reads best in source;
    // the bytes come out sorted, so a reordering of the literal in
    // `request.ts` — or of a property bag two builds filled differently —
    // cannot move them.
    expect(Object.keys(request)).toEqual([
      "request",
      "traffic",
      "region",
      "nodes",
      "edges",
      "coverage",
      "withheld",
    ]);
    const rendered = renderEngineRequest(request);
    const written = [...rendered.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((m) => m[1]);
    expect(written).toEqual([...written].sort());
    expect(written).toEqual(["coverage", "edges", "nodes", "region", "request", "traffic", "withheld"]);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("reports a name asked about that the entities map does not hold", () => {
    const request = buildEngineRequest({
      traffic: "100 rps, p50",
      edges: [],
      edgeCoverage: { verdict: "unknown" },
      entityNames: ["ghost"],
      entities: new Map(),
    });
    expect(request.nodes).toEqual([]);
    expect(request.withheld).toHaveLength(1);
    expect(request.withheld[0].name).toBe("ghost");
    expect(request.withheld[0].detail).toContain("is not in the entities map");
  });

  it("sorts edges, so two builds that found them in two orders agree", () => {
    const options = {
      traffic: "100 rps, p50",
      edgeCoverage: { verdict: "unknown" as const },
      entityNames: ["a", "b"],
      entities: new Map([
        ["a", { entityType: "AWS::EC2::Instance", props: {} }],
        ["b", { entityType: "AWS::SQS::Queue", props: {} }],
      ]),
    };
    const one = renderEngineRequest(
      buildEngineRequest({
        ...options,
        edges: [
          { from: "b", to: "a", kind: "ref" as const },
          { from: "a", to: "b", kind: "ref" as const, viaAttr: "queueUrl" },
        ],
      }),
    );
    const other = renderEngineRequest(
      buildEngineRequest({
        ...options,
        edges: [
          { from: "a", to: "b", kind: "ref" as const, viaAttr: "queueUrl" },
          { from: "b", to: "a", kind: "ref" as const },
        ],
      }),
    );
    expect(other).toBe(one);
  });
});

describe("a size of the wrong type is absent, not coerced (D7)", () => {
  it("renders a number only where the row says the property holds one", () => {
    // `MemorySize` is a number in CloudFormation and reaches the engine as its
    // digits; `DBInstanceClass` is a name, and a number there is a wrong-typed
    // declaration or a parameter that folded. Rendering it as `"42"` sent a
    // size to be matched against a price table of instance-class names it does
    // not appear in — the outcome "absent beats unmatched" is written against,
    // through the door that argument left open.
    expect(sizeOf({ MemorySize: 512 }, "MemorySize", "number")).toBe("512");
    expect(sizeOf({ DBInstanceClass: 42 }, "DBInstanceClass", "string")).toBeUndefined();
    expect(sizeOf({ Size: "100" }, "Size", "number")).toBeUndefined();
    expect(sizeOf({ InstanceType: "t3.medium" }, "InstanceType", "string")).toBe("t3.medium");
  });

  it("keeps every mapped row's size type stated where it names a property", () => {
    for (const [type, mapping] of Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE)) {
      if (!mapping.sizeProp) continue;
      expect(["string", "number"], `${type} names a size property and no type`).toContain(mapping.sizeType);
    }
  });

  it("names no size property it cannot read", async () => {
    // A Kubernetes workload's size is its containers' resource requests: an
    // object, per container, over an array. Five rows named
    // `spec.template.spec.containers`, which `sizeOf` can never return a value
    // for, so every Kubernetes workload in the repository reached the engine
    // unsized while the table's column claimed otherwise.
    for (const type of [
      "K8s::Apps::Deployment",
      "K8s::Apps::StatefulSet",
      "K8s::Apps::DaemonSet",
      "K8s::Batch::Job",
      "K8s::Batch::CronJob",
    ]) {
      expect(ENGINE_KINDS_BY_ENTITY_TYPE[type].sizeProp, `${type} advertises a size`).toBeUndefined();
    }
  });
});

describe("the request's order is a function of its content, not its locale (D6)", () => {
  it("sorts by code unit, which disagrees with every locale on the fixture's own names", () => {
    const [a, b] = ["arrivalsQueue", "arrièreQueue"];
    expect([a, b].sort(byCodeUnit)).toEqual([a, b]);
    for (const locale of ["en-US", "sv-SE", "et-EE"]) {
      expect([a, b].sort((x, y) => x.localeCompare(y, locale)), locale).toEqual([b, a]);
    }
  });

  it("puts the fixture's non-ASCII pair in code-unit order in the golden", async () => {
    const request = buildEngineRequest(await exampleRequestOptions());
    const names = request.nodes.map((n) => n.name);
    expect(names.indexOf("arrivalsQueue")).toBeLessThan(names.indexOf("arrièreQueue"));
  });
});
