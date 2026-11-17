/**
 * #5285: an SQS queue's ARN joins a Lambda environment value, and the ARNs
 * inside JSON text (a RedrivePolicy, a policy document) join the nodes they
 * name, over indexed nodes shaped as the lister writes them.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIdentityEdges, reconstructIndexedEdges, type IndexedNodeScope } from "@intentius/chant/graph-refs";
import { awsReferenceCatalog } from "./reference-catalog";
import { jsonTextRules, parseJsonText, POLICY_DOCUMENTS } from "./json-text-references";

const ACCOUNT = "aws/000000000000";
const scopeOf = (n: IRNode): IndexedNodeScope => ({ account: ACCOUNT, region: n.location });

const arn = (region: string, name: string) => `arn:aws:sqs:${region}:000000000000:${name}`;

function queue(region: string, name: string, attrs: Record<string, unknown> = {}): IRNode {
  return {
    id: `${ACCOUNT}/${region}/AWS::SQS::Queue/${name}`,
    kind: "AWS::SQS::Queue",
    lexicon: "aws",
    attrs: { QueueName: name, ...attrs },
    location: region,
    nativeId: name,
    facts: { cloudIds: [{ kind: "arn", value: arn(region, name) }, { kind: "import-id", value: name }] },
  };
}

function fn(region: string, name: string, env: Record<string, string>): IRNode {
  const a = `arn:aws:lambda:${region}:000000000000:function:${name}`;
  return {
    id: `${ACCOUNT}/${region}/AWS::Lambda::Function/${a}`,
    kind: "AWS::Lambda::Function",
    lexicon: "aws",
    attrs: { FunctionName: name, Environment: env },
    location: region,
    nativeId: a,
    facts: { cloudIds: [{ kind: "arn", value: a }, { kind: "import-id", value: a }] },
  };
}

function role(name: string, attrs: Record<string, unknown>): IRNode {
  const a = `arn:aws:iam::000000000000:role/${name}`;
  return {
    id: `${ACCOUNT}/global/AWS::IAM::Role/${name}`,
    kind: "AWS::IAM::Role",
    lexicon: "aws",
    attrs: { RoleName: name, Arn: a, ...attrs },
    location: "global",
    nativeId: name,
    facts: { cloudIds: [{ kind: "arn", value: a }, { kind: "import-id", value: name }] },
  };
}

const catalogs = [{ lexicon: "aws", catalog: awsReferenceCatalog }];
const derive = (nodes: IRNode[]) => reconstructIndexedEdges(nodes, catalogs, scopeOf);

describe("a queue's ARN names it", () => {
  it("joins a Lambda environment value holding the ARN, by identity match", () => {
    const q = queue("us-east-1", "app-jobs");
    const f = fn("us-east-1", "app-worker", { QUEUE_ARN: arn("us-east-1", "app-jobs") });
    const { edges, ambiguous } = reconstructIdentityEdges([q, f], [{ lexicon: "aws" }], scopeOf);
    expect(ambiguous).toEqual([]);
    expect(edges.map((e) => [e.from, e.to, e.viaAttr, e.rule])).toEqual([[f.id, q.id, "Environment", "identity-match:aws:AWS::SQS::Queue:arn"]]);
  });

  it("does not join a queue of the same name in another region", () => {
    const f = fn("us-west-2", "app-worker", { QUEUE_ARN: arn("us-east-1", "app-jobs") });
    const { edges } = reconstructIdentityEdges([queue("us-east-1", "app-jobs"), f], [{ lexicon: "aws" }], scopeOf);
    expect(edges).toEqual([]);
  });
});

describe("RedrivePolicy", () => {
  const policy = JSON.stringify({ deadLetterTargetArn: arn("us-east-1", "app-jobs-dlq"), maxReceiveCount: "3" });

  it("joins the dead-letter queue from the attribute map's JSON text", () => {
    const dlq = queue("us-east-1", "app-jobs-dlq");
    const q = queue("us-east-1", "app-jobs", { Attributes: { RedrivePolicy: policy } });
    const { edges, dangling } = derive([dlq, q]);
    expect(dangling).toEqual([]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: q.id, to: dlq.id, viaAttr: "RedrivePolicy", origin: "derived", rule: "aws:AWS::SQS::Queue:Attributes.RedrivePolicy.deadLetterTargetArn" });
  });

  it("reads the model's own RedrivePolicy, as text or as an object", () => {
    const dlq = queue("us-east-1", "app-jobs-dlq");
    for (const value of [policy, JSON.parse(policy)]) {
      const q = queue("us-east-1", "app-jobs", { RedrivePolicy: value });
      const { edges } = derive([dlq, q]);
      expect(edges.map((e) => [e.from, e.to, e.rule])).toEqual([[q.id, dlq.id, "aws:AWS::SQS::Queue:RedrivePolicy.deadLetterTargetArn"]]);
    }
  });

  it("joins within the holder's region, so a same-named queue elsewhere is not the target", () => {
    const east = queue("us-east-1", "app-jobs-dlq");
    const west = queue("us-west-2", "app-jobs-dlq");
    const q = queue("us-east-1", "app-jobs", { Attributes: { RedrivePolicy: policy } });
    expect(derive([east, west, q]).edges.map((e) => e.to)).toEqual([east.id]);
  });

  it("draws nothing for text that is not JSON or names no ARN", () => {
    const dlq = queue("us-east-1", "app-jobs-dlq");
    for (const value of ["not json", "{}", JSON.stringify({ deadLetterTargetArn: "app-jobs-dlq" })]) {
      expect(derive([dlq, queue("us-east-1", "app-jobs", { Attributes: { RedrivePolicy: value } })]).edges).toEqual([]);
    }
  });
});

describe("policy documents", () => {
  const dlq = queue("us-east-1", "app-jobs-dlq");
  const doc = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: [arn("us-east-1", "app-jobs-dlq"), "*"] }] };

  it("joins a Resource ARN in a document held as an object, as JSON text, and URL-encoded", () => {
    for (const value of [doc, JSON.stringify(doc), encodeURIComponent(JSON.stringify(doc))]) {
      const r = role("app-role", { Policies: [{ PolicyName: "send", PolicyDocument: value }] });
      const east: IRNode = { ...r, location: "us-east-1", id: `${ACCOUNT}/us-east-1/AWS::IAM::Role/app-role` };
      const { edges } = derive([dlq, east]);
      expect(edges.map((e) => [e.from, e.to, e.viaAttr, e.rule])).toEqual([
        [east.id, dlq.id, "Policies", "aws:AWS::IAM::Role:Policies[].PolicyDocument.Statement[].Resource"],
      ]);
    }
  });

  it("joins a Principal ARN in a trust policy to the role it names", () => {
    const target = role("deployer", {});
    const holder = role("app-role", { AssumeRolePolicyDocument: JSON.stringify({ Statement: { Effect: "Allow", Principal: { AWS: target.attrs.Arn, Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" } }) });
    const { edges } = derive([target, holder]);
    expect(edges.map((e) => [e.from, e.to, e.viaAttr])).toEqual([[holder.id, target.id, "AssumeRolePolicyDocument"]]);
    expect(edges[0].rule).toBe("aws:AWS::IAM::Role:AssumeRolePolicyDocument.Statement[].Principal.AWS");
  });

  it("names each property path it reads", () => {
    const paths = jsonTextRules().map((r) => `${r.from} ${r.path}`);
    expect(paths).toContain("AWS::SQS::Queue Attributes.RedrivePolicy.deadLetterTargetArn");
    for (const d of POLICY_DOCUMENTS) {
      expect(paths).toContain(`${d.from} ${d.path}.Statement[].Resource`);
      expect(paths).toContain(`${d.from} ${d.path}.Statement[].Principal.AWS`);
    }
  });

  it("parses what is not JSON as nothing", () => {
    expect(parseJsonText("%E0%A4%A")).toBeUndefined();
    expect(parseJsonText(undefined)).toBeUndefined();
  });
});
