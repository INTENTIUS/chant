import { describe, test, expect } from "bun:test";
import {
  AWS,
  StackName,
  Region,
  AccountId,
  StackId,
  URLSuffix,
  NoValue,
  NotificationARNs,
  Partition,
} from "./pseudo";

describe("Pseudo-parameters", () => {
  test.each([
    { param: StackName, name: "StackName" },
    { param: Region, name: "Region" },
    { param: AccountId, name: "AccountId" },
    { param: StackId, name: "StackId" },
    { param: URLSuffix, name: "URLSuffix" },
    { param: NoValue, name: "NoValue" },
    { param: NotificationARNs, name: "NotificationARNs" },
    { param: Partition, name: "Partition" },
  ])("$name serializes correctly", ({ param, name }) => {
    expect(param.toJSON()).toEqual({ Ref: `AWS::${name}` });
  });
});

describe("AWS namespace", () => {
  test("contains all pseudo-parameters", () => {
    expect(AWS.StackName).toBe(StackName);
    expect(AWS.Region).toBe(Region);
    expect(AWS.AccountId).toBe(AccountId);
    expect(AWS.StackId).toBe(StackId);
    expect(AWS.URLSuffix).toBe(URLSuffix);
    expect(AWS.NoValue).toBe(NoValue);
    expect(AWS.NotificationARNs).toBe(NotificationARNs);
    expect(AWS.Partition).toBe(Partition);
  });

  test("pseudo-parameters are accessible via AWS namespace", () => {
    expect(AWS.StackName.toJSON()).toEqual({ Ref: "AWS::StackName" });
    expect(AWS.Region.toJSON()).toEqual({ Ref: "AWS::Region" });
  });
});

describe("toString", () => {
  test("StackName toString for Sub templates", () => {
    expect(StackName.toString()).toBe("${AWS::StackName}");
  });

  test("Region toString for Sub templates", () => {
    expect(Region.toString()).toBe("${AWS::Region}");
  });
});
