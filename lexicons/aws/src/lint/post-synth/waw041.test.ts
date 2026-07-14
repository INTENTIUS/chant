import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw041, checkDbProxyTls } from "./waw041";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW041: RDS Proxy TLS Not Required", () => {
  test("check metadata", () => {
    expect(waw041.id).toBe("WAW041");
    expect(waw041.description).toContain("TLS");
  });

  test("flags DBProxy missing RequireTLS", () => {
    const ctx = makeCtx({
      Resources: {
        MyProxy: {
          Type: "AWS::RDS::DBProxy",
          Properties: { DBProxyName: "my-proxy" },
        },
      },
    });
    const diags = checkDbProxyTls(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW041");
    expect(diags[0].severity).toBe("error");
  });

  test("flags DBProxy with RequireTLS: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyProxy: {
          Type: "AWS::RDS::DBProxy",
          Properties: { RequireTLS: false },
        },
      },
    });
    expect(checkDbProxyTls(ctx)).toHaveLength(1);
  });

  test("no diagnostic when RequireTLS: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyProxy: {
          Type: "AWS::RDS::DBProxy",
          Properties: { RequireTLS: true },
        },
      },
    });
    expect(checkDbProxyTls(ctx)).toHaveLength(0);
  });

  test("skips intrinsic value for RequireTLS", () => {
    const ctx = makeCtx({
      Resources: {
        MyProxy: {
          Type: "AWS::RDS::DBProxy",
          Properties: { RequireTLS: { Ref: "TlsParam" } },
        },
      },
    });
    expect(checkDbProxyTls(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-DBProxy resources", () => {
    const ctx = makeCtx({
      Resources: { MyDB: { Type: "AWS::RDS::DBInstance", Properties: {} } },
    });
    expect(checkDbProxyTls(ctx)).toHaveLength(0);
  });
});
