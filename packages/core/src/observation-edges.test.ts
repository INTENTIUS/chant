// An observation's own edges (chant#4528): the terraform lexicon's read of
// `choudoufu live-graph` returns block edges with its resources, and core
// carries them through the envelope to `LiveObservation.edges`.
import { describe, it, expect } from "vitest";
import { mergeObservations, normalizeObservation, observation } from "./observation";
import { buildLiveGraphIr, type IREdge } from "./graph-ir";

const block: IREdge = { from: "web/module.app/aws_instance.web", to: "web/aws_s3_bucket.logs", kind: "ref", viaAttr: "dependencies", grain: "block" };
const instance: IREdge = { ...block, grain: "instance" };

describe("observation edges (#4528)", () => {
  it("the envelope carries edges, and leaves the field off when there are none", () => {
    expect(observation({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [block]).edges).toEqual([block]);
    expect("edges" in observation({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [])).toBe(false);
    expect(normalizeObservation(observation({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [block])).edges).toEqual([block]);
    expect(normalizeObservation({}).edges).toBeUndefined();
  });

  it("a merge keeps each edge once, and two grains between one pair as two", () => {
    const part = normalizeObservation(observation({}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [block, instance]));
    expect(mergeObservations([part, part]).edges).toEqual([block, instance]);
    expect(mergeObservations([normalizeObservation({})]).edges).toBeUndefined();
  });

  it("buildLiveGraphIr keeps an observation edge whose endpoints were both observed", () => {
    const resources = {
      "web/module.app/aws_instance.web": { type: "Terraform::Resource", status: "bound" },
      "web/aws_s3_bucket.logs": { type: "Terraform::Resource", status: "bound" },
    };
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources, edges: [block, { ...block, to: "web/aws_sqs_queue.gone" }] }]);
    expect(ir.edges).toEqual([block]);
  });
});
