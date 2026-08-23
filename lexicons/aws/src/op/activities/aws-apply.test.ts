import { describe, test, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  awsApply,
  awsDelete,
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
    expect(cfnUrl("http://localhost:4566")).toBe("http://localhost:4566/");
    expect(cfnUrl(undefined, "eu-west-1")).toBe("https://cloudformation.eu-west-1.amazonaws.com/");
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
