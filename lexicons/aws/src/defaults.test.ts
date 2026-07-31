import { describe, it, expect } from "vitest";
import { stampProviderDefaults, canDetectDefault, DEFAULT_AWARE_KINDS } from "./defaults";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

const res = (type: string, attributes: Record<string, unknown>): ResourceMetadata => ({
  type,
  status: "OBSERVED",
  physicalId: "x",
  attributes,
});

const flag = (type: string, attributes: Record<string, unknown>) =>
  stampProviderDefaults({ r: res(type, attributes) }).r.attributes?.providerDefault;

// Every account arrives with resources nobody wrote. Asked which security
// groups were unused, agents split three ways on the same correct set of four,
// because chant gave them no way to tell a VPC's default group from one someone
// created.
describe("provider defaults (#1278)", () => {
  it("reads the marker AWS already sets, per kind", () => {
    expect(flag("AWS::EC2::VPC", { IsDefault: true })).toBe(true);
    expect(flag("AWS::EC2::Subnet", { DefaultForAz: true })).toBe(true);
    expect(flag("AWS::EC2::NetworkAcl", { IsDefault: true })).toBe(true);
    expect(flag("AWS::KMS::Key", { KeyManager: "AWS" })).toBe(true);
    expect(flag("AWS::IAM::ManagedPolicy", { Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess" })).toBe(true);
  });

  it("does not mark what the account holder created", () => {
    expect(flag("AWS::EC2::VPC", { IsDefault: false })).toBeUndefined();
    expect(flag("AWS::EC2::Subnet", { DefaultForAz: false })).toBeUndefined();
    expect(flag("AWS::KMS::Key", { KeyManager: "CUSTOMER" })).toBeUndefined();
    expect(flag("AWS::IAM::ManagedPolicy", { Arn: "arn:aws:iam::000000000000:policy/Mine" })).toBeUndefined();
  });

  it("treats the reserved group name as the marker it is", () => {
    // AWS refuses `default` on create, so a group carrying it is the one AWS
    // made with the VPC.
    expect(flag("AWS::EC2::SecurityGroup", { GroupName: "default" })).toBe(true);
    expect(flag("AWS::EC2::SecurityGroup", { GroupName: "default-web" })).toBeUndefined();
    expect(flag("AWS::EC2::SecurityGroup", { GroupName: "webSecurityGroup" })).toBeUndefined();
  });

  it("finds the main route table through its associations", () => {
    expect(flag("AWS::EC2::RouteTable", { Associations: [{ Main: true }] })).toBe(true);
    expect(flag("AWS::EC2::RouteTable", { Associations: [{ Main: false }, { Main: true }] })).toBe(true);
    expect(flag("AWS::EC2::RouteTable", { Associations: [{ Main: false }] })).toBeUndefined();
    expect(flag("AWS::EC2::RouteTable", {})).toBeUndefined();
  });

  it("leaves a kind it cannot judge unmarked rather than guessing", () => {
    // Absent means "not a default, or chant cannot tell". A blanket false would
    // hide the difference.
    expect(flag("AWS::EC2::Instance", { InstanceId: "i-1" })).toBeUndefined();
    expect(canDetectDefault("AWS::EC2::Instance")).toBe(false);
    expect(canDetectDefault("AWS::EC2::VPC")).toBe(true);
  });

  it("keeps every attribute it was given", () => {
    const out = stampProviderDefaults({
      r: res("AWS::EC2::SecurityGroup", { GroupName: "default", GroupId: "sg-1", region: "us-east-1" }),
    }).r.attributes;
    expect(out).toMatchObject({ GroupId: "sg-1", region: "us-east-1", providerDefault: true });
  });

  it("survives a payload it cannot read", () => {
    expect(flag("AWS::EC2::RouteTable", { Associations: "not-a-list" })).toBeUndefined();
  });

  it("reports the kinds it can judge, so a caller need not guess", () => {
    expect(DEFAULT_AWARE_KINDS).toContain("AWS::EC2::SecurityGroup");
    expect(DEFAULT_AWARE_KINDS.every(canDetectDefault)).toBe(true);
  });
});
