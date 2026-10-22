import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { HostnameEntry, AddressEntry } from "./latency-entry";

const base = { zoneId: "Z123", name: "app.example.com", id: "aws", region: "us-east-1" };

describe("HostnameEntry", () => {
  test("a latency CNAME to the hostname, guarded by an HTTP check on it", () => {
    const entry = HostnameEntry({ ...base, endpoint: "lb.example.net" });
    expect(Object.keys(entry.members)).toEqual(["check", "record"]);
    const check = (entry.check as any).props;
    expect(check.HealthCheckConfig).toEqual({
      Type: "HTTP",
      FullyQualifiedDomainName: "lb.example.net",
      ResourcePath: "/",
      RequestInterval: 10,
      FailureThreshold: 1,
    });
    const record = (entry.record as any).props;
    expect(record).toMatchObject({
      HostedZoneId: "Z123",
      Name: "app.example.com",
      Type: "CNAME",
      TTL: "60",
      SetIdentifier: "aws",
      Region: "us-east-1",
      ResourceRecords: ["lb.example.net"],
    });
    expect(record.HealthCheckId).toBe(entry.check.HealthCheckId);
  });

  test("an HTTPS check with a path and a string match", () => {
    const entry = HostnameEntry({
      ...base,
      endpoint: "lb.example.net",
      port: 8443,
      check: { protocol: "HTTPS", path: "/healthz", searchString: "ok" },
    });
    expect((entry.check as any).props.HealthCheckConfig).toMatchObject({
      Type: "HTTPS_STR_MATCH",
      ResourcePath: "/healthz",
      SearchString: "ok",
      Port: 8443,
    });
  });

  test("defaults override the check and the record", () => {
    const entry = HostnameEntry({
      ...base,
      endpoint: "lb.example.net",
      ttl: 30,
      defaults: { check: { HealthCheckConfig: { RequestInterval: 30, FailureThreshold: 3 } }, record: { Comment: "aws" } },
    });
    expect((entry.check as any).props.HealthCheckConfig).toMatchObject({ Type: "HTTP", RequestInterval: 30, FailureThreshold: 3 });
    expect((entry.record as any).props).toMatchObject({ TTL: "30", Comment: "aws", Type: "CNAME" });
  });

  test("expands to the entry's logical names", () => {
    const expanded = expandComposite("aws", HostnameEntry({ ...base, endpoint: "lb.example.net" }));
    expect([...expanded.keys()].sort()).toEqual(["awsCheck", "awsRecord"]);
  });
});

describe("AddressEntry", () => {
  test("an A record naming the address, a latency CNAME to it, and a check on the address", () => {
    const entry = AddressEntry({ ...base, id: "gcp", endpoint: "203.0.113.7", origin: "gcp.app.example.com", port: 80 });
    expect(Object.keys(entry.members)).toEqual(["check", "origin", "record"]);
    expect((entry.check as any).props.HealthCheckConfig).toEqual({
      Type: "HTTP",
      IPAddress: "203.0.113.7",
      Port: 80,
      ResourcePath: "/",
      RequestInterval: 10,
      FailureThreshold: 1,
    });
    expect((entry.origin as any).props).toEqual({
      HostedZoneId: "Z123",
      Name: "gcp.app.example.com",
      Type: "A",
      TTL: "60",
      ResourceRecords: ["203.0.113.7"],
    });
    const record = (entry.record as any).props;
    expect(record).toMatchObject({
      Name: "app.example.com",
      Type: "CNAME",
      SetIdentifier: "gcp",
      Region: "us-east-1",
      ResourceRecords: ["gcp.app.example.com"],
    });
    expect(record.HealthCheckId).toBe(entry.check.HealthCheckId);
    expect((entry.origin as any).props.SetIdentifier).toBeUndefined();
  });

  test("expands to the entry's logical names", () => {
    const expanded = expandComposite("gcp", AddressEntry({ ...base, endpoint: "203.0.113.7", origin: "gcp.app.example.com", port: 80 }));
    expect([...expanded.keys()].sort()).toEqual(["gcpCheck", "gcpOrigin", "gcpRecord"]);
  });
});
