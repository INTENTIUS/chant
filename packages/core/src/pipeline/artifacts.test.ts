/**
 * Release artifacts (#5356): the declaration and its build refusals, the
 * publish (a sensitive output refused, a secret kept as its reference), the
 * reads of one release, two members in one repository, a read from another
 * repository, the release cut from a commit, and the dispatch's release.
 * Every git test runs in temporary repositories.
 */

import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitStageArtifactPort,
  publishStageArtifacts,
  readStageArtifacts,
  releaseCutFrom,
  resolveStageReads,
  stageArtifactsNote,
  stageArtifactText,
  withStageReadVariables,
  STAGE_ARTIFACT_MAX_BYTES,
  STAGE_ARTIFACTS_FILE,
  STAGE_ARTIFACTS_FLOOR,
  type MemberOutputs,
  type StageArtifactPort,
  type StageArtifactRecord,
} from "./artifacts";
import { asPipelineSpec, pipelineSpecProblems, type PipelineDeclaration, type PipelineSpec } from "./spec";
import { artifactsPublishHook, stageWavesSpec } from "./stages";
import { foldPipelineSource } from "./fold";
import { pipelineFromConfig } from "./product";
import { controlDispatchRequest, controlDispatchScript, resolveControlTarget } from "../control/dispatch";
import { readBlobFromPath } from "../lifecycle/git";
import { appendCut, makeRelease, persistRelease } from "../lifecycle/release-store";

const SECRET_VALUE = "hunter2-do-not-leak";
const R1 = `jcs1-sha256:${"1".repeat(64)}`;
const R2 = `jcs1-sha256:${"2".repeat(64)}`;

const wave = (name: string) => ({ name, runs: [{ target: name }] });

function declaration(over: Partial<Record<string, Partial<PipelineDeclaration["stages"][number]>>> = {}): PipelineDeclaration {
  return {
    name: "shop",
    defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } } as PipelineDeclaration["defaults"],
    stages: [
      { name: "dev", waves: [wave("dev")], ...over.dev },
      { name: "staging", waves: [wave("staging")], ...over.staging },
      { name: "prod", waves: [wave("prod")], ...over.prod },
    ],
  };
}

const publishing = {
  dev: {
    publish: {
      endpoint: { member: "cluster", output: "endpoint" },
      sizes: { member: "cluster", output: "sizes" },
      db_host: { member: "db", output: "host" },
      db_password: { secret: { awsSecretsManager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:dev/db" } },
    },
  },
  staging: { reads: { TF_VAR_dev_endpoint: { stage: "dev", artifact: "endpoint" }, DB_PASSWORD_REF: { stage: "dev", artifact: "db_password" } } },
};

function memory(): StageArtifactPort & { lines: StageArtifactRecord[] } {
  const lines: StageArtifactRecord[] = [];
  return { lines, read: async (stage) => lines.filter((l) => l.stage === stage), append: async (_s, r) => void lines.push(structuredClone(r)) };
}

/** Two members' outputs in dev; the database password is a Pulumi secret. */
const outputs: Record<string, MemberOutputs> = {
  cluster: { outputs: { endpoint: "https://dev.k8s.example", sizes: { min: 1, max: 3 } }, sensitive: [] },
  db: { outputs: { host: "db.dev.internal", password: SECRET_VALUE }, sensitive: ["password"] },
};
const outputsOf = async (m: string) => outputs[m];

describe("the declaration (#5356)", () => {
  test("the floor is a version or the next release", () => {
    expect(STAGE_ARTIFACTS_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("publish and reads check, and a stage without them derives the same op-waves spec", () => {
    const spec = asPipelineSpec(declaration(publishing));
    expect(spec.stages[0]!.publish!.endpoint).toEqual({ member: "cluster", output: "endpoint" });
    const plain = asPipelineSpec(declaration());
    expect(JSON.stringify(stageWavesSpec(plain, "staging"))).toBe(JSON.stringify(stageWavesSpec(spec, "staging")));
  });

  test("a read no earlier stage publishes is refused at build", () => {
    const problems = pipelineSpecProblems(
      declaration({
        dev: { publish: { endpoint: { member: "cluster", output: "endpoint" } } },
        staging: { reads: { A: { stage: "dev", artifact: "missing" }, B: { stage: "prod", artifact: "x" }, C: { stage: "qa", artifact: "x" } } },
        prod: { publish: { x: { member: "m", output: "o" } } },
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'stage "staging" reads A from artifact "missing" of stage "dev", which that stage never publishes',
        'stage "staging" reads B from stage "prod", which comes after it in promotion order; a stage reads the stages before it',
        'stage "staging" reads C from stage "qa", which the pipeline does not have',
      ]),
    );
    const folded = foldPipelineSource(
      `import { pipeline } from "@intentius/chant/pipeline";\nexport default pipeline({ name: "shop", stages: [{ name: "dev", waves: [{ name: "dev" }] }, { name: "prod", waves: [{ name: "prod" }], reads: { X: { stage: "dev", artifact: "endpoint" } } }] });\n`,
    );
    expect("finding" in folded).toBe(true);
  });

  test("with after, a read must come from an ancestor: a sibling is refused, a join reads both branches (#5385)", () => {
    const stage = (name: string, extra: Record<string, unknown> = {}) => ({ name, waves: [{ name }], ...extra });
    const publish = { publish: { v: { member: "m", output: "o" } } };
    const fan = (join: Record<string, unknown>) => ({
      name: "shop",
      stages: [stage("dev", publish), stage("us", { after: ["dev"], ...publish }), stage("eu", { after: ["dev"], ...publish }), stage("all", join)],
    });
    const sibling = pipelineSpecProblems({ name: "shop", stages: [stage("dev", publish), stage("us", { after: ["dev"], ...publish }), stage("eu", { after: ["dev"], reads: { X: { stage: "us", artifact: "v" } } })] });
    expect(sibling).toHaveLength(1);
    expect(sibling[0]).toContain('stage "eu" reads X from stage "us"');
    expect(sibling[0]).toContain('"eu" does not follow through after');
    // An ancestor further up is read through after, and a join reads both branches.
    const ok = pipelineSpecProblems(
      fan({ after: ["us", "eu"], reads: { A: { stage: "us", artifact: "v" }, B: { stage: "eu", artifact: "v" }, C: { stage: "dev", artifact: "v" } } }),
    );
    expect(ok).toEqual([]);
    // A branch reading the other branch's upstream is fine; a join branch reading a later stage is not.
    const later = pipelineSpecProblems({
      name: "shop",
      stages: [stage("dev", publish), stage("us", { after: ["dev"], reads: { X: { stage: "all", artifact: "v" } } }), stage("all", { after: ["us"], ...publish })],
    });
    expect(later.join("\n")).toContain('stage "us" reads X from stage "all", which "us" does not follow through after');
  });

  test("without after, the list order still decides (#5385)", () => {
    const stage = (name: string, extra: Record<string, unknown> = {}) => ({ name, waves: [{ name }], ...extra });
    const publish = { publish: { v: { member: "m", output: "o" } } };
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev", publish), stage("qa", publish), stage("prod", { reads: { A: { stage: "dev", artifact: "v" }, B: { stage: "qa", artifact: "v" } } })] })).toEqual([]);
    const text = pipelineSpecProblems({ name: "shop", stages: [stage("dev", publish), stage("qa", { reads: { A: { stage: "prod", artifact: "v" } } }), stage("prod", publish)] }).join("\n");
    expect(text).toContain("which comes after it in promotion order");
  });

  test("bad shapes, reserved variables, a secret no store holds, and a publish with no release cut are refused", () => {
    const problems = pipelineSpecProblems({
      ...declaration({
        dev: { publish: { "1bad": { member: "m", output: "o" }, both: { member: "m", output: "o", secret: "X" } as never, nowhere: { secret: { vault: "x" } } as never } },
        staging: { reads: { CHANT_X: { stage: "dev", artifact: "both" }, "not a var": { stage: "dev" } as never } },
      }),
      release: { cut: false },
    });
    const text = problems.join("\n");
    expect(text).toContain('publish names "1bad"');
    expect(text).toContain("publish.both must be");
    expect(text).toContain("publish.nowhere.secret names one of");
    expect(text).toContain("reads names CHANT_X");
    expect(text).toContain('reads names "not a var"');
    expect(text).toContain('stage "dev" publishes artifacts, which are kept for the release the merge cuts, and release.cut is false');
  });

  test("the first stage publishes after the release cut; nothing is added without publish", () => {
    const spec = asPipelineSpec(declaration(publishing));
    const after = stageWavesSpec(spec, "dev").waves.at(-1)!.hooks!.after!.apply!;
    expect(after.map((h) => h.name)).toEqual(["release-cut", "artifacts-publish"]);
    expect(after[1]!.command).toEqual(["chant", "pipeline", "artifacts", "publish", "--stage", "dev"]);
    expect(artifactsPublishHook(asPipelineSpec(declaration()), "dev")).toBeUndefined();
    expect(stageWavesSpec(asPipelineSpec(declaration()), "dev").waves.at(-1)!.hooks!.after!.apply!.map((h) => h.name)).toEqual(["release-cut"]);
  });

  test("a product's environments.<name>.publish and reads map onto the stage, a secret's snake_case keys renamed", () => {
    const d = pipelineFromConfig({
      name: "shop",
      promotion: ["dev", "staging"],
      waves: { dev: [wave("dev")], staging: [wave("staging")] },
      environments: {
        dev: { publish: { endpoint: { member: "cluster", output: "endpoint" }, pw: { secret: { aws_secrets_manager: "arn:x", json_key: "pw" } } } },
        staging: { reads: { EP: { stage: "dev", artifact: "endpoint" } } },
      },
    });
    expect(d.stages[0]!.publish).toEqual({ endpoint: { member: "cluster", output: "endpoint" }, pw: { secret: { awsSecretsManager: "arn:x", jsonKey: "pw" } } });
    expect(d.stages[1]!.reads).toEqual({ EP: { stage: "dev", artifact: "endpoint" } });
  });
});

describe("publish and read (#5356)", () => {
  const spec = asPipelineSpec(declaration(publishing));

  test("two members' outputs and a secret's reference are recorded with the release and the stage", async () => {
    const port = memory();
    const got = await publishStageArtifacts({ spec, stage: "dev", release: { digest: R1, label: "v1.0.0", gitSha: "a".repeat(40) }, outputsOf, port, now: () => "2026-11-20T00:00:00Z" });
    expect(got.status).toBe("published");
    expect(port.lines).toHaveLength(1);
    expect(port.lines[0]).toMatchObject({ kind: "stage-artifacts", pipeline: "shop", stage: "dev", release: R1, label: "v1.0.0" });
    expect(port.lines[0]!.artifacts).toEqual({
      endpoint: { kind: "value", value: "https://dev.k8s.example", member: "cluster", output: "endpoint" },
      sizes: { kind: "value", value: { min: 1, max: 3 }, member: "cluster", output: "sizes" },
      db_host: { kind: "value", value: "db.dev.internal", member: "db", output: "host" },
      db_password: { kind: "secret", source: { store: "aws-secrets-manager", id: "arn:aws:secretsmanager:us-east-2:111111111111:secret:dev/db" } },
    });
  });

  test("a sensitive output is refused by name, and no value of it reaches the note, the log or the ledger", async () => {
    const leaky = asPipelineSpec(declaration({ dev: { publish: { endpoint: { member: "cluster", output: "endpoint" }, pw: { member: "db", output: "password" } } } }));
    const port = memory();
    const logged: string[] = [];
    const got = await publishStageArtifacts({ spec: leaky, stage: "dev", release: { digest: R1 }, outputsOf, port });
    expect(got.status).toBe("refused");
    if (got.status !== "refused") return;
    logged.push(...got.problems);
    expect(got.problems).toEqual([`pw: db's output password is marked sensitive, so it is not published; publish where it is kept with { "secret" } instead`]);
    expect(port.lines).toEqual([]);

    const ok = await publishStageArtifacts({ spec, stage: "dev", release: { digest: R1 }, outputsOf, port });
    if (ok.status !== "published") throw new Error("expected a publish");
    const note = stageArtifactsNote(ok.record);
    expect(note).toContain("a secret kept in AWS Secrets Manager");
    for (const text of [note, logged.join("\n"), JSON.stringify(port.lines)]) expect(text).not.toContain(SECRET_VALUE);
  });

  test("every artifact or none: a missing output, a member with no outputs and a value too big refuse the whole publish", async () => {
    const odd = asPipelineSpec(declaration({ dev: { publish: { a: { member: "cluster", output: "nope" }, b: { member: "ghost", output: "x" }, c: { member: "big", output: "blob" }, d: { member: "cluster", output: "endpoint" } } } }));
    const port = memory();
    const big: MemberOutputs = { outputs: { blob: "x".repeat(STAGE_ARTIFACT_MAX_BYTES + 1) }, sensitive: [] };
    const got = await publishStageArtifacts({ spec: odd, stage: "dev", release: { digest: R1 }, outputsOf: async (m) => (m === "big" ? big : outputs[m]), port });
    expect(got.status).toBe("refused");
    if (got.status === "refused") expect(got.problems.map((p) => p.split(":")[0])).toEqual(["a", "b", "c"]);
    expect(port.lines).toEqual([]);
  });

  test("a stage with no publish publishes nothing", async () => {
    const port = memory();
    expect(await publishStageArtifacts({ spec, stage: "staging", release: { digest: R1 }, outputsOf, port })).toEqual({ status: "none", stage: "staging" });
    expect(port.lines).toEqual([]);
  });

  test("a later stage reads the artifact of the same release, and is refused for a release its upstream never published", async () => {
    const port = memory();
    await publishStageArtifacts({ spec, stage: "dev", release: { digest: R1 }, outputsOf, port });
    const got = await resolveStageReads(spec, "staging", R1, port);
    expect(got).toEqual({
      status: "resolved",
      variables: { DB_PASSWORD_REF: JSON.stringify({ store: "aws-secrets-manager", id: "arn:aws:secretsmanager:us-east-2:111111111111:secret:dev/db" }), TF_VAR_dev_endpoint: "https://dev.k8s.example" },
      reads: [
        { variable: "DB_PASSWORD_REF", stage: "dev", artifact: "db_password", kind: "secret" },
        { variable: "TF_VAR_dev_endpoint", stage: "dev", artifact: "endpoint", kind: "value" },
      ],
    });
    const other = await resolveStageReads(spec, "staging", R2, port);
    expect(other.status).toBe("refused");
    if (other.status === "refused") expect(other.problems[0]).toContain(`that stage has not published for release ${R2}`);
    expect((await resolveStageReads(spec, "staging", undefined, port)).status).toBe("refused");
    expect(await resolveStageReads(spec, "prod", undefined, port)).toEqual({ status: "resolved", variables: {}, reads: [] });
  });

  test("the variables are set for the deploy and put back after", async () => {
    const env: NodeJS.ProcessEnv = { KEEP: "1", TF_VAR_x: "old" };
    const seen = await withStageReadVariables({ TF_VAR_x: "new", TF_VAR_y: "y" }, async () => ({ ...env }), env);
    expect(seen).toMatchObject({ TF_VAR_x: "new", TF_VAR_y: "y" });
    expect(env).toEqual({ KEEP: "1", TF_VAR_x: "old" });
  });

  test("a string reaches its variable as it is, any other value as JSON", () => {
    expect(stageArtifactText({ kind: "value", value: "a b", member: "m", output: "o" })).toBe("a b");
    expect(stageArtifactText({ kind: "value", value: [1, "x"], member: "m", output: "o" })).toBe('[1,"x"]');
  });
});

describe("on chant/lifecycle, in one repository and across two (#5356)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  function repo(name: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `stage-artifacts-${name}-`)));
    dirs.push(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", `${name}@chant.dev`], dir);
    git(["config", "user.name", name], dir);
    writeFileSync(join(dir, "README.md"), `${name}\n`);
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    return dir;
  }
  const spec = asPipelineSpec(declaration(publishing)) as PipelineSpec;

  test("two members publish in dev, staging reads them, and the ledger holds no secret", async () => {
    const a = repo("a");
    const port = gitStageArtifactPort({ cwd: a });
    const got = await publishStageArtifacts({ spec, stage: "dev", release: { digest: R1, label: "v1.0.0" }, outputsOf, port });
    expect(got.status).toBe("published");
    const raw = (await readBlobFromPath("dev", STAGE_ARTIFACTS_FILE, { cwd: a })) ?? "";
    expect(raw).toContain(R1);
    expect(raw).toContain("db.dev.internal");
    expect(raw).not.toContain(SECRET_VALUE);
    const reads = await resolveStageReads(spec, "staging", R1, port);
    expect(reads.status === "resolved" && reads.variables.TF_VAR_dev_endpoint).toBe("https://dev.k8s.example");
  });

  test("another repository reads the artifacts of the release dev last published for, or of a named one", async () => {
    const a = repo("upstream");
    const port = gitStageArtifactPort({ cwd: a });
    await publishStageArtifacts({ spec, stage: "dev", release: { digest: R1 }, outputsOf, port });
    outputs.cluster!.outputs.endpoint = "https://dev2.k8s.example";
    try {
      await publishStageArtifacts({ spec, stage: "dev", release: { digest: R2 }, outputsOf, port });
    } finally {
      outputs.cluster!.outputs.endpoint = "https://dev.k8s.example";
    }
    // The downstream repository holds the upstream's chant/lifecycle alone, as a control repo's note job fetches it.
    const b = repo("downstream");
    const fetched = realpathSync(mkdtempSync(join(tmpdir(), "stage-artifacts-fetched-")));
    dirs.push(fetched);
    git(["init", "-q"], fetched);
    git(["fetch", "-q", "--no-tags", a, "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"], fetched);
    const there = gitStageArtifactPort({ cwd: fetched });
    expect((await readStageArtifacts(there, { stage: "dev" }))?.release).toBe(R2);
    const pinned = await readStageArtifacts(there, { stage: "dev", release: R1 });
    expect(pinned?.artifacts.endpoint).toMatchObject({ value: "https://dev.k8s.example" });
    expect(await readStageArtifacts(gitStageArtifactPort({ cwd: b }), { stage: "dev" })).toBeUndefined();
  });

  test("the release cut from a commit is found by its sha", async () => {
    const a = repo("cut");
    const sha = git(["rev-parse", "HEAD"], a);
    const release = makeRelease({ member: null, commit: sha, artifactDigests: [], targets: [] });
    await persistRelease(release, [], { cwd: a });
    await appendCut({ releaseDigest: release.releaseDigest, label: "v2.0.0", actor: "ci", timestamp: "2026-11-20T00:00:00Z", runOrigin: null }, { cwd: a });
    expect(await releaseCutFrom(sha, { cwd: a })).toEqual({ digest: release.releaseDigest, label: "v2.0.0", commit: sha });
    expect(await releaseCutFrom(sha.slice(0, 12), { cwd: a })).toMatchObject({ digest: release.releaseDigest });
    expect(await releaseCutFrom("f".repeat(40), { cwd: a })).toBeUndefined();
  });
});

describe("the <product>-applied dispatch carries the release digest (#5356)", () => {
  const target = (release?: boolean) => resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", ...(release !== undefined ? { release } : {}) }, "shop");

  test("off by default: the target and the script are as before", () => {
    expect(target()).not.toHaveProperty("release");
    expect(controlDispatchScript(target(), { outcome: true })).not.toContain("release-of");
    expect(controlDispatchScript(target(false), { outcome: true })).toBe(controlDispatchScript(target(), { outcome: true }));
  });

  test("with control.release the request and the script send it, on each forge", () => {
    const req = controlDispatchRequest(target(true), { member: "shop", op: "deploy", sha: "abcdef1", outcome: "applied", releaseDigest: R1 });
    expect(req.body).toMatchObject({ json: { client_payload: { release: R1 } } });
    const gitlab = controlDispatchRequest(resolveControlTarget({ repo: "gitlab.com/acme/control", op: "deploy", release: true }, "shop"), { member: "shop", op: "deploy", sha: "abcdef1", releaseDigest: R1 });
    expect("form" in gitlab.body && gitlab.body.form).toContainEqual(["variables[CHANT_CONTROL_RELEASE]", R1]);
    const script = controlDispatchScript(target(true), { outcome: true });
    expect(script).toContain('release="$(npx --no-install chant pipeline release-of "$sha" 2>/dev/null)" || release=""');
    expect(script).toContain(`'"$rfield"'`);
    expect(() => controlDispatchRequest(target(true), { member: "shop", op: "deploy", sha: "abcdef1", releaseDigest: "nope" })).toThrow(/not a release digest/);
  });

  test("the script sends the release it found, and none when the lookup finds none", () => {
    const script = controlDispatchScript(target(true), { outcome: true });
    const lines = script.split("\n");
    const start = lines.findIndex((l) => l.startsWith("release="));
    const block = lines.slice(start + 1, start + 4).join("\n");
    const run = (release: string) => execFileSync("bash", ["-c", `release='${release}'\n${block}\nprintf '%s' "$rfield"`], { encoding: "utf8" });
    expect(run(R1)).toBe(`,"release":"${R1}"`);
    expect(run("")).toBe("");
    expect(run("garbage")).toBe("");
  });
});
