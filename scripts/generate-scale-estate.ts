#!/usr/bin/env tsx
/**
 * chant #2403 — an estate at scale, chant's own side of chant-bench#33.
 *
 * choudoufu's side of that bench already exists: a terralith generator whose
 * formula is stated as "74N + 5" (one flag, one growing root module). chant
 * cannot copy that shape: its AWS lexicon serializes to real CloudFormation,
 * and CloudFormation caps a single stack at 500 resources. That is not a
 * workaround to route around quietly — it is the substrate #2403 says to
 * state plainly. So where choudoufu's estate is one stack that grows, this
 * generator's estate is MANY stacks, each a fixed, safe size, and scale
 * grows the stack COUNT.
 *
 * Formula
 * -------
 *
 *   perStack(teamsPerStack) = 2 * teamsPerStack + 6
 *   total(stacks, teamsPerStack) = stacks * perStack(teamsPerStack)
 *
 * Each stack holds `teamsPerStack` near-identical (Role, Policy) pairs — two
 * resources each, differing only by an index suffix, the same "near-identical
 * roles and policies differing by a name prefix" shape choudoufu's own
 * terralith-gen deliberately uses (issue #564) — plus 6 FIXED supporting
 * resources: one S3 Bucket, one S3 BucketPolicy (the lexicon's own lint,
 * WAW042, refuses a bucket with no TLS-only policy — a lint-clean bucket is
 * two resources), one SQS Queue, one SNS Topic, one DynamoDB Table, one
 * CloudWatch LogGroup. Every one of those six types is in the set the floci
 * emulator actually provisions (#2403's brief); none reaches CREATE_COMPLETE
 * on a synthetic id.
 *
 * With this file's default teamsPerStack (190), perStack = 386 — 77% of the
 * 500-resource cap, comfortably under it — so at the default:
 *
 *   total(N) = 386N        (N = --stacks; every stack fixed at 386 resources)
 *
 * `--teams-per-stack` moves the per-stack constant (for a smaller, faster
 * proof run); `--resources` picks the number of FULL stacks needed to reach
 * at least that many resources — no partial stack is ever emitted, so the
 * actual total (printed in the manifest) can round up past what was asked.
 *
 * Usage
 * -----
 *
 *   npx tsx scripts/generate-scale-estate.ts --out <dir> --stacks <n> [--teams-per-stack <k>]
 *   npx tsx scripts/generate-scale-estate.ts --out <dir> --resources <r> [--teams-per-stack <k>]
 *
 * Writes a chant project at <dir>: chant.config.ts (a `stacks[]` entry per
 * stack, an `ownership` block), and one `src/<stack>/` directory per stack
 * holding the declared resources plus a `*.component.ts` so `chant run
 * --components <stack>` can deploy it and `chant lifecycle plan` can
 * discover it. It does not install dependencies or build templates — see
 * test/scale-estate.sh for the harness that does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The formula's constants
// ---------------------------------------------------------------------------

/** One S3 Bucket (+ its BucketPolicy), one SQS Queue, one SNS Topic, one
 * DynamoDB Table, one CloudWatch LogGroup — fixed per stack, never scaling
 * with team count. The BucketPolicy is not decorative: WAW042 (this
 * lexicon's own lint) refuses a bucket with no policy denying non-TLS
 * requests, so a realistic, LINT-CLEAN bucket is two resources, not one. */
const SUPPORTING_PER_STACK = 6;

/** Chosen so perStack(190) = 386: comfortably under the 500-resource cap
 * (77% of it) while still being a real, non-trivial stack. */
const DEFAULT_TEAMS_PER_STACK = 190;

/** Real CloudFormation's own limit (#2403's "structural fact") — the floci
 * emulator does not enforce it, but a generated stack must respect it anyway
 * or the result is dishonest about what it would take against real AWS. */
const CFN_STACK_CAP = 500;

/** "Comfortably under" the cap, not brushing against it — headroom for the
 * lint/tag/metadata overhead every real deploy adds beyond declared resources. */
const SAFE_STACK_MAX = 450;

function perStack(teamsPerStack: number): number {
  return 2 * teamsPerStack + SUPPORTING_PER_STACK;
}

export const FORMULA_DESCRIPTION =
  "perStack(teamsPerStack) = 2*teamsPerStack + 6; total = stacks * perStack(teamsPerStack). " +
  `At the default teamsPerStack=${DEFAULT_TEAMS_PER_STACK}, perStack=${perStack(DEFAULT_TEAMS_PER_STACK)}, so total(N) = ${perStack(DEFAULT_TEAMS_PER_STACK)}N.`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  out: string;
  stacks?: number;
  resources?: number;
  teamsPerStack: number;
}

export function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let stacks: number | undefined;
  let resources: number | undefined;
  let teamsPerStack = DEFAULT_TEAMS_PER_STACK;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`generate-scale-estate: ${a} needs a value`);
      return v;
    };
    if (a === "--out") out = next();
    else if (a === "--stacks") stacks = Number(next());
    else if (a === "--resources") resources = Number(next());
    else if (a === "--teams-per-stack") teamsPerStack = Number(next());
    else throw new Error(`generate-scale-estate: unknown argument "${a}"`);
  }
  if (!out) throw new Error("generate-scale-estate: --out <dir> is required");
  if (stacks === undefined && resources === undefined) {
    throw new Error("generate-scale-estate: one of --stacks or --resources is required");
  }
  if (stacks !== undefined && resources !== undefined) {
    throw new Error("generate-scale-estate: --stacks and --resources are mutually exclusive");
  }
  if (!Number.isInteger(teamsPerStack) || teamsPerStack < 1) {
    throw new Error(`generate-scale-estate: --teams-per-stack must be a positive integer, got ${teamsPerStack}`);
  }
  return { out, stacks, resources, teamsPerStack };
}

// ---------------------------------------------------------------------------
// Plan: how many stacks, how big is each
// ---------------------------------------------------------------------------

export interface EstatePlan {
  stackCount: number;
  teamsPerStack: number;
  perStackResources: number;
  totalResources: number;
  stackNames: string[];
}

export function planEstate(args: Args): EstatePlan {
  const perStackResources = perStack(args.teamsPerStack);
  if (perStackResources > SAFE_STACK_MAX) {
    throw new Error(
      `generate-scale-estate: --teams-per-stack ${args.teamsPerStack} makes each stack ${perStackResources} resources, ` +
        `over the safe max of ${SAFE_STACK_MAX} (real CloudFormation's own cap is ${CFN_STACK_CAP}) — lower --teams-per-stack.`,
    );
  }
  const stackCount = args.stacks ?? Math.ceil(args.resources! / perStackResources);
  if (stackCount < 1) throw new Error("generate-scale-estate: --stacks/--resources must produce at least one stack");
  const width = Math.max(3, String(stackCount - 1).length);
  const stackNames = Array.from({ length: stackCount }, (_, i) => `scale-stack-${String(i).padStart(width, "0")}`);
  return {
    stackCount,
    teamsPerStack: args.teamsPerStack,
    perStackResources,
    totalResources: stackCount * perStackResources,
    stackNames,
  };
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

/** A shared IAM trust policy every generated Role assumes — a Lambda
 * execution role is the most common real-world "team" shape a stack this
 * IAM-heavy would actually hold. */
const TRUST_POLICY_LITERAL = `{
  Version: "2012-10-17" as const,
  Statement: [{ Effect: "Allow" as const, Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
}`;

/**
 * One stack's `resources.ts`: `teamsPerStack` (Role, Policy) pairs plus the
 * 6 fixed supporting resources. Every export name carries this stack's own
 * name so it is globally unique across the whole estate — deliberately: see
 * the file-level doc comment above `--resources` for why a bare name
 * colliding across stack directories would matter for `chant lifecycle
 * plan`'s unscoped whole-project build.
 */
function renderStackResources(stackName: string, teamsPerStack: number): string {
  const p = stackName.replace(/-/g, "_"); // a valid TS identifier prefix
  const lines: string[] = [];
  lines.push(
    `/**\n * ${stackName}: ${teamsPerStack} near-identical (Role, Policy) pairs (${2 * teamsPerStack} resources)\n * plus 6 fixed supporting resources — ${perStack(teamsPerStack)} resources total. Generated by\n * scripts/generate-scale-estate.ts (chant#2403); do not hand-edit.\n *\n * Export names carry this stack's own name on purpose, so they stay unique\n * across the WHOLE estate, not just within this directory — see that\n * script's doc comment for why a cross-stack collision here would matter.\n */`,
  );
  lines.push(
    `import { Role, Policy, Bucket, S3BucketPolicy, Queue, Topic, LogGroup, DynamoDBTable, Ref, Sub } from "@intentius/chant-lexicon-aws";`,
  );
  lines.push("");
  lines.push(`const trustPolicy = ${TRUST_POLICY_LITERAL};`);
  lines.push("");
  for (let i = 0; i < teamsPerStack; i++) {
    const idx = String(i).padStart(3, "0");
    const roleVar = `${p}_team${idx}Role`;
    const policyVar = `${p}_team${idx}Policy`;
    lines.push(`export const ${roleVar} = new Role({ AssumeRolePolicyDocument: trustPolicy });`);
    lines.push(`export const ${policyVar} = new Policy({`);
    lines.push(`  PolicyName: "${stackName}-team${idx}-policy",`);
    lines.push(`  PolicyDocument: {`);
    lines.push(`    Version: "2012-10-17",`);
    lines.push(`    Statement: [{ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }],`);
    lines.push(`  },`);
    lines.push(`  Roles: [Ref(${roleVar})],`);
    lines.push(`});`);
  }
  lines.push("");
  lines.push(`// 6 fixed supporting resources — never scaling with teamsPerStack. Public`);
  lines.push(`// access blocked and a TLS-only bucket policy (WAW018/WAW042) rather than`);
  lines.push(`// a bare bucket: a lint-clean estate is the honest one to measure.`);
  lines.push(`export const ${p}_bucket = new Bucket({`);
  lines.push(`  PublicAccessBlockConfiguration: {`);
  lines.push(`    BlockPublicAcls: true,`);
  lines.push(`    BlockPublicPolicy: true,`);
  lines.push(`    IgnorePublicAcls: true,`);
  lines.push(`    RestrictPublicBuckets: true,`);
  lines.push(`  },`);
  lines.push(`});`);
  lines.push(`export const ${p}_bucketPolicy = new S3BucketPolicy({`);
  lines.push(`  Bucket: Ref(${p}_bucket),`);
  lines.push(`  PolicyDocument: {`);
  lines.push(`    Version: "2012-10-17",`);
  lines.push(`    Statement: [{`);
  lines.push(`      Effect: "Deny",`);
  lines.push(`      Principal: "*",`);
  lines.push(`      Action: "s3:*",`);
  lines.push(`      Resource: [${p}_bucket.Arn, Sub\`\${${p}_bucket.Arn}/*\`],`);
  lines.push(`      Condition: { Bool: { "aws:SecureTransport": "false" } },`);
  lines.push(`    }],`);
  lines.push(`  },`);
  lines.push(`});`);
  lines.push(`export const ${p}_queue = new Queue({ SqsManagedSseEnabled: true });`);
  lines.push(`export const ${p}_topic = new Topic({ KmsMasterKeyId: "alias/aws/sns" });`);
  lines.push(
    `export const ${p}_table = DynamoDBTable({ partitionKey: { name: "id" }, defaults: { table: { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } } } });`,
  );
  lines.push(`export const ${p}_logGroup = new LogGroup({ RetentionInDays: 14 });`);
  lines.push("");
  return lines.join("\n");
}

/** One stack's `*.component.ts`: the deploy unit `chant run --components
 * <stackName>` targets, and what `chant lifecycle plan` discovers to know
 * which CloudFormation stacks make up the estate. */
function renderStackComponent(stackName: string): string {
  const p = stackName.replace(/-/g, "_");
  return `/**
 * ${stackName}'s deploy unit (chant#2403). \`template\` is this stack's own
 * scoped build output, built independently of every other stack's — see
 * test/scale-estate.sh.
 */
import { phase, type Component } from "@intentius/chant/components/component";
import { cfnDeploy } from "@intentius/chant-lexicon-aws/components";

export const ${p}: Component = {
  name: "${stackName}",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [cfnDeploy({ stack: "${stackName}", template: "src/${stackName}/template.json" })])],
};
`;
}

function renderChantConfig(plan: EstatePlan, endpoint: string): string {
  const stacksEntries = plan.stackNames
    .map((name) => `    { name: "${name}", src: "src/${name}" },`)
    .join("\n");
  return `/**
 * chant#2403's scale estate — generated by scripts/generate-scale-estate.ts.
 * Do not hand-edit; regenerate instead.
 *
 * ${plan.stackCount} independently-deployed CloudFormation stacks, each
 * ${plan.perStackResources} resources (comfortably under the real
 * 500-resource cap), ${plan.totalResources} resources total.
 */
import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["aws"],
  environments: [{ name: "local", endpoint: "${endpoint}" }],
  // Multi-stack project (#932): one entry per independently-deployed stack.
  // Lifecycle commands (snapshot/diff) iterate this; \`chant lifecycle plan\`
  // instead discovers every stack's own *.component.ts (see
  // packages/core/src/cli/handlers/lifecycle.ts's componentStacks) — both
  // routes are exercised by test/scale-estate.sh.
  stacks: [
${stacksEntries}
  ],
  // The PROJECT's own identity, not any one CFN stack's name (#2403's
  // ownership model marks resources at the stack level via chant:managed-by
  // / chant:stack / chant:env tags — see lexicons/aws/src/ownership.ts).
  ownership: { stack: "chant-scale-estate", env: "local" },
} satisfies ChantConfig;
`;
}

function renderPackageJson(): string {
  return (
    JSON.stringify(
      {
        name: "chant-scale-estate",
        version: "1.0.0",
        private: true,
        type: "module",
        description:
          "chant#2403's estate at scale: many independently-deployed CloudFormation stacks, generated by scripts/generate-scale-estate.ts. Do not hand-edit.",
        devDependencies: {
          "@intentius/chant": "*",
          "@intentius/chant-lexicon-aws": "*",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Write the project
// ---------------------------------------------------------------------------

export function generateEstate(args: Args): EstatePlan {
  const plan = planEstate(args);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "package.json"), renderPackageJson());
  writeFileSync(join(args.out, "chant.config.ts"), renderChantConfig(plan, "http://localhost:4691"));
  for (const stackName of plan.stackNames) {
    const dir = join(args.out, "src", stackName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "resources.ts"), renderStackResources(stackName, plan.teamsPerStack));
    writeFileSync(join(dir, "stack.component.ts"), renderStackComponent(stackName));
  }
  writeFileSync(
    join(args.out, "estate-manifest.json"),
    JSON.stringify(
      {
        schema: 1,
        formula: FORMULA_DESCRIPTION,
        stacks: plan.stackCount,
        teamsPerStack: plan.teamsPerStack,
        perStackResources: plan.perStackResources,
        totalResources: plan.totalResources,
        stackNames: plan.stackNames,
      },
      null,
      2,
    ) + "\n",
  );
  return plan;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = generateEstate(args);
    console.log(`generate-scale-estate: wrote ${args.out}`);
    console.log(`  formula: ${FORMULA_DESCRIPTION}`);
    console.log(`  stacks=${plan.stackCount} teamsPerStack=${plan.teamsPerStack} perStack=${plan.perStackResources} total=${plan.totalResources}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
