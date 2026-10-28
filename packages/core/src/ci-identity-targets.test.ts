/**
 * #4332: per-target cloud identities. A rule with `targets` covers only the
 * targets inside a member those globs match. The plan trade holds every
 * plan identity a member's targets take, the trade leaves each identity's
 * credentials in the CHANT_CLOUD_TARGETS file, targetCloudEnv hands a
 * target its own, and cloudIdentityGroups splits an apply into one job per
 * apply identity. The trade tests run the generated `node -e` line against
 * the local emulator (./__fixtures__/oidc-emulator.ts). Test values only.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
// @ts-ignore: picomatch has no types declaration
import picomatch from "picomatch";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CLOUD_TARGETS_ENV,
  cloudIdentityGroups,
  cloudIdentityProblems,
  cloudIdentityWave,
  nameGlobMatch,
  oneApplyIdentityProblem,
  readTargetsFile,
  resolveCloudIdentity,
  resolveTargetCloudIdentity,
  targetCloudEnv,
  targetGlobMatch,
  TRADE_SPEC_ENV,
  tradeIdentities,
  tradeLine,
  type CloudIdentityDeclaration,
  type CloudTradeSpec,
} from "./ci-identity";
import { assertOpWavesSpec, type OpWavesSpec } from "./op/op-waves";
import { emulatedCredentials, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "./__fixtures__/oidc-emulator";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const run = promisify(execFile);

const role = (n: string) => `arn:aws:iam::111111111111:role/${n}`;

/** terragucci's shape: prod and staging roots plan and apply as their environment's roles, the rest as the member's own. */
const DECL: CloudIdentityDeclaration = {
  aws: {
    region: "eu-west-1",
    rules: [
      { environments: ["prod"], members: ["infra"], targets: ["envs/prod/**"], plan: role("prod-plan"), apply: role("prod-apply") },
      { environments: ["prod"], members: ["infra"], targets: ["envs/staging/**"], name: "staging", plan: role("staging-plan"), apply: role("staging-apply") },
      { environments: ["prod"], plan: role("own-plan"), apply: role("own-apply") },
      { targets: ["unreachable/**"], plan: role("late-plan"), apply: role("late-apply") },
    ],
  },
  gcp: {
    provider: "projects/123/locations/global/workloadIdentityPools/ci/providers/forge",
    rules: [{ targets: ["envs/prod/**"], plan: "prod-plan@p.iam.gserviceaccount.com", apply: "prod-apply@p.iam.gserviceaccount.com" }],
  },
};

const ROOTS = ["envs/prod/net", "envs/staging/net", "shared/dns", "envs/prod/app"];

describe("a target with several names takes the first rule any name matches (#4332)", () => {
  // A Terraform root's key in `terraform.roots`, then its directory relative to the project.
  const decl: CloudIdentityDeclaration = {
    aws: {
      rules: [
        { targets: ["envs/prod/**"], plan: role("dir-plan"), apply: role("dir-apply") },
        { targets: ["network"], plan: role("key-plan"), apply: role("key-apply") },
        { plan: role("own-plan"), apply: role("own-apply") },
      ],
    },
  };
  const apply = (...names: string[]) => resolveTargetCloudIdentity(decl, "prod", undefined, names)!.apply.aws!.role;

  test("the key matches", () => expect(apply("network", "infra/net")).toBe(role("key-apply")));
  test("the directory matches", () => expect(apply("prod-net", "envs/prod/net")).toBe(role("dir-apply")));
  test("both match different rules: the first declared rule wins", () => {
    expect(apply("network", "envs/prod/net")).toBe(role("dir-apply"));
    expect(apply("envs/prod/net", "network")).toBe(role("dir-apply"));
  });
  test("neither matches: the member's own rule", () => expect(apply("dns", "shared/dns")).toBe(role("own-apply")));
  test("a single name resolves as before", () => expect(resolveTargetCloudIdentity(decl, "prod", undefined, "network")).toEqual(resolveTargetCloudIdentity(decl, "prod", undefined, ["network"])));
});

describe("which identity a target takes (#4332)", () => {
  test("the first rule that covers the environment, the member and the target wins, per cloud", () => {
    const prod = resolveTargetCloudIdentity(DECL, "prod", "infra", "envs/prod/net")!;
    expect(prod.plan.aws).toEqual({ role: role("prod-plan"), region: "eu-west-1", audience: "sts.amazonaws.com" });
    expect(prod.apply.gcp!.serviceAccount).toBe("prod-apply@p.iam.gserviceaccount.com");
    const staging = resolveTargetCloudIdentity(DECL, "prod", "infra", "envs/staging/net")!;
    expect(staging.apply.aws!.role).toBe(role("staging-apply"));
    expect(staging.apply.gcp).toBeUndefined();
    expect(resolveTargetCloudIdentity(DECL, "prod", "infra", "shared/dns")!.plan.aws!.role).toBe(role("own-plan"));
  });

  test("a rule with targets covers no target of another member, and a rule after one without targets is never reached", () => {
    expect(resolveTargetCloudIdentity(DECL, "prod", "web", "envs/prod/net")!.plan.aws!.role).toBe(role("own-plan"));
    expect(resolveTargetCloudIdentity(DECL, "prod", "infra", "unreachable/x")!.plan.aws!.role).toBe(role("own-plan"));
    expect(resolveTargetCloudIdentity(DECL, "dev", "infra", "unreachable/x")!.plan.aws!.role).toBe(role("late-plan"));
    expect(resolveTargetCloudIdentity({ aws: DECL.aws }, "dev", "infra", "shared/dns")).toBeUndefined();
  });

  test("the pipeline's trade names its own identity and, before it, the targets that take another", () => {
    const p = resolveCloudIdentity(DECL, "prod", "infra")!;
    expect(p.plan.aws).toEqual({
      role: role("own-plan"),
      targets: [
        { targets: ["envs/prod/**"], role: role("prod-plan") },
        { targets: ["envs/staging/**"], role: role("staging-plan") },
      ],
      region: "eu-west-1",
      audience: "sts.amazonaws.com",
    });
    // GCP has no rule for the member as a whole: targets alone.
    expect(p.plan.gcp).toMatchObject({ targets: [{ targets: ["envs/prod/**"], serviceAccount: "prod-plan@p.iam.gserviceaccount.com" }] });
    expect(p.plan.gcp!.serviceAccount).toBeUndefined();
    expect(tradeIdentities(p.plan)).toEqual([role("own-plan"), role("prod-plan"), role("staging-plan"), "prod-plan@p.iam.gserviceaccount.com"]);
    // The plan trade names no apply identity.
    for (const id of tradeIdentities(p.apply)) expect(JSON.stringify(p.plan)).not.toContain(id);
    // Without targets rules, as #4296 resolved it.
    expect(resolveCloudIdentity(DECL, "prod", "web")!.plan.aws).toEqual({ role: role("own-plan"), region: "eu-west-1", audience: "sts.amazonaws.com" });
  });

  test("a plan identity that any rule applies as is still refused, targets or not", () => {
    expect(cloudIdentityProblems(DECL)).toEqual([]);
    const crossed = cloudIdentityProblems({ aws: { rules: [{ targets: ["a/**"], plan: "x", apply: "y" }, { plan: "y", apply: "z" }] } });
    expect(crossed).toEqual([{ pointer: "/ci/identity/cloud/aws/rules/1", message: expect.stringContaining("plans as y, which another rule applies as") }]);
  });
});

describe("one apply job per identity (#4332)", () => {
  test("targets that take the same identities in every cloud are one group, named from the rule, default last", () => {
    const groups = cloudIdentityGroups(DECL, "prod", "infra", ROOTS);
    expect(groups.map((g) => [g.name, g.targets])).toEqual([
      ["envs-prod", ["envs/prod/net", "envs/prod/app"]],
      ["staging", ["envs/staging/net"]],
      ["default", ["shared/dns"]],
    ]);
    expect(tradeIdentities(groups[0]!.identity!.apply)).toEqual([role("prod-apply"), "prod-apply@p.iam.gserviceaccount.com"]);
    expect(tradeIdentities(groups[2]!.identity!.apply)).toEqual([role("own-apply")]);
  });

  test("two rules whose names collide get -2, and targets no rule covers form a group with no identity", () => {
    const decl: CloudIdentityDeclaration = { aws: { rules: [{ targets: ["a/*"], name: "x", plan: "p1", apply: "a1" }, { targets: ["b/*"], name: "x", plan: "p2", apply: "a2" }] } };
    expect(cloudIdentityGroups(decl, "prod", undefined, ["a/1", "b/1", "c/1"])).toEqual([
      expect.objectContaining({ name: "x", targets: ["a/1"] }),
      expect.objectContaining({ name: "x-2", targets: ["b/1"] }),
      { name: "default", targets: ["c/1"] },
    ]);
  });

  test("an Op wave's deciding job trades every plan identity and each group's job its apply identities alone", () => {
    const wave = cloudIdentityWave(DECL, "prod", "infra", ROOTS);
    expect(wave.cloud).toEqual(resolveCloudIdentity(DECL, "prod", "infra")!.plan);
    expect(wave.jobs!.map((j) => [j.name, j.runs, tradeIdentities(j.cloud!)])).toEqual([
      ["envs-prod", ["envs/prod/net", "envs/prod/app"], [role("prod-apply"), "prod-apply@p.iam.gserviceaccount.com"]],
      ["staging", ["envs/staging/net"], [role("staging-apply")]],
      ["default", ["shared/dns"], [role("own-apply")]],
    ]);
    const spec: OpWavesSpec = { name: "tf-apply", op: "tf-apply", plan: ["plan", "{target}", "{plan}"], apply: ["apply", "{target}"], waves: [{ name: "wave-1", runs: ROOTS.map((target) => ({ target })), ...wave }] } as OpWavesSpec;
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
  });

  test("with one group the wave's one job trades its apply identities and has no jobs", () => {
    expect(cloudIdentityWave(DECL, "prod", "infra", ["envs/prod/net"])).toEqual({ cloud: resolveTargetCloudIdentity(DECL, "prod", "infra", "envs/prod/net")!.apply });
    expect(cloudIdentityWave(undefined, "prod", "infra", ["x"])).toEqual({});
  });

  test("an Op wave's cloud that names no identity is refused", () => {
    const spec = { name: "w", op: "w", plan: ["p", "{plan}"], apply: ["a"], waves: [{ name: "one", runs: [{ target: "t" }], cloud: { aws: { region: "eu-west-1", audience: "sts.amazonaws.com" } } }] } as unknown as OpWavesSpec;
    expect(() => assertOpWavesSpec(spec)).toThrow(/cloud\.aws must give an audience and a role/);
    expect(() => assertOpWavesSpec({ ...spec, waves: [{ ...spec.waves[0]!, cloud: { k8s: {} } as never }] })).toThrow(/k8s is not a cloud/);
  });

  test("one job may hold one apply identity per cloud", () => {
    expect(oneApplyIdentityProblem(resolveCloudIdentity(DECL, "prod", "web")!.apply)).toBeUndefined();
    expect(oneApplyIdentityProblem(resolveCloudIdentity(DECL, "prod", "infra")!.apply)).toMatch(/3 aws apply identities/);
  });
});

describe("the glob grammars (#4332)", () => {
  test("member and environment globs read as picomatch reads the ciMemberGlobs grammar", () => {
    const names = ["api", "web", "prod", "prod-eu", "staging-eu", "staging", "a1", "b2", "app-x"];
    const globs = ["api", "prod-*", "staging-*", "*", "a?", "[ab][0-9]", "{api,web}", "app-{x,y}", "!prod*", "{a,b}{1,2}", "*-eu"];
    for (const g of globs) for (const n of names) expect([g, n, nameGlobMatch(g, n)]).toEqual([g, n, (picomatch(g) as (s: string) => boolean)(n)]);
    expect(nameGlobMatch("[!a]*", "web")).toBe(true);
    expect(nameGlobMatch("[!a]*", "api")).toBe(false);
  });

  test("target globs read as the terraform lexicon's unit globs", () => {
    expect(targetGlobMatch("envs/prod/**", "envs/prod/net")).toBe(true);
    expect(targetGlobMatch("envs/prod/**", "envs/prod")).toBe(false);
    expect(targetGlobMatch("envs/*/net", "envs/prod/net")).toBe(true);
    expect(targetGlobMatch("envs/*", "envs/prod/net")).toBe(false);
    expect(targetGlobMatch("a/**/b", "a/b")).toBe(true);
    expect(targetGlobMatch("a/?", "a/b")).toBe(true);
    expect(targetGlobMatch("envs/{a,b}", "envs/a")).toBe(false);
  });
});

const dirs: string[] = [];
let emu: OidcEmulator;
beforeAll(async () => {
  emu = await startOidcEmulator();
});
afterAll(async () => {
  await emu.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BASE = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

/** Run the trade line as a GitHub step does, with RUNNER_TEMP its own directory. */
async function trade(spec: CloudTradeSpec): Promise<{ out: string; stderr: string; stdout: string; temp: string }> {
  const temp = mkdtempSync(join(tmpdir(), "chant-trade-targets-"));
  dirs.push(temp);
  const file = join(temp, "github-env");
  writeFileSync(file, "");
  const r = await run("sh", ["-c", tradeLine(file, "github-env")], { env: { ...BASE, ...emu.requestEnv, RUNNER_TEMP: temp, [TRADE_SPEC_ENV]: JSON.stringify(emu.pointAt(spec)) } });
  return { out: readFileSync(file, "utf-8"), stderr: r.stderr, stdout: r.stdout, temp };
}

const envOf = (lines: string): Record<string, string> => Object.fromEntries(lines.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("the plan trade with targets, run against the emulator (#4332)", () => {
  test("it trades one token per cloud for every plan identity, keeps the job's own in GITHUB_ENV and each in the targets file", async () => {
    const before = { minted: emu.log.minted.length, assumed: emu.log.assumed.length, impersonated: emu.log.impersonated.length };
    const plan = resolveCloudIdentity(DECL, "prod", "infra")!.plan;
    const r = await trade(plan);
    expect(r.stderr).not.toContain("failed");
    // One minted token per cloud, however many identities it is traded for.
    expect(emu.log.minted.slice(before.minted)).toEqual(["sts.amazonaws.com", "https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/forge"]);
    expect(emu.log.assumed.slice(before.assumed).map((a) => a.role)).toEqual([role("own-plan"), role("prod-plan"), role("staging-plan")]);
    expect(emu.log.impersonated.slice(before.impersonated)).toEqual(["prod-plan@p.iam.gserviceaccount.com"]);
    const env = envOf(r.out);
    expect(env.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(role("own-plan")).accessKeyId);
    // GCP names no identity of the job's own, so the job's environment has none.
    expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    const path = env[CLOUD_TARGETS_ENV]!;
    expect(path.startsWith(r.temp)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = readTargetsFile(path);
    expect(file.clouds.aws!.default).toBe(role("own-plan"));
    expect(Object.keys(file.clouds.aws!.vars)).toEqual([role("own-plan"), role("prod-plan"), role("staging-plan")]);
    // Every secret is masked, and the minted token is written nowhere.
    expect(r.stdout).toContain(`::add-mask::${emulatedCredentials(role("staging-plan")).token}`);
    expect(r.out + readFileSync(path, "utf-8") + r.stdout + r.stderr).not.toContain(EMULATED_JWT_PREFIX);
    // No apply identity was asked for.
    for (const id of tradeIdentities(resolveCloudIdentity(DECL, "prod", "infra")!.apply)) expect(emu.log.assumed.map((a) => a.role)).not.toContain(id);

    // targetCloudEnv hands each target its own identity, as terragucci's rootRoleEnv did.
    const job = { ...env, PATH: "/bin", AWS_ROLE_ARN: undefined };
    const prod = targetCloudEnv(job, "envs/prod/net");
    expect(prod.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(role("prod-plan")).accessKeyId);
    expect(prod.AWS_SESSION_TOKEN).toBe(emulatedCredentials(role("prod-plan")).token);
    expect(prod.AWS_REGION).toBe("eu-west-1");
    expect(prod.GOOGLE_OAUTH_ACCESS_TOKEN).toBe(`ya29.${emulatedCredentials("prod-plan@p.iam.gserviceaccount.com").token}`);
    expect(prod.PATH).toBe("/bin");
    expect(targetCloudEnv(job, "envs/staging/net").AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(role("staging-plan")).accessKeyId);
    const shared = targetCloudEnv(job, "shared/dns");
    expect(shared.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(role("own-plan")).accessKeyId);
    expect(shared.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
  });

  test("an apply group's trade names one identity per cloud and leaves no targets file", async () => {
    const before = emu.log.assumed.length;
    const group = cloudIdentityGroups(DECL, "prod", "infra", ROOTS)[1]!;
    const r = await trade(group.identity!.apply);
    expect(emu.log.assumed.slice(before).map((a) => a.role)).toEqual([role("staging-apply")]);
    expect(envOf(r.out)[CLOUD_TARGETS_ENV]).toBeUndefined();
    expect(targetCloudEnv(envOf(r.out), "envs/staging/net")).toEqual(envOf(r.out));
  });

  test("a targets file that is not one is refused by name", () => {
    expect(() => targetCloudEnv({ [CLOUD_TARGETS_ENV]: "/nowhere.json" }, "x", () => "{}")).toThrow(/not a version 1 targets file/);
    expect(() => targetCloudEnv({ [CLOUD_TARGETS_ENV]: "/nowhere.json" }, "x", () => "nope")).toThrow(/cannot be read/);
  });
});

describe("the ci-identity bundle (#4332)", () => {
  test("holds ci-identity.ts and the floor constant alone, with no glob library, and stays small", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "ci-identity.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/"))).toEqual([
      // The next-release floor constant (#4480, the #4549 token floors): no imports.
      "packages/core/src/release-floors.ts",
      "packages/core/src/ci-identity.ts",
    ]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(24 * 1024);
  });
});
