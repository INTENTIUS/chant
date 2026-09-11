/**
 * The coverage resolution, now that rows are contributed rather than held
 * centrally (#2382).
 *
 * Two properties matter more than any individual row, and both are here
 * because #2357's version could not have them: resolution is **total** (every
 * type reaches exactly one verdict, so the request builder can promise every
 * entity lands in `entities` or in `unpredicted`), and an absent contributor
 * is **silence about an absent substrate**, never silence about entities that
 * are present.
 */

import { describe, expect, test } from "vitest";
import {
  ENGINE_KINDS,
  coverageFor,
  isEngineKind,
  type BehaviourKinds,
} from "./behaviour-kinds";

const aws: BehaviourKinds = {
  provider: "aws",
  prefixes: ["AWS::"],
  mapped: {
    "AWS::EC2::Instance": { kind: "compute", sizeProp: "InstanceType", sizeType: "string" },
    "AWS::S3::Bucket": { kind: "object-store" },
  },
  unmapped: {
    "AWS::IAM::Role": "a grant is not a resource: it carries no rate of its own",
  },
  // CloudFormation property types — hundreds of nested blocks that became
  // entities of their own, never separately priced.
  unmappedWhen: (type) =>
    type.includes(".")
      ? "a CloudFormation property type: the resource above it carries the figures"
      : undefined,
};

const cedar: BehaviourKinds = {
  provider: "cedar",
  prefixes: ["Cedar::"],
  nothingPriced: "Cedar (a policy language, with nothing to saturate)",
};

const terraform: BehaviourKinds = {
  provider: "aws",
  prefixes: ["Terraform::"],
  resolveType: (props) => {
    const address = props?.address;
    if (typeof address !== "string") return undefined;
    const dot = address.indexOf(".");
    return dot > 0 ? address.slice(0, dot) : undefined;
  },
  mapped: {
    aws_instance: { kind: "compute", sizeProp: "body.instance_type", sizeType: "string" },
  },
  unmapped: { aws_iam_role: "a grant is not a resource" },
};

const ALL = [aws, cedar, terraform];

describe("the kind enum", () => {
  test("is derived from a total witness, so a kind cannot be added and forgotten", () => {
    expect(ENGINE_KINDS).toContain("control-plane");
    expect(ENGINE_KINDS.length).toBe(new Set(ENGINE_KINDS).size);
  });

  test("isEngineKind rejects a plausible near-miss", () => {
    expect(isEngineKind("compute")).toBe(true);
    expect(isEngineKind("storage")).toBe(false);
    expect(isEngineKind(undefined)).toBe(false);
  });
});

describe("a lexicon's rows decide its own types", () => {
  test("a mapped type carries the kind, the size property and the contributor's provider", () => {
    const v = coverageFor(ALL, "AWS::EC2::Instance");
    expect(v.status).toBe("mapped");
    if (v.status !== "mapped") return;
    expect(v.mapping.kind).toBe("compute");
    expect(v.mapping.sizeProp).toBe("InstanceType");
    // The row did not state a provider; it inherits the contributor's, which
    // is what keeps `provider` off every row.
    expect(v.mapping.provider).toBe("aws");
  });

  test("a declared-unmapped type keeps the sentence saying why", () => {
    const v = coverageFor(ALL, "AWS::IAM::Role");
    expect(v.status).toBe("declared-unmapped");
    if (v.status !== "declared-unmapped") return;
    expect(v.reason).toContain("a grant is not a resource");
  });

  test("a whole substrate can say nothing is priced, once, without rows", () => {
    const v = coverageFor(ALL, "Cedar::Policy");
    expect(v.status).toBe("provider-not-modelled");
    if (v.status !== "provider-not-modelled") return;
    expect(v.substrate).toContain("nothing to saturate");
  });

  test("a type its own lexicon claims and cannot classify is the one defect verdict", () => {
    // Not `declared-unmapped`: nobody decided this, somebody forgot it.
    expect(coverageFor(ALL, "AWS::Kinesis::Stream").status).toBe("unknown-type");
  });

  test("unmappedWhen is the last word, for a family too large to enumerate", () => {
    const v = coverageFor(ALL, "AWS::S3::Bucket.VersioningConfiguration");
    expect(v.status).toBe("declared-unmapped");
    if (v.status !== "declared-unmapped") return;
    expect(v.reason).toContain("carries the figures");
  });
});

describe("a lexicon whose entities share one entity type", () => {
  test("rows are looked up on the type its props carry, not on the entity type", () => {
    const v = coverageFor(ALL, "Terraform::Resource", { address: "aws_instance.web" });
    expect(v.status).toBe("mapped");
    if (v.status !== "mapped") return;
    expect(v.mapping.sizeProp).toBe("body.instance_type");
  });

  test("nothing to resolve is no opinion, not a defect claim about the wrong type", () => {
    expect(coverageFor(ALL, "Terraform::Resource", {}).status).toBe("unknown-type");
    expect(coverageFor(ALL, "Terraform::Resource").status).toBe("unknown-type");
  });
});

describe("what an absent contributor means", () => {
  test("a type nobody claims is nobody's mistake", () => {
    // The gcp lexicon is not installed, so no GCP:: entity was declared. The
    // verdict exists for a type reached some other way, and it is silence.
    expect(coverageFor(ALL, "GCP::Compute::Instance").status).toBe("unknown-type");
  });

  test("removing a contributor changes only its own types", () => {
    const withoutAws = coverageFor([cedar, terraform], "AWS::EC2::Instance");
    expect(withoutAws.status).toBe("unknown-type");
    // Everyone else's verdicts are untouched — rows are additive, which is why
    // they may be optional when the capability may not be.
    expect(coverageFor([cedar, terraform], "Cedar::Policy").status).toBe("provider-not-modelled");
  });
});

describe("chant's own build-time entities", () => {
  test("are declared-unmapped before any contributor is consulted", () => {
    const v = coverageFor([], "chant:output:apiUrl");
    expect(v.status).toBe("declared-unmapped");
    if (v.status !== "declared-unmapped") return;
    expect(v.reason).toContain("never billed");
  });
});

describe("resolution is total", () => {
  test("every shape of input reaches exactly one verdict, including hostile keys", () => {
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ["AWS::EC2::Instance", undefined],
      ["AWS::IAM::Role", undefined],
      ["Cedar::Policy", undefined],
      ["Terraform::Resource", { address: "aws_instance.web" }],
      ["Terraform::Resource", undefined],
      ["GCP::Compute::Instance", undefined],
      ["chant:output:x", undefined],
      // A prototype member as an entity type: `hasOwnProperty` rather than a
      // truthiness check is what stops this resolving to a mapping that does
      // not exist.
      ["AWS::constructor", undefined],
      ["AWS::__proto__", undefined],
      ["", undefined],
    ];
    const seen = new Set<string>();
    for (const [type, props] of cases) {
      const v = coverageFor(ALL, type, props);
      expect(["mapped", "declared-unmapped", "provider-not-modelled", "unknown-type"]).toContain(v.status);
      seen.add(v.status);
    }
    // Not just legal: the cases above actually exercise all four arms.
    expect(seen.size).toBe(4);
  });
});
