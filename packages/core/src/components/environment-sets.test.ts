/**
 * #5348: config and secret sets per environment, resolved by the lookup a
 * step's `environments` uses (#5360), handed to a stage's jobs, and never
 * holding a secret's value. Every file these tests write is under a temp
 * directory.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ENV_SET_ENV,
  ENV_SET_FETCH_JS,
  ENVIRONMENT_SETS_FLOOR,
  EnvironmentSetError,
  environmentSetFetchLines,
  environmentSetJobInputs,
  environmentSetRecord,
  environmentSetSecretNames,
  environmentSetsProblems,
  resolveEnvironmentSet,
  type EnvironmentSets,
} from "./environment-sets";
import { environmentEntryName } from "./step-environments";
import { prLoopJobs } from "./pr-pipeline";
import { resolveCloudIdentity, type CloudIdentityDeclaration } from "../ci-identity";
import { cloudLogin } from "../ci-login";
import { ciRedactor } from "../workspace/ci-secrets";
import { NEXT_RELEASE } from "../release-floors";

const PROD_ARN = "arn:aws:secretsmanager:us-east-1:222222222222:secret:prod/api";
const STAGING_ARN = "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api";

const SETS: EnvironmentSets = {
  configSets: {
    base: { config: { LOG_LEVEL: "info", TIMEOUT: "30" } },
    common: { imports: ["base"], config: { LOG_LEVEL: "warn" }, secrets: { SENTRY_DSN: "SENTRY_DSN" } },
  },
  environments: {
    staging: {
      imports: ["common"],
      config: { REGION: "us-east-2" },
      secrets: { DB_PASSWORD: "STAGING_DB_PASSWORD", API_KEY: { awsSecretsManager: STAGING_ARN, jsonKey: "key" } },
    },
    prod: {
      imports: ["common"],
      config: { REGION: "us-east-1" },
      secrets: { DB_PASSWORD: { forgeSecret: "PROD_DB_PASSWORD" }, API_KEY: { awsSecretsManager: PROD_ARN } },
    },
  },
};

describe("resolving an environment's set (#5348)", () => {
  test("imports apply in order, the set's own values replace theirs, and each value records its set and the imports that led there", () => {
    const set = resolveEnvironmentSet(SETS, "staging");
    expect(set.entry).toBe("staging");
    expect(set.config).toEqual([
      { kind: "config", name: "LOG_LEVEL", value: "warn", from: "common", via: ["staging", "common"] },
      { kind: "config", name: "REGION", value: "us-east-2", from: "staging", via: ["staging"] },
      { kind: "config", name: "TIMEOUT", value: "30", from: "base", via: ["staging", "common", "base"] },
    ]);
    expect(set.secrets).toEqual([
      { kind: "secret", name: "API_KEY", source: { store: "aws-secrets-manager", id: STAGING_ARN, jsonKey: "key" }, from: "staging", via: ["staging"] },
      { kind: "secret", name: "DB_PASSWORD", source: { store: "forge", secret: "STAGING_DB_PASSWORD" }, from: "staging", via: ["staging"] },
      { kind: "secret", name: "SENTRY_DSN", source: { store: "forge", secret: "SENTRY_DSN" }, from: "common", via: ["staging", "common"] },
    ]);
  });

  test("the entry is picked by the lookup a step's environments uses: a pull request environment takes its template's", () => {
    expect(environmentEntryName(SETS.environments, "pr-12", { template: "staging" })).toBe("staging");
    expect(resolveEnvironmentSet(SETS, "pr-12", { template: "acme/shop/staging" }).entry).toBe("staging");
    expect(resolveEnvironmentSet(SETS, "pr-12", { processEnv: { CHANT_ENV_TEMPLATE: "staging" } }).entry).toBe("staging");
    expect(() => resolveEnvironmentSet(SETS, "dev")).toThrow(new EnvironmentSetError("the config and secret sets name staging, prod, and not dev"));
  });

  test("an environment's set imports shared sets alone, so staging never carries prod's", () => {
    const bad: EnvironmentSets = { environments: { staging: { imports: ["prod"] }, prod: { secrets: { DB_PASSWORD: "PROD_DB_PASSWORD" } } } };
    expect(environmentSetsProblems(bad)).toEqual([
      "the set of staging imports prod, an environment's set; a set imports shared sets (configSets) alone, so one stage never holds another's values",
    ]);
    expect(() => resolveEnvironmentSet(bad, "staging")).toThrow(EnvironmentSetError);
  });

  test("problems are named: unknown imports, cycles, bad names, both kinds, chant's own variables and store references", () => {
    expect(environmentSetsProblems({ environments: { a: { imports: ["nope"] } } })).toEqual(["the set of a imports nope, which configSets does not declare"]);
    expect(environmentSetsProblems({ configSets: { x: { imports: ["y"] }, y: { imports: ["x"] } }, environments: { a: { imports: ["x"] } } })).toEqual(["the shared sets import each other: x -> y -> x"]);
    expect(
      environmentSetsProblems({
        environments: {
          a: {
            config: { "bad-name": "1", CHANT_X: "1", BOTH: "1" },
            secrets: {
              BOTH: "S",
              B: { gcpSecretManager: "my-secret" },
              C: { azureKeyVault: "http://vault/secrets/x" },
              D: { forgeSecret: "A", awsSecretsManager: "x" },
              E: { awsSecretsManager: "x", key: "y" } as never,
              F: "not a name",
            },
          },
        },
      }),
    ).toEqual([
      `the set of a's config names "bad-name", which is not a variable name`,
      "the set of a's config names CHANT_X; a variable starting CHANT_ is one chant's jobs set themselves",
      "the set of a sets BOTH in both config and secrets; give it once",
      "the set of a's secret B names \"my-secret\", where it takes projects/<project>/secrets/<secret>, with /versions/<version> or the latest",
      "the set of a's secret C names \"http://vault/secrets/x\", where it takes the secret's URL, https://<vault>.vault.azure.net/secrets/<name>",
      "the set of a's secret D names one of forgeSecret, awsSecretsManager, gcpSecretManager and azureKeyVault",
      "the set of a's secret E sets key beside awsSecretsManager",
      `the set of a's secret F names the forge secret "not a name", which is not a secret name`,
    ]);
    expect(environmentSetsProblems(SETS)).toEqual([]);
  });

  test("the floor names the next release", () => {
    expect(ENVIRONMENT_SETS_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("a stage's jobs get their environment's set (#5348)", () => {
  test("the job inputs: config and the record as variables, forge secrets as passed secrets, store secrets as a read after the login", () => {
    const set = resolveEnvironmentSet(SETS, "staging");
    const inputs = environmentSetJobInputs(set, "github");
    expect(inputs.secrets).toEqual({ DB_PASSWORD: "STAGING_DB_PASSWORD", SENTRY_DSN: "SENTRY_DSN" });
    expect(inputs.variables).toMatchObject({ LOG_LEVEL: "warn", REGION: "us-east-2", TIMEOUT: "30" });
    expect(JSON.parse(inputs.variables[ENV_SET_ENV]!)).toEqual(environmentSetRecord(set));
    expect(environmentSetSecretNames(inputs.variables)).toEqual(["API_KEY", "DB_PASSWORD", "SENTRY_DSN"]);
    expect(inputs.setup).toHaveLength(4);
    expect(inputs.setup.join("\n")).toContain(STAGING_ARN);
    // Without secrets: the config and the record alone.
    expect(environmentSetJobInputs(set, "github", { secrets: false })).toMatchObject({ secrets: {}, setup: [] });
    // The read is one quoted node -e argument: the script holds no single quote.
    expect(ENV_SET_FETCH_JS).not.toContain("'");
  });

  test("the pull request loop: the plan job gets config and no secret, the apply and record jobs get the set, and the set replaces a pipeline variable", () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const [plan, apply, record] = prLoopJobs(forge, "staging", { environmentSets: SETS, variables: { REGION: "global", OTHER: "x" }, secrets: { DB_PASSWORD: "OLD" } });
      const secretRef = (name: string) => (forge === "gitlab" ? `$${name}` : `\${{ secrets.${name} }}`);
      expect(plan!.env).toMatchObject({ REGION: "us-east-2", OTHER: "x", LOG_LEVEL: "warn" });
      expect(plan!.env).not.toHaveProperty("DB_PASSWORD");
      expect(plan!.env).not.toHaveProperty("SENTRY_DSN");
      expect(plan!.setup ?? []).toEqual([]);
      // The record names where the stage's secrets are kept; the plan's variables read none of them.
      expect(Object.values(plan!.env).filter((v) => v.includes("STAGING_DB_PASSWORD") && !v.startsWith("{"))).toEqual([]);
      for (const job of [apply!, record!]) {
        expect(job.env).toMatchObject({ REGION: "us-east-2", DB_PASSWORD: secretRef("STAGING_DB_PASSWORD"), ...(forge === "gitlab" ? {} : { SENTRY_DSN: secretRef("SENTRY_DSN") }) });
        expect(job.env[ENV_SET_ENV]).toBeDefined();
        expect(job.setup!.join("\n")).toContain("node -e");
        expect(job.run.env).toMatchObject({ DB_PASSWORD: secretRef("STAGING_DB_PASSWORD") });
      }
    }
    // Off by default: no set, no change.
    expect(prLoopJobs("github", "staging")).toEqual(prLoopJobs("github", "staging", {}));
    expect(() => prLoopJobs("github", "dev", { environmentSets: SETS })).toThrow(/name staging, prod, and not dev/);
  });
});

describe("a staging job holds no production role or secret (#5348)", () => {
  const IDENTITY: CloudIdentityDeclaration = {
    aws: {
      rules: [
        { environments: ["staging"], plan: "arn:aws:iam::111111111111:role/staging-plan", apply: "arn:aws:iam::111111111111:role/staging-apply" },
        { environments: ["prod"], plan: "arn:aws:iam::222222222222:role/prod-plan", apply: "arn:aws:iam::222222222222:role/prod-apply" },
      ],
    },
  };

  test("the staging pipeline's jobs, trade and per-root login name staging's identity and set alone", () => {
    const identity = resolveCloudIdentity(IDENTITY, "staging")!;
    expect(identity.apply.aws?.role).toBe("arn:aws:iam::111111111111:role/staging-apply");
    const jobs = prLoopJobs("github", "staging", { environmentSets: SETS, identity });
    const login = cloudLogin("github", { aws: { role: identity.apply.aws!.role!, region: "us-east-2" } });
    const everything = JSON.stringify({ jobs, identity, login });
    for (const prod of ["222222222222", "prod-plan", "prod-apply", "PROD_DB_PASSWORD", PROD_ARN]) expect(everything, prod).not.toContain(prod);
    expect(everything).toContain("staging-apply");
    expect(everything).toContain("STAGING_DB_PASSWORD");
    // And the other way round.
    const prodJobs = JSON.stringify(prLoopJobs("github", "prod", { environmentSets: SETS, identity: resolveCloudIdentity(IDENTITY, "prod")! }));
    for (const staging of ["111111111111", "STAGING_DB_PASSWORD", STAGING_ARN]) expect(prodJobs, staging).not.toContain(staging);
  });
});

describe("secret values never reach the logs (#5348)", () => {
  const VALUE = "s3cret-from-store";
  const bin = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "chant-env-set-bin-"));
    const fake = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    fake("aws", `printf '{"key":"${VALUE}"}\\n'`);
    fake("gcloud", `printf '%s' "gcp-${VALUE}"`);
    fake("az", `echo "az-${VALUE}"`);
    return dir;
  };
  const SET: EnvironmentSets = {
    environments: {
      staging: {
        secrets: {
          API_KEY: { awsSecretsManager: STAGING_ARN, jsonKey: "key" },
          GCP_KEY: { gcpSecretManager: "projects/p/secrets/s" },
          AZ_KEY: { azureKeyVault: "https://v.vault.azure.net/secrets/k" },
        },
      },
    },
  };
  const run = (forge: "github" | "gitlab") => {
    const lines = environmentSetFetchLines(resolveEnvironmentSet(SET, "staging"), forge);
    const script = [...lines, 'test "$API_KEY" = "' + VALUE + '" && test "$GCP_KEY" = "gcp-' + VALUE + '" && test "$AZ_KEY" = "az-' + VALUE + '" && echo exported'].join("\n");
    const out = execFileSync("sh", ["-c", `{
${script}
} 2>&1`], { env: { PATH: `${bin()}:${process.env.PATH}` }, encoding: "utf8" });
    return out;
  };

  test("the read exports each secret, prints no value, and on GitHub masks each before the runner shows a line", () => {
    const github = run("github").trimEnd().split("\n");
    expect(github.at(-1)).toBe("exported");
    // The only lines with a value are the mask commands, which the runner takes and never shows.
    expect(github.filter((l) => l.includes(VALUE)).every((l) => l.startsWith("::add-mask::"))).toBe(true);
    expect(github.filter((l) => l.startsWith("::add-mask::"))).toHaveLength(3);
    expect(github).toContain("chant: read API_KEY from aws-secrets-manager");
    const gitlab = run("gitlab");
    expect(gitlab).not.toContain(VALUE);
    expect(gitlab.trimEnd().split("\n").at(-1)).toBe("exported");
  });

  test("a failed read stops the job and names the variable, never a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-env-set-bin-"));
    writeFileSync(join(dir, "aws"), "#!/bin/sh\necho 'AccessDenied for staging-apply' >&2\nexit 254\n");
    chmodSync(join(dir, "aws"), 0o755);
    const lines = environmentSetFetchLines(resolveEnvironmentSet({ environments: { staging: { secrets: { API_KEY: { awsSecretsManager: STAGING_ARN } } } } }, "staging"), "github");
    let failed: { status: number; stderr: string } | undefined;
    try {
      execFileSync("sh", ["-c", [...lines, "echo after"].join("\n")], { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      failed = err as { status: number; stderr: string };
    }
    expect(failed?.status).toBe(1);
    expect(failed?.stderr).toContain(`API_KEY (aws-secrets-manager ${STAGING_ARN}): aws exited 254: AccessDenied for staging-apply`);
  });

  test("chant ci run's redactor takes every secret the set names, whatever its name", () => {
    const inputs = environmentSetJobInputs(resolveEnvironmentSet(SETS, "staging"), "github");
    const env = { [ENV_SET_ENV]: inputs.variables[ENV_SET_ENV]!, DB_PASSWORD: "hunter22", SENTRY_DSN: "https://k@sentry/1", API_KEY: "abcd-1234", REGION: "us-east-2" };
    const redact = ciRedactor(env)!;
    expect(redact("db hunter22 dsn https://k@sentry/1 api abcd-1234 in us-east-2")).toBe("db *** dsn *** api *** in us-east-2");
    // The record holds names and where each is kept, never a value.
    for (const value of ["hunter22", "https://k@sentry/1", "abcd-1234"]) expect(inputs.variables[ENV_SET_ENV]).not.toContain(value);
  });
});
