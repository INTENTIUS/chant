import { describe, expect, it } from "vitest";
import ts from "typescript";
import { noSecretLiteralsRule } from "./ftn001-no-secret-literals";
import { networkingExplicitCheck } from "../post-synth/ftn010-networking-explicit";
import { noCloudCredentialEnvCheck } from "../post-synth/ftn012-no-cloud-credential-env";
import type { LintContext } from "@intentius/chant/lint/rule";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant";

function lintCtx(code: string): LintContext {
  return {
    sourceFile: ts.createSourceFile("infra.ts", code, ts.ScriptTarget.Latest, true),
    entities: [],
    filePath: "infra.ts",
    lexicon: "fountain",
  } as LintContext;
}

function synthCtx(entities: Record<string, Record<string, unknown>>): PostSynthContext {
  const map = new Map<string, Declarable>();
  for (const [name, props] of Object.entries(entities)) {
    map.set(name, { lexicon: "fountain", ...props } as unknown as Declarable);
  }
  return { outputs: new Map(), entities: map, buildResult: { warnings: [], errors: [] } } as unknown as PostSynthContext;
}

describe("FTN001 no-secret-literals", () => {
  it("flags a literal AWS key inside a fountain declaration", () => {
    const diags = noSecretLiteralsRule.check(
      lintCtx(`export const e = new Environment({ env_vars: { K: "AKIAIOSFODNN7EXAMPLE" } });`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("FTN001");
  });

  it("flags a GitHub token inside an Agent's mcp env", () => {
    const diags = noSecretLiteralsRule.check(
      lintCtx(
        `export const a = new Agent({ mcp_servers: { gh: { env: { T: "ghp_abcdefghijklmnopqrstuv" } } } });`,
      ),
    );
    expect(diags).toHaveLength(1);
  });

  it("does not flag substitution references", () => {
    const diags = noSecretLiteralsRule.check(
      lintCtx(`export const a = new Agent({ mcp_servers: { gh: { env: { T: "\${GITHUB_PAT}" } } } });`),
    );
    expect(diags).toHaveLength(0);
  });

  it("ignores credential-shaped literals outside fountain declarations", () => {
    const diags = noSecretLiteralsRule.check(
      lintCtx(`const fixture = "AKIAIOSFODNN7EXAMPLE";`),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN010 networking-explicit", () => {
  it("warns on an Environment without networking_type", () => {
    const diags = networkingExplicitCheck.check(
      synthCtx({ env: { entityType: "Fountain::V1::Environment", name: "e" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("FTN010");
  });

  it("is silent when networking_type is explicit", () => {
    const diags = networkingExplicitCheck.check(
      synthCtx({
        env: { entityType: "Fountain::V1::Environment", name: "e", networking_type: "limited" },
      }),
    );
    expect(diags).toHaveLength(0);
  });

  it("ignores non-Environment kinds", () => {
    const diags = networkingExplicitCheck.check(
      synthCtx({ v: { entityType: "Fountain::V1::Vault", name: "v" } }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN012 no-cloud-credential-env", () => {
  it("errors on a credential key in env_vars", () => {
    const diags = noCloudCredentialEnvCheck.check(
      synthCtx({
        env: {
          entityType: "Fountain::V1::Environment",
          name: "e",
          env_vars: { AWS_SECRET_ACCESS_KEY: "whatever" },
        },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  it("errors on a credential-shaped value under an innocent key", () => {
    const diags = noCloudCredentialEnvCheck.check(
      synthCtx({
        env: {
          entityType: "Fountain::V1::Environment",
          name: "e",
          env_vars: { UPSTREAM: "AKIAIOSFODNN7EXAMPLE" },
        },
      }),
    );
    expect(diags).toHaveLength(1);
  });

  it("is silent on ordinary env vars", () => {
    const diags = noCloudCredentialEnvCheck.check(
      synthCtx({
        env: {
          entityType: "Fountain::V1::Environment",
          name: "e",
          env_vars: { LOG_LEVEL: "info" },
        },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});
