import { describe, test, expect } from "vitest";
import {
  describeIdentities,
  identityRowFor,
  identityStatusText,
  isUnresolvedIdentity,
  redactCredentialMaterial,
  redactIdentityRow,
  REDACTED,
  type IdentityPlugin,
} from "./identity";

describe("the identity tri-state (#1982)", () => {
  test("a lexicon with no describeIdentity is not-reported, never an empty identity", async () => {
    const rows = await describeIdentities([{ name: "github" }], { environment: "prod" }, {});
    expect(rows).toEqual([{ lexicon: "github", status: "not-reported" }]);
    expect(rows[0].identity).toBeUndefined();
    expect(identityStatusText(rows[0])).toContain("not reported");
  });

  test("a resolved identity carries principal, scope, source and endpoint", async () => {
    const plugin: IdentityPlugin = {
      name: "aws",
      describeIdentity: async () => ({
        identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci",
        scope: "491500000000 us-east-1",
        source: "env AWS_ACCESS_KEY_ID",
        endpoint: "https://sts.us-east-1.amazonaws.com/",
      }),
    };
    const [row] = await describeIdentities([plugin], { environment: "prod" }, {});
    expect(row).toEqual({
      lexicon: "aws",
      status: "reported",
      identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci",
      scope: "491500000000 us-east-1",
      source: "env AWS_ACCESS_KEY_ID",
      endpoint: "https://sts.us-east-1.amazonaws.com/",
    });
  });

  test("no credentials and could-not-determine are distinguishable answers", async () => {
    const rows = await describeIdentities(
      [
        { name: "aws", describeIdentity: async () => ({ unresolved: { reason: "no-credentials" } }) },
        {
          name: "k8s",
          describeIdentity: async () => ({ unresolved: { reason: "read-failed", detail: "connection refused" } }),
        },
      ],
      { environment: "prod" },
      {},
    );
    expect(rows[0]).toEqual({ lexicon: "aws", status: "unresolved", reason: "no-credentials" });
    expect(identityStatusText(rows[0])).toContain("no identity is configured");
    expect(rows[1]).toEqual({
      lexicon: "k8s",
      status: "unresolved",
      reason: "read-failed",
      detail: "connection refused",
    });
    expect(identityStatusText(rows[1])).toContain("self-query failed");
    // The point of the distinction: "nothing is configured" and "I could not
    // find out" must never render as the same row.
    expect(identityStatusText(rows[0])).not.toBe(identityStatusText(rows[1]));
  });

  test("an empty principal is refused rather than reported as an identity", () => {
    const row = identityRowFor("gcp", { identity: "   ", scope: "acme-prod", source: "ADC" }, {});
    expect(row.status).toBe("unresolved");
    expect(row.reason).toBe("read-failed");
    expect(row.identity).toBeUndefined();
  });

  test("a lexicon that throws degrades to read-failed and never fails the run", async () => {
    const rows = await describeIdentities(
      [
        {
          name: "azure",
          describeIdentity: async () => {
            throw new Error("az CLI is not installed");
          },
        },
        { name: "aws", describeIdentity: async () => ({ identity: "arn:x", scope: "s", source: "env" }) },
      ],
      { environment: "prod" },
      {},
    );
    expect(rows[0]).toEqual({
      lexicon: "azure",
      status: "unresolved",
      reason: "read-failed",
      detail: "az CLI is not installed",
    });
    expect(rows[1].status).toBe("reported");
  });

  test("rows come back in the order the lexicons were configured", async () => {
    const names = ["k8s", "aws", "gcp", "github"];
    const rows = await describeIdentities(
      names.map((name) => ({ name })),
      { environment: "prod" },
      {},
    );
    expect(rows.map((r) => r.lexicon)).toEqual(names);
  });

  test("the environment, region and cwd reach the lexicon unchanged", async () => {
    const seen: unknown[] = [];
    await describeIdentities(
      [
        {
          name: "aws",
          describeIdentity: async (options) => {
            seen.push(options);
            return { identity: "arn:x", scope: "s", source: "env" };
          },
        },
      ],
      { environment: "prod", region: "eu-west-1", cwd: "/repo" },
      {},
    );
    expect(seen).toEqual([{ environment: "prod", region: "eu-west-1", cwd: "/repo" }]);
  });

  test("isUnresolvedIdentity discriminates the two return shapes", () => {
    expect(isUnresolvedIdentity({ unresolved: { reason: "no-binding" } })).toBe(true);
    expect(isUnresolvedIdentity({ identity: "a", scope: "b", source: "c" })).toBe(false);
  });
});

describe("no credential reaches the output (#1982)", () => {
  test("a value held in a credential-named env var is redacted wherever it appears", () => {
    const env = { GITHUB_TOKEN: "ghp_averyrealtokenvalue", HOME: "/Users/x" };
    expect(redactCredentialMaterial("authorized by ghp_averyrealtokenvalue", env)).toBe(
      `authorized by ${REDACTED}`,
    );
  });

  test("every free-text field of a row is scrubbed, not just the identity", () => {
    const env = { AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIsecretKEY" };
    const row = redactIdentityRow(
      {
        lexicon: "aws",
        status: "reported",
        identity: "wJalrXUtnFEMIsecretKEY",
        scope: "wJalrXUtnFEMIsecretKEY",
        source: "signed with wJalrXUtnFEMIsecretKEY",
        endpoint: "https://sts.amazonaws.com/?k=wJalrXUtnFEMIsecretKEY",
        detail: "wJalrXUtnFEMIsecretKEY",
      },
      env,
    );
    for (const field of [row.identity, row.scope, row.source, row.endpoint, row.detail]) {
      expect(field).not.toContain("wJalrXUtnFEMIsecretKEY");
      expect(field).toContain(REDACTED);
    }
  });

  test("a short env value is not treated as a credential", () => {
    // Redacting "dev" out of every identity would be worse than the leak.
    expect(redactCredentialMaterial("cluster dev-a", { AUTH_TOKEN: "dev" })).toBe("cluster dev-a");
  });

  test("literal credential shapes are redacted with no env var involved", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27u";
    expect(redactCredentialMaterial(jwt, {})).toBe(REDACTED);
    expect(redactCredentialMaterial("Bearer abcdefghijklmnopqrstuvwxyz012345", {})).toBe(REDACTED);
    expect(
      redactCredentialMaterial("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", {}),
    ).toBe(REDACTED);
  });

  test("real principals survive redaction unchanged", () => {
    // A mangled principal is a wrong answer, not a safe one. Nothing here is
    // entropy-scored, so these pass through whole.
    const env = { AWS_SESSION_TOKEN: "FwoGZXIvYXdzEBYaDLONGSESSIONTOKEN" };
    for (const principal of [
      "arn:aws:sts::491500000000:assumed-role/deploy/ci",
      "system:serviceaccount:chant:deployer",
      "deploy@acme.iam.gserviceaccount.com",
      "https://prod-eks-a.eu-west-1.eks.amazonaws.com",
      "491500000000 us-east-1",
    ]) {
      expect(redactCredentialMaterial(principal, env)).toBe(principal);
    }
  });

  test("an identity built out of the session token is redacted, not printed", () => {
    const env = { AWS_SESSION_TOKEN: "FwoGZXIvYXdzEBYaDLONGSESSIONTOKEN" };
    const row = identityRowFor(
      "aws",
      { identity: "FwoGZXIvYXdzEBYaDLONGSESSIONTOKEN", scope: "us-east-1", source: "env" },
      env,
    );
    expect(row.identity).toBe(REDACTED);
    expect(row.identity).not.toContain("FwoGZXIvYXdz");
  });
});
