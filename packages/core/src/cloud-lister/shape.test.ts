/**
 * behold#1029: the pieces of the listing-result shape: node ids (ruling Q2),
 * masking (chant's one key list), and markers (chant#4520's shape).
 */
import { describe, expect, it } from "vitest";
import { listedNodeId, parseListedNodeId } from "./ids";
import { isSensitiveKey, MASKED, maskProperties, maskTags, SENSITIVE_KEY_PATTERNS } from "./mask";
import { readMarkers } from "./markers";
import { isSensitiveKey as chantIsSensitiveKey, SENSITIVE_KEY_PATTERNS as chantPatterns } from "../sensitive-key";

describe("listed node ids", () => {
  it("are path-style and parse back, with slashes in the type and the native id", () => {
    const parts = {
      substrate: "azure" as const,
      scopeId: "sub-1",
      location: "eastus",
      listedType: "microsoft.storage/storageaccounts",
      nativeId: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa",
    };
    const id = listedNodeId(parts);
    expect(id).toBe("azure/sub-1/eastus/microsoft.storage%2Fstorageaccounts//subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa");
    expect(parseListedNodeId(id)).toEqual(parts);
  });

  it("keep an aws identifier verbatim as the last part", () => {
    const id = listedNodeId({ substrate: "aws", scopeId: "000000000000", location: "us-east-1", listedType: "AWS::EC2::SecurityGroupIngress", nativeId: "sg-1|tcp|80" });
    expect(id).toBe("aws/000000000000/us-east-1/AWS::EC2::SecurityGroupIngress/sg-1|tcp|80");
    expect(parseListedNodeId(id)?.nativeId).toBe("sg-1|tcp|80");
  });

  it("escape a percent sign so it parses back", () => {
    const parts = { substrate: "kubernetes" as const, scopeId: "c%1", location: "ns", listedType: "v1/Pod", nativeId: "ns/p" };
    expect(parseListedNodeId(listedNodeId(parts))).toEqual(parts);
  });
});

describe("masking", () => {
  it("masks by key at any depth and in key/value pairs", () => {
    const masked = maskProperties({
      Name: "db",
      MasterUserPassword: "hunter2",
      Nested: { list: [{ clientSecret: "s" }, { ok: 1 }] },
      Tags: [{ Key: "github-token", Value: "ghp_x" }, { Key: "env", Value: "prod" }],
      KeyName: "deploy-key",
    });
    expect(masked).toEqual({
      Name: "db",
      MasterUserPassword: MASKED,
      Nested: { list: [{ clientSecret: MASKED }, { ok: 1 }] },
      Tags: [{ Key: "github-token", Value: MASKED }, { Key: "env", Value: "prod" }],
      KeyName: "deploy-key",
    });
    expect(maskTags({ "db-password": "x", env: "prod" })).toEqual({ "db-password": MASKED, env: "prod" });
  });

  it("is chant's one key list (../sensitive-key.ts), not a copy", () => {
    expect(SENSITIVE_KEY_PATTERNS).toBe(chantPatterns);
    for (const k of ["password", "Secret", "apiToken", "private_key", "credentials", "ConnectionString", "Key", "KeyName"]) {
      expect(isSensitiveKey(k)).toBe(chantIsSensitiveKey(k));
    }
  });
});

describe("markers", () => {
  it("reads choudoufu's, plunge's and chant's keys, in that order", () => {
    expect(readMarkers({ "tofu-estate": "web", "tofu-address": "module.app.aws_eip.pool[1]", "chant:managed-by": "chant" }, { labels: false })).toEqual({
      owner: "web",
      address: "module.app.aws_eip.pool[1]",
      encoding: "escaped",
      source: "live",
    });
    expect(readMarkers({ "plunge-stack": "app/dev", "plunge-urn": "urn:pulumi:", "plunge-urn-2": "dev::app" }, { labels: false })).toEqual({
      owner: "app/dev",
      address: "urn:pulumi:dev::app",
      encoding: "plain",
      source: "live",
    });
    expect(readMarkers({ "Chant-Managed-By": "chant", "chant-stack": "web" }, { labels: false })).toEqual({ owner: "web", encoding: "plain", source: "live" });
    expect(readMarkers({ "managed-by": "terraform" }, { labels: true })).toBeUndefined();
  });
});
