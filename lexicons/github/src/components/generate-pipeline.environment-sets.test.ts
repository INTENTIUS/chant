/**
 * #5348 on github: each stage's jobs take that stage's config and secret set and
 * log in as that stage alone. The first stage's wave jobs get theirs
 * through the op-waves generator, each later stage's promote job its own,
 * and a staging job names no production role, account or secret.
 */
import { expect, test } from "vitest";
import { foldPipelineSource } from "@intentius/chant/pipeline";
import { generatePipeline } from "@intentius/chant/pipeline/generate";
import type { EnvironmentSets } from "@intentius/chant/components/environment-sets";
import type { CloudIdentityDeclaration } from "@intentius/chant/ci-identity";
import { githubPlugin as plugin } from "../plugin";

const FORGE = "github";

const FILE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }] },
  ],
});
`;

const role = (env: string, account: string, side: string) => `arn:aws:iam::${account}:role/${env}-${side}`;
const IDENTITY: CloudIdentityDeclaration = {
  aws: {
    rules: [
      { environments: ["dev"], plan: role("dev", "333333333333", "plan"), apply: role("dev", "333333333333", "apply") },
      { environments: ["staging"], plan: role("staging", "111111111111", "plan"), apply: role("staging", "111111111111", "apply") },
      { environments: ["prod"], plan: role("prod", "222222222222", "plan"), apply: role("prod", "222222222222", "apply") },
    ],
  },
};

const secretArn = (env: string, account: string) => `arn:aws:secretsmanager:us-east-1:${account}:secret:${env}/api`;
const SETS: EnvironmentSets = {
  configSets: { common: { config: { LOG_LEVEL: "info" } } },
  environments: {
    dev: { imports: ["common"], config: { REGION: "dev-region" }, secrets: { DB_PASSWORD: "DEV_DB_PASSWORD", API_KEY: { awsSecretsManager: secretArn("dev", "333333333333") } } },
    staging: { imports: ["common"], config: { REGION: "staging-region" }, secrets: { DB_PASSWORD: "STAGING_DB_PASSWORD", API_KEY: { awsSecretsManager: secretArn("staging", "111111111111") } } },
    prod: { imports: ["common"], config: { REGION: "prod-region" }, secrets: { DB_PASSWORD: "PROD_DB_PASSWORD", API_KEY: { awsSecretsManager: secretArn("prod", "222222222222") } } },
  },
};

/** What marks each environment's identity and set in a rendered file. */
const MARKS: Record<string, string[]> = {
  dev: ["333333333333", "dev-apply", "DEV_DB_PASSWORD", "dev-region"],
  staging: ["111111111111", "staging-apply", "STAGING_DB_PASSWORD", "staging-region"],
  prod: ["222222222222", "prod-apply", "PROD_DB_PASSWORD", "prod-region"],
};

function holdsOnly(text: string, env: string): void {
  for (const mark of MARKS[env]!) expect(text, `${env} holds ${mark}`).toContain(mark);
  for (const [other, marks] of Object.entries(MARKS)) if (other !== env) for (const mark of marks) expect(text, `${env} holds ${other}'s ${mark}`).not.toContain(mark);
}

const spec = () => {
  const folded = foldPipelineSource(FILE);
  if (!("spec" in folded)) throw new Error(folded.finding.message);
  return folded.spec;
};

test("each stage's jobs hold that stage's identity and set alone", async () => {
  const out = await generatePipeline(spec(), FORGE, { environmentSets: SETS, identity: IDENTITY }, plugin);
  expect(out.error).toBeUndefined();
  const [waves, promote] = out.files!;
  // The merge's waves are the first stage, dev.
  holdsOnly(waves!.yaml, "dev");
  expect(waves!.yaml).toContain("CHANT_ENV_SET");
  expect(waves!.yaml).toContain("CHANT_ENV_SET_FETCH");
  // One promote job per later stage: staging's holds no production role or secret, and prod's none of staging's.
  const at = promote!.yaml.indexOf("promote-prod:");
  expect(at).toBeGreaterThan(0);
  holdsOnly(promote!.yaml.slice(promote!.yaml.indexOf("promote-staging:"), at), "staging");
  holdsOnly(promote!.yaml.slice(at), "prod");
});

test("without sets or identities the files are the ones rendered before", async () => {
  const before = await generatePipeline(spec(), FORGE, {}, plugin);
  const off = await generatePipeline(spec(), FORGE, { environmentSets: undefined, identity: undefined }, plugin);
  expect(off.files).toEqual(before.files);
  expect(JSON.stringify(before.files)).not.toContain("CHANT_ENV_SET");
});

test("a stage the sets do not name is refused", async () => {
  const { dev: _dev, ...rest } = SETS.environments;
  const out = await generatePipeline(spec(), FORGE, { environmentSets: { ...SETS, environments: rest } }, plugin);
  expect(out.success).toBe(false);
  expect(out.error).toContain("not dev");
});

test("a product's op-waves spec: each wave takes the set its name gives, its store read after its trade, and before merge a set with secrets is refused", async () => {
  const { generateGithubOpWavesPipeline } = await import("./generate-op-waves-pipeline");
  const { resolveCloudIdentity } = await import("@intentius/chant/ci-identity");
  const waves = {
    name: "estate",
    op: "estate",
    plan: ["./bin/plan", "{target}", "{plan}"],
    waves: [
      { name: "staging", runs: [{ target: "staging" }], cloud: resolveCloudIdentity(IDENTITY, "staging")!.apply },
      { name: "prod", runs: [{ target: "prod" }], cloud: resolveCloudIdentity(IDENTITY, "prod")!.apply },
    ],
  };
  const plain = generateGithubOpWavesPipeline(waves, { specFile: "waves.json" });
  const { dev: _dev, ...envs } = SETS.environments;
  const out = generateGithubOpWavesPipeline(waves, { specFile: "waves.json", environmentSets: { ...SETS, environments: envs } });
  const yaml = out.files[0]!.yaml;
  const prodAt = yaml.indexOf("\n  wave-2");
  expect(prodAt).toBeGreaterThan(0);
  holdsOnly(yaml.slice(yaml.indexOf("\n  wave-1"), prodAt), "staging");
  holdsOnly(yaml.slice(prodAt), "prod");
  // The read sits in the command's step, after the trade step.
  const staging = yaml.slice(yaml.indexOf("\n  wave-1"), prodAt);
  expect(staging.indexOf("Trade the job's OIDC token")).toBeLessThan(staging.indexOf("CHANT_ENV_SET_FETCH="));
  // Without sets, the same file as before.
  expect(generateGithubOpWavesPipeline(waves, { specFile: "waves.json", environmentSets: undefined }).files).toEqual(plain.files);
  expect(() => generateGithubOpWavesPipeline(waves, { specFile: "waves.json", environmentSets: { ...SETS, environments: envs }, beforeMerge: { merge: "auto" } })).toThrow(/holds secrets .*before merge/);
});
