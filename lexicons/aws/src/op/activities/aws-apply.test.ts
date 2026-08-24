import { describe, test, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  awsApply,
  awsDelete,
  rollbackStack,
  cfnUrl,
  cfnForm,
  capabilityParams,
  xmlField,
  stackStatus,
  stackId,
  isStackMissing,
  isNoUpdates,
  isSuccessStatus,
  isFailureStatus,
  isTerminalStatus,
  type AwsHttp,
} from "./aws-apply";

const CREATE_OK = "<CreateStackResponse><CreateStackResult><StackId>arn:stack/s</StackId></CreateStackResult></CreateStackResponse>";
const UPDATE_OK = "<UpdateStackResponse><UpdateStackResult><StackId>arn:stack/s</StackId></UpdateStackResult></UpdateStackResponse>";
const MISSING = "<ErrorResponse><Error><Code>ValidationError</Code><Message>Stack with id s does not exist</Message></Error></ErrorResponse>";
const NO_UPDATES = "<ErrorResponse><Error><Message>No updates are to be performed.</Message></Error></ErrorResponse>";
const describe_ = (status: string) => `<DescribeStacksResponse><Stacks><member><StackId>arn:stack/s</StackId><StackStatus>${status}</StackStatus></member></Stacks></DescribeStacksResponse>`;

describe("CFN pure helpers (#awsApply)", () => {
  test("cfnUrl: endpoint override vs real regional host", () => {
    expect(cfnUrl("http://localhost:4566", undefined, {})).toBe("http://localhost:4566/");
    expect(cfnUrl(undefined, "eu-west-1", {})).toBe("https://cloudformation.eu-west-1.amazonaws.com/");
  });

  test("cfnUrl: AWS_ENDPOINT_URL[_CLOUDFORMATION] is an override too, the same rule as the read client (#1694)", () => {
    expect(cfnUrl(undefined, "eu-west-1", { AWS_ENDPOINT_URL: "http://localhost:4566" })).toBe("http://localhost:4566/");
    expect(
      cfnUrl(undefined, "eu-west-1", { AWS_ENDPOINT_URL: "http://all:1", AWS_ENDPOINT_URL_CLOUDFORMATION: "http://cfn:2" }),
    ).toBe("http://cfn:2/");
    expect(cfnUrl("http://opt:3", "eu-west-1", { AWS_ENDPOINT_URL: "http://all:1" })).toBe("http://opt:3/");
  });

  test("cfnForm stamps Action + Version", () => {
    expect(cfnForm("CreateStack", { StackName: "s" })).toEqual({ Action: "CreateStack", Version: "2010-05-15", StackName: "s" });
  });

  test("capabilityParams → Capabilities.member.N", () => {
    expect(capabilityParams(["CAPABILITY_NAMED_IAM", "CAPABILITY_IAM"])).toEqual({
      "Capabilities.member.1": "CAPABILITY_NAMED_IAM",
      "Capabilities.member.2": "CAPABILITY_IAM",
    });
  });

  test("xml parsing + status classification", () => {
    expect(xmlField(describe_("CREATE_COMPLETE"), "StackStatus")).toBe("CREATE_COMPLETE");
    expect(stackStatus(describe_("UPDATE_COMPLETE"))).toBe("UPDATE_COMPLETE");
    expect(stackId(CREATE_OK)).toBe("arn:stack/s");
    expect(isStackMissing(MISSING)).toBe(true);
    expect(isNoUpdates(NO_UPDATES)).toBe(true);
    expect(isSuccessStatus("CREATE_COMPLETE")).toBe(true);
    expect(isSuccessStatus("UPDATE_COMPLETE_CLEANUP_IN_PROGRESS")).toBe(false); // transient, not settled
    expect(isFailureStatus("ROLLBACK_COMPLETE")).toBe(true);
    expect(isFailureStatus("CREATE_FAILED")).toBe(true);
    expect(isTerminalStatus("CREATE_IN_PROGRESS")).toBe(false);
    expect(isTerminalStatus("DELETE_COMPLETE")).toBe(true);
  });
});

function tmpl(extra: Record<string, unknown> = {}): string {
  const p = `/tmp/chant-cfn-${process.pid}-${Math.round(performance.now())}.json`;
  writeFileSync(p, JSON.stringify({ ...extra, Resources: { B: { Type: "AWS::S3::Bucket" } } }));
  return p;
}

describe("awsApply flow (#awsApply)", () => {
  test("create path: absent stack → CreateStack → poll to CREATE_COMPLETE", async () => {
    const calls: string[] = [];
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      calls.push(form.Action);
      if (form.Action === "DescribeStacks") return described++ === 0 ? { status: 400, text: MISSING } : { status: 200, text: describe_("CREATE_COMPLETE") };
      return { status: 200, text: CREATE_OK };
    };
    const p = tmpl();
    const res = await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(p);
    expect(res).toEqual({ stackName: "s", status: "CREATE_COMPLETE", action: "created" });
    expect(calls).toEqual(["DescribeStacks", "CreateStack", "DescribeStacks"]);
  });

  test("capabilities follow the template: NAMED_IAM alone, plus AUTO_EXPAND for a Transform (#980)", async () => {
    const sent: Record<string, string>[] = [];
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return described++ % 2 === 0 ? { status: 400, text: MISSING } : { status: 200, text: describe_("CREATE_COMPLETE") };
      sent.push(form);
      return { status: 200, text: CREATE_OK };
    };
    const plain = tmpl();
    await awsApply({ templatePath: plain, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(plain);
    expect(sent[0]["Capabilities.member.1"]).toBe("CAPABILITY_NAMED_IAM");
    expect(sent[0]["Capabilities.member.2"]).toBeUndefined();

    const macro = tmpl({ Transform: "AWS::SecretsManager-2020-07-23" });
    await awsApply({ templatePath: macro, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(macro);
    expect(sent[1]["Capabilities.member.1"]).toBe("CAPABILITY_NAMED_IAM");
    expect(sent[1]["Capabilities.member.2"]).toBe("CAPABILITY_AUTO_EXPAND");

    // An explicit list still wins.
    const explicit = tmpl({ Transform: "AWS::Serverless-2016-10-31" });
    await awsApply({ templatePath: explicit, stackName: "s", endpoint: "http://x", intervalMs: 1, capabilities: ["CAPABILITY_IAM"] }, undefined, http);
    unlinkSync(explicit);
    expect(sent[2]["Capabilities.member.1"]).toBe("CAPABILITY_IAM");
    expect(sent[2]["Capabilities.member.2"]).toBeUndefined();
  });

  test("the template's ownership Metadata becomes the STACK's own tags on create AND update (#1222)", async () => {
    const sent: Array<Record<string, string>> = [];
    let described = 0;
    const createHttp: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return described++ === 0 ? { status: 400, text: MISSING } : { status: 200, text: describe_("CREATE_COMPLETE") };
      sent.push(form);
      return { status: 200, text: CREATE_OK };
    };
    const p = tmpl({
      Metadata: { "chant:ownership": { "chant:managed-by": "chant", "chant:stack": "shop", "chant:env": "dev" } },
    });
    await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, createHttp);

    expect(sent[0].Action).toBe("CreateStack");
    expect(sent[0]["Tags.member.1.Key"]).toBe("chant:env");
    expect(sent[0]["Tags.member.1.Value"]).toBe("dev");
    expect(sent[0]["Tags.member.2.Key"]).toBe("chant:managed-by");
    expect(sent[0]["Tags.member.2.Value"]).toBe("chant");
    expect(sent[0]["Tags.member.3.Key"]).toBe("chant:stack");
    expect(sent[0]["Tags.member.3.Value"]).toBe("shop");

    // Update path re-stamps the same tags.
    let updDescribed = 0;
    const updateHttp: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_(updDescribed++ === 0 ? "CREATE_COMPLETE" : "UPDATE_COMPLETE") };
      sent.push(form);
      return { status: 200, text: UPDATE_OK };
    };
    await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, updateHttp);
    unlinkSync(p);
    expect(sent[1].Action).toBe("UpdateStack");
    expect(sent[1]["Tags.member.2.Key"]).toBe("chant:managed-by");
  });

  test("a template without the ownership Metadata sends no Tags parameter at all", async () => {
    const sent: Array<Record<string, string>> = [];
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return described++ === 0 ? { status: 400, text: MISSING } : { status: 200, text: describe_("CREATE_COMPLETE") };
      sent.push(form);
      return { status: 200, text: CREATE_OK };
    };
    const p = tmpl();
    await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(p);
    expect(Object.keys(sent[0]).some((k) => k.startsWith("Tags."))).toBe(false);
  });

  test("update path: existing stack → UpdateStack → UPDATE_COMPLETE", async () => {
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_(described++ === 0 ? "CREATE_COMPLETE" : "UPDATE_COMPLETE") };
      return { status: 200, text: UPDATE_OK };
    };
    const p = tmpl();
    const res = await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(p);
    expect(res.action).toBe("updated");
    expect(res.status).toBe("UPDATE_COMPLETE");
  });

  test("no-op update (real-AWS error) → unchanged, no poll", async () => {
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_("CREATE_COMPLETE") };
      return { status: 400, text: NO_UPDATES }; // UpdateStack
    };
    const p = tmpl();
    const res = await awsApply({ templatePath: p, stackName: "s", endpoint: "http://x" }, undefined, http);
    unlinkSync(p);
    expect(res).toEqual({ stackName: "s", status: "UPDATE_COMPLETE", action: "unchanged" });
  });

  test("throws when the stack settles to a failure state", async () => {
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return described++ === 0 ? { status: 400, text: MISSING } : { status: 200, text: describe_("ROLLBACK_COMPLETE") };
      return { status: 200, text: CREATE_OK };
    };
    const p = tmpl();
    await expect(
      awsApply({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http),
    ).rejects.toThrow(/created → ROLLBACK_COMPLETE/);
    unlinkSync(p);
  });

  test("surfaces a CreateStack API error", async () => {
    const http: AwsHttp = async (_url, form) =>
      form.Action === "DescribeStacks" ? { status: 400, text: MISSING } : { status: 400, text: "<Error><Message>bad template</Message></Error>" };
    const p = tmpl();
    await expect(
      awsApply({ templatePath: p, stackName: "s", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/CreateStack failed \(400\): bad template/);
    unlinkSync(p);
  });
});

describe("awsDelete (#awsApply)", () => {
  test("DeleteStack then polls until the stack is gone", async () => {
    const calls: string[] = [];
    let described = 0;
    const http: AwsHttp = async (_url, form) => {
      calls.push(form.Action);
      if (form.Action === "DescribeStacks") return described++ === 0 ? { status: 200, text: describe_("DELETE_IN_PROGRESS") } : { status: 400, text: MISSING };
      return { status: 200, text: "<DeleteStackResponse/>" };
    };
    const p = tmpl();
    const res = await awsDelete({ templatePath: p, stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    unlinkSync(p);
    expect(res).toEqual({ stackName: "s", deleted: true });
    expect(calls[0]).toBe("DeleteStack");
  });
});

describe("rollbackStack (#1449)", () => {
  test("RollbackStack then polls to UPDATE_ROLLBACK_COMPLETE", async () => {
    const calls: string[] = [];
    const http: AwsHttp = async (_url, form) => {
      calls.push(form.Action);
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_("UPDATE_ROLLBACK_COMPLETE") };
      return { status: 200, text: "<RollbackStackResponse/>" };
    };
    const res = await rollbackStack({ stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    expect(res).toEqual({ stackName: "s", rolledBack: true, status: "UPDATE_ROLLBACK_COMPLETE" });
    expect(calls[0]).toBe("RollbackStack");
    expect(calls[0]).not.toBe("DescribeStacks"); // no probe first — the action itself answers
  });

  test("posts the stack name on the Query API form", async () => {
    const forms: Record<string, string>[] = [];
    const http: AwsHttp = async (_url, form) => {
      forms.push(form);
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_("ROLLBACK_COMPLETE") };
      return { status: 200, text: "<RollbackStackResponse/>" };
    };
    await rollbackStack({ stackName: "prod", endpoint: "http://x", intervalMs: 1 }, undefined, http);
    expect(forms[0]).toMatchObject({ Action: "RollbackStack", StackName: "prod" });
    expect(forms[0].Version).toBeDefined();
  });

  test("an absent stack is nothing to roll back — rolledBack: false, no throw", async () => {
    const http: AwsHttp = async () => ({ status: 400, text: MISSING });
    const res = await rollbackStack({ stackName: "s", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ stackName: "s", rolledBack: false });
  });

  test("a target without RollbackStack (Floci's UnknownAction, #947) degrades, not crashes", async () => {
    const http: AwsHttp = async () => ({
      status: 400,
      text: "<ErrorResponse><Error><Code>UnknownAction</Code><Message>Action RollbackStack is not supported.</Message></Error></ErrorResponse>",
    });
    const res = await rollbackStack({ stackName: "s", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ stackName: "s", rolledBack: false });
  });

  test("any other API error throws — a compensation must not fail silently", async () => {
    const http: AwsHttp = async () => ({
      status: 400,
      text: "<ErrorResponse><Error><Message>Rollback requires a stack in UPDATE_FAILED state</Message></Error></ErrorResponse>",
    });
    await expect(rollbackStack({ stackName: "s", endpoint: "http://x" }, undefined, http)).rejects.toThrow(
      /RollbackStack failed \(400\): Rollback requires/,
    );
  });

  test("throws when the stack settles anywhere but *ROLLBACK_COMPLETE", async () => {
    const http: AwsHttp = async (_url, form) => {
      if (form.Action === "DescribeStacks") return { status: 200, text: describe_("UPDATE_ROLLBACK_FAILED") };
      return { status: 200, text: "<RollbackStackResponse/>" };
    };
    await expect(rollbackStack({ stackName: "s", endpoint: "http://x", intervalMs: 1 }, undefined, http)).rejects.toThrow(
      /rollback → UPDATE_ROLLBACK_FAILED/,
    );
  });
});
