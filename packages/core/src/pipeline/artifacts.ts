/**
 * Release artifacts (#5356): named values a stage publishes for the release
 * it applied, which later stages and other repositories read.
 *
 * A stage often produces a value a later stage or another repository needs:
 * a cluster endpoint, an image tag, a database host. A stage declares what
 * it publishes under `publish`, each artifact by name:
 *
 *     {
 *       name: "dev",
 *       waves: [...],
 *       publish: {
 *         endpoint: { member: "cluster", output: "endpoint" },
 *         db_password: { secret: { awsSecretsManager: "arn:aws:secretsmanager:...:secret:dev/db" } },
 *       },
 *     }
 *
 * - `{ member, output }` publishes the member's output as the stage left it
 *   once it applied: a string, or any JSON value. An output the engine marks
 *   sensitive or secret (a Terraform output with `sensitive = true`, a Pulumi
 *   secret) is refused, and nothing of that publish is recorded.
 * - `{ secret }` publishes where a secret is kept, in the words of #5348's
 *   config and secret sets (a forge secret's name, an AWS Secrets Manager
 *   secret, a Google Secret Manager version or an Azure Key Vault secret).
 *   The reference is recorded and the secret itself is never read.
 *
 * Artifacts are values, never files: a value's JSON text is at most
 * {@link STAGE_ARTIFACT_MAX_BYTES}.
 *
 * Each publish is one line of `<stage>/artifacts.jsonl` on `chant/lifecycle`
 * ({@link STAGE_ARTIFACTS_FILE}), beside the stage's `releases.jsonl`: the
 * pipeline, the stage, the release digest, its label, the commit, and every
 * artifact the stage declares. The first stage publishes once its last wave
 * applied and the merge cut its release (an after-apply hook after the cut,
 * `./stages.ts`). A later stage publishes once `chant components promote
 * --to <stage> --release <ref>` deployed.
 *
 * A later stage reads an upstream stage's artifact of the same release under
 * `reads`, keyed by the variable name its deploy gets the value in:
 *
 *     { name: "staging", waves: [...], reads: { TF_VAR_dev_endpoint: { stage: "dev", artifact: "endpoint" } } }
 *
 * `chant build` refuses a read of a stage that is not upstream of the reading
 * stage (#5385): earlier in the list when no stage declares `after`, else an
 * ancestor through `after`, so a sibling is refused. It also refuses a read of an artifact that stage does not publish
 * ({@link stageArtifactsSpecProblems}). The promote refuses before anything
 * deploys when the upstream has not published the artifact for the release
 * being promoted ({@link resolveStageReads}). A string reaches the variable
 * as it is, any other JSON value as its JSON text, and a secret as its
 * reference's JSON.
 *
 * Another repository reads with {@link readStageArtifacts} (`chant pipeline
 * artifacts read --stage <stage> --from <dir>`): the artifacts of the release
 * the stage last published for, or of a named release. The `<product>-applied`
 * dispatch carries the release digest when `control.release` is set
 * (../control/dispatch.ts), and the read takes it from `CHANT_CONTROL_RELEASE`,
 * so a downstream run pins to the release the member applied.
 *
 * Off by default: a stage with no `publish` publishes nothing, and its jobs
 * render as before.
 *
 * This module imports types alone at load, and the ledger at call time.
 */

import { NEXT_RELEASE } from "../release-floors";
import { environmentSecretSource, type EnvironmentSecretRef, type EnvironmentSecretSource } from "../components/environment-sets";
import type { PipelineSpec, PipelineStage } from "./spec";

/**
 * The first chant with release artifacts (#5356): a stage's `publish` and
 * `reads` in `.chant/pipeline.ts`, the build's refusal of a read no upstream
 * publishes, the publish after the first stage's release cut and after a
 * promote under a release, `chant pipeline artifacts publish|read`, `chant
 * pipeline release-of`, and `control.release` on the `<product>-applied`
 * dispatch. A product feature-detects release artifacts on this name.
 */
export const STAGE_ARTIFACTS_FLOOR = NEXT_RELEASE;

/** The ledger file a stage's publishes are kept in, beside its `releases.jsonl`. */
export const STAGE_ARTIFACTS_FILE = "artifacts.jsonl";

/** The record kind a line of {@link STAGE_ARTIFACTS_FILE} carries. A reader skips any other. */
export const STAGE_ARTIFACTS_KIND = "stage-artifacts";

/** The largest JSON text one artifact's value may have, in bytes. An artifact is a value, never a file. */
export const STAGE_ARTIFACT_MAX_BYTES = 65536;

/** The variable a read takes its release from when none is named: the one the `<product>-applied` dispatch carries. */
export const STAGE_ARTIFACTS_RELEASE_ENV = "CHANT_CONTROL_RELEASE";

/** What a stage publishes under one name. */
export type StageArtifactSource =
  /** A member's output, as the stage left it once it applied. Refused when the engine marks it sensitive. */
  | { member: string; output: string }
  /** Where a secret is kept (#5348's words). The reference is published, never the secret. */
  | { secret: EnvironmentSecretRef };

/** One artifact of an upstream stage that a stage reads. */
export interface StageArtifactRead {
  /** The upstream stage: one before the reading stage in promotion order. */
  stage: string;
  /** The artifact's name in that stage's `publish`. */
  artifact: string;
}

/** A JSON value. */
export type StageArtifactValue = string | number | boolean | null | StageArtifactValue[] | { [key: string]: StageArtifactValue };

/** One published artifact, as the ledger holds it. */
export type StageArtifactEntry =
  | { kind: "value"; value: StageArtifactValue; member: string; output: string }
  | { kind: "secret"; source: EnvironmentSecretSource };

/** One line of `<stage>/artifacts.jsonl`: every artifact a stage published for one release. */
export interface StageArtifactRecord {
  version: 1;
  kind: typeof STAGE_ARTIFACTS_KIND;
  pipeline: string;
  stage: string;
  /** The release digest the stage applied. */
  release: string;
  /** The release's label, when its cut named one. */
  label?: string;
  /** The commit the release was cut from. */
  gitSha?: string;
  at: string;
  /** By artifact name. */
  artifacts: Record<string, StageArtifactEntry>;
}

/** Where a stage's artifact records are read and written. */
export interface StageArtifactPort {
  read(stage: string): Promise<StageArtifactRecord[]>;
  append(stage: string, record: StageArtifactRecord): Promise<void>;
}

const ARTIFACT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What is wrong with a stage's `publish`, one line each. */
export function stagePublishProblems(publish: unknown, at: string): string[] {
  if (publish === undefined) return [];
  if (!isMap(publish)) return [`${at}.publish must be a map of artifact name to { "member", "output" } or { "secret" }`];
  const out: string[] = [];
  for (const [name, source] of Object.entries(publish)) {
    const where = `${at}.publish.${name}`;
    if (!ARTIFACT_NAME.test(name)) out.push(`${at}.publish names ${JSON.stringify(name)}; an artifact's name is a letter, then letters, digits, "-" and "_"`);
    if (!isMap(source)) {
      out.push(`${where} must be { "member", "output" } or { "secret" }`);
      continue;
    }
    const keys = Object.keys(source).sort().join(",");
    if (keys === "secret") {
      const found = environmentSecretSource(source.secret);
      if (typeof found === "string") out.push(`${where}.secret ${found}`);
    } else if (keys === "member,output") {
      if (typeof source.member !== "string" || source.member.trim() === "") out.push(`${where}.member must name a member`);
      if (typeof source.output !== "string" || source.output.trim() === "") out.push(`${where}.output must name one of the member's outputs`);
    } else out.push(`${where} must be { "member", "output" } or { "secret" }, and sets ${Object.keys(source).join(", ") || "nothing"}`);
  }
  return out;
}

/** What is wrong with a stage's `reads` on its own, one line each. Whether an upstream publishes each is {@link stageArtifactsSpecProblems}'s. */
export function stageReadsProblems(reads: unknown, at: string): string[] {
  if (reads === undefined) return [];
  if (!isMap(reads)) return [`${at}.reads must be a map of variable name to { "stage", "artifact" }`];
  const out: string[] = [];
  for (const [name, read] of Object.entries(reads)) {
    const where = `${at}.reads.${name}`;
    if (!VARIABLE.test(name)) out.push(`${at}.reads names ${JSON.stringify(name)}, which is not a variable name`);
    else if (name.startsWith("CHANT_")) out.push(`${at}.reads names ${name}; a variable starting CHANT_ is one chant's jobs set themselves`);
    if (!isMap(read) || Object.keys(read).sort().join(",") !== "artifact,stage" || typeof read.stage !== "string" || typeof read.artifact !== "string") {
      out.push(`${where} must be { "stage", "artifact" }`);
    }
  }
  return out;
}

/**
 * The indexes of every stage upstream of stage `index`, through `after`
 * (#5353): a stage follows its `after`, else the stage before it. Mirrors
 * `stageUpstreams` in ./spec, which this module cannot import at load. A
 * cycle or an unknown name ends that path.
 */
export function ancestorsOf(stages: Array<Partial<PipelineStage>>, index: number): Set<number> {
  const found = new Set<number>();
  const visit = (i: number): void => {
    const stage = stages[i]!;
    const ups = Array.isArray(stage.after) ? stage.after.map((n) => stages.findIndex((s) => s.name === n)) : i === 0 ? [] : [i - 1];
    for (const up of ups) {
      if (up < 0 || found.has(up)) continue;
      found.add(up);
      visit(up);
    }
  };
  visit(index);
  return found;
}

/**
 * The reads no upstream publishes (#5356), one line each: a read of a stage
 * that is not before the reading stage in promotion order, or of an
 * artifact that stage's `publish` does not name, and a first stage that
 * publishes while the merge cuts no release. `chant build` refuses each.
 */
export function stageArtifactsSpecProblems(spec: { stages?: unknown; release?: unknown }): string[] {
  if (!Array.isArray(spec.stages)) return [];
  const stages = spec.stages.filter(isMap) as Array<Partial<PipelineStage> & Record<string, unknown>>;
  const out: string[] = [];
  const first = stages[0];
  const cut = !(isMap(spec.release) && spec.release.cut === false);
  if (first && isMap(first.publish) && Object.keys(first.publish).length > 0 && !cut) {
    out.push(`stage "${first.name}" publishes artifacts, which are kept for the release the merge cuts, and release.cut is false`);
  }
  const graph = stages.some((s) => s.after !== undefined);
  stages.forEach((stage, i) => {
    if (!isMap(stage.reads)) return;
    const upstream = graph ? ancestorsOf(stages, i) : undefined;
    for (const [name, read] of Object.entries(stage.reads)) {
      if (!isMap(read) || typeof read.stage !== "string" || typeof read.artifact !== "string") continue;
      const at = stages.findIndex((s) => s.name === read.stage);
      if (at < 0) out.push(`stage "${stage.name}" reads ${name} from stage "${read.stage}", which the pipeline does not have`);
      else if (upstream && !upstream.has(at)) {
        out.push(`stage "${stage.name}" reads ${name} from stage "${read.stage}", which "${stage.name}" does not follow through after; a stage reads its upstream stages, and "${read.stage}" is not one of them`);
      } else if (!upstream && at >= i) out.push(`stage "${stage.name}" reads ${name} from stage "${read.stage}", which comes ${at === i ? "at the same place" : "after it"} in promotion order; a stage reads the stages before it`);
      else if (!isMap(stages[at]!.publish) || !Object.prototype.hasOwnProperty.call(stages[at]!.publish, read.artifact)) {
        out.push(`stage "${stage.name}" reads ${name} from artifact "${read.artifact}" of stage "${read.stage}", which that stage never publishes`);
      }
    }
  });
  return out;
}

/** The records in a ledger file's text, oldest first, malformed lines left out. */
export function parseStageArtifactRecords(text: string): StageArtifactRecord[] {
  const out: StageArtifactRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as Partial<StageArtifactRecord>;
      if (r.version === 1 && r.kind === STAGE_ARTIFACTS_KIND && typeof r.stage === "string" && typeof r.release === "string" && isMap(r.artifacts)) out.push(r as StageArtifactRecord);
    } catch {
      // A line that does not read is skipped.
    }
  }
  return out;
}

/**
 * {@link StageArtifactPort} on `chant/lifecycle`, at `<stage>/artifacts.jsonl`.
 * `cwd` may be a checkout of another repository, or a directory holding its
 * `chant/lifecycle` alone; `member` or `ledgerPrefix` names a workspace
 * member's records there.
 */
export function gitStageArtifactPort(opts: { cwd?: string; member?: string; ledgerPrefix?: string } = {}): StageArtifactPort {
  return {
    async read(stage) {
      const { readBlobFromPath } = await import("../lifecycle/git");
      return parseStageArtifactRecords((await readBlobFromPath(stage, STAGE_ARTIFACTS_FILE, opts)) ?? "");
    },
    async append(stage, record) {
      const { appendLedgerLine } = await import("../lifecycle/git");
      await appendLedgerLine(stage, STAGE_ARTIFACTS_FILE, JSON.stringify(record), `chant: artifacts of ${record.stage} for ${record.label ?? record.release}`, opts.cwd ? { cwd: opts.cwd } : {});
    },
  };
}

/** A member's outputs after the stage applied, and the names its engine marks sensitive or secret. */
export interface MemberOutputs {
  outputs: Record<string, unknown>;
  sensitive: readonly string[];
}

/** What {@link publishStageArtifacts} takes. */
export interface PublishStageArtifactsInput {
  spec: Pick<PipelineSpec, "name" | "stages">;
  stage: string;
  release: { digest: string; label?: string | null; gitSha?: string };
  /** A member's outputs as its steps read them now, or undefined when its steps say none. */
  outputsOf: (member: string) => Promise<MemberOutputs | undefined>;
  port: StageArtifactPort;
  /** Check and answer the record; write nothing. */
  dryRun?: boolean;
  now?: () => string;
}

/** What a publish did. `refused` lists why nothing was recorded; a refusal never quotes an output's value. */
export type PublishStageArtifactsResult = { status: "none"; stage: string } | { status: "published"; record: StageArtifactRecord; dryRun?: true } | { status: "refused"; stage: string; problems: string[] };

/** The JSON value `v` is, or why it is not one. Undefined, functions and the like are not. */
function jsonValueOf(v: unknown): { value: StageArtifactValue; bytes: number } | string {
  let text: string | undefined;
  try {
    text = JSON.stringify(v);
  } catch {
    return "is not a JSON value";
  }
  if (text === undefined) return "is not a JSON value";
  return { value: JSON.parse(text) as StageArtifactValue, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * Publish the artifacts `stage` declares for `release` (#5356): every one or
 * none. A member output the engine marks sensitive is refused, by name; a
 * secret is recorded as where it is kept. The record holds no value the
 * engine marks sensitive and no secret, and neither does a refusal.
 */
export async function publishStageArtifacts(input: PublishStageArtifactsInput): Promise<PublishStageArtifactsResult> {
  const stage = input.spec.stages.find((s) => s.name === input.stage);
  if (!stage) return { status: "refused", stage: input.stage, problems: [`the pipeline "${input.spec.name}" has no stage "${input.stage}"`] };
  const declared = Object.entries(stage.publish ?? {});
  if (declared.length === 0) return { status: "none", stage: stage.name };
  const problems: string[] = [];
  const artifacts: Record<string, StageArtifactEntry> = {};
  const cache = new Map<string, Promise<MemberOutputs | undefined>>();
  for (const [name, source] of declared.sort(([a], [b]) => a.localeCompare(b))) {
    if ("secret" in source) {
      const found = environmentSecretSource(source.secret);
      if (typeof found === "string") problems.push(`${name}: the secret ${found}`);
      else artifacts[name] = { kind: "secret", source: found };
      continue;
    }
    if (!cache.has(source.member)) cache.set(source.member, input.outputsOf(source.member));
    const got = await cache.get(source.member)!;
    if (!got) {
      problems.push(`${name}: ${source.member}'s steps say no outputs`);
      continue;
    }
    if (got.sensitive.includes(source.output)) {
      problems.push(`${name}: ${source.member}'s output ${source.output} is marked sensitive, so it is not published; publish where it is kept with { "secret" } instead`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(got.outputs, source.output)) {
      problems.push(`${name}: ${source.member} has no output ${source.output}`);
      continue;
    }
    const value = jsonValueOf(got.outputs[source.output]);
    if (typeof value === "string") problems.push(`${name}: ${source.member}'s output ${source.output} ${value}`);
    else if (value.bytes > STAGE_ARTIFACT_MAX_BYTES) problems.push(`${name}: ${source.member}'s output ${source.output} is ${value.bytes} bytes as JSON, above the ${STAGE_ARTIFACT_MAX_BYTES} an artifact holds; an artifact is a value, never a file`);
    else artifacts[name] = { kind: "value", value: value.value, member: source.member, output: source.output };
  }
  if (problems.length > 0) return { status: "refused", stage: stage.name, problems };
  const record: StageArtifactRecord = {
    version: 1,
    kind: STAGE_ARTIFACTS_KIND,
    pipeline: input.spec.name,
    stage: stage.name,
    release: input.release.digest,
    ...(input.release.label ? { label: input.release.label } : {}),
    ...(input.release.gitSha ? { gitSha: input.release.gitSha } : {}),
    at: (input.now ?? (() => new Date().toISOString()))(),
    artifacts,
  };
  if (input.dryRun) return { status: "published", record, dryRun: true };
  await input.port.append(stage.name, record);
  return { status: "published", record };
}

/**
 * The artifacts `stage` published (#5356): for `release` when named (a
 * digest), else for the release it last published for. The latest record
 * wins when a release was published twice. Undefined when there is none.
 */
export async function readStageArtifacts(port: StageArtifactPort, query: { stage: string; release?: string }): Promise<StageArtifactRecord | undefined> {
  const records = (await port.read(query.stage)).filter((r) => r.stage === query.stage && (query.release === undefined || r.release === query.release));
  return records[records.length - 1];
}

/** The text a variable holds for an artifact: a string as it is, any other value as JSON, a secret as its reference's JSON. */
export function stageArtifactText(entry: StageArtifactEntry): string {
  if (entry.kind === "secret") return JSON.stringify(entry.source);
  return typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
}

/** One read a stage's deploy gets. */
export interface ResolvedStageRead extends StageArtifactRead {
  /** The variable it is in. */
  variable: string;
  kind: StageArtifactEntry["kind"];
}

/** What {@link resolveStageReads} found. */
export type StageReadsResult = { status: "resolved"; variables: Record<string, string>; reads: ResolvedStageRead[] } | { status: "refused"; problems: string[] };

/**
 * The variables `stage`'s reads hold for `release` (#5356), each from the
 * upstream stage's record of that same release. Refused, naming each, when
 * an upstream has not published the artifact for this release, or when the
 * stage reads and no release is named. Empty when the stage reads nothing.
 */
export async function resolveStageReads(spec: Pick<PipelineSpec, "stages">, stage: string, release: string | undefined, port: StageArtifactPort): Promise<StageReadsResult> {
  const reads = Object.entries(spec.stages.find((s) => s.name === stage)?.reads ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (reads.length === 0) return { status: "resolved", variables: {}, reads: [] };
  if (release === undefined) return { status: "refused", problems: [`stage "${stage}" reads ${reads.map(([n]) => n).join(", ")} from the release it takes; promote a release with --release <label|digest>`] };
  const variables: Record<string, string> = {};
  const resolved: ResolvedStageRead[] = [];
  const problems: string[] = [];
  const byStage = new Map<string, Promise<StageArtifactRecord | undefined>>();
  for (const [variable, read] of reads) {
    if (!byStage.has(read.stage)) byStage.set(read.stage, readStageArtifacts(port, { stage: read.stage, release }));
    const record = await byStage.get(read.stage)!;
    const entry = record?.artifacts[read.artifact];
    if (!entry) {
      problems.push(`stage "${stage}" reads ${variable} from artifact "${read.artifact}" of stage "${read.stage}", which ${record ? "that stage's publish for" : "that stage has not published for"} release ${release}${record ? " does not hold" : ""}`);
      continue;
    }
    variables[variable] = stageArtifactText(entry);
    resolved.push({ variable, stage: read.stage, artifact: read.artifact, kind: entry.kind });
  }
  return problems.length > 0 ? { status: "refused", problems } : { status: "resolved", variables, reads: resolved };
}

/** A short form of a release digest for a line a person reads. */
function shortRelease(record: Pick<StageArtifactRecord, "release" | "label">): string {
  return record.label ?? record.release;
}

/**
 * The note a publish or a read prints (Markdown): each artifact, a value as
 * JSON, a secret as where it is kept. Holds no secret: a secret artifact's
 * record never holds one.
 */
export function stageArtifactsNote(record: StageArtifactRecord): string {
  const lines = [`### Artifacts of stage ${record.stage} for release ${shortRelease(record)}`, ""];
  const names = Object.keys(record.artifacts).sort();
  if (names.length === 0) lines.push("None.");
  for (const name of names) {
    const entry = record.artifacts[name]!;
    if (entry.kind === "secret") lines.push(`- \`${name}\`: a secret kept in ${secretPlace(entry.source)}`);
    else lines.push(`- \`${name}\` = \`${JSON.stringify(entry.value)}\` (${entry.member}'s output ${entry.output})`);
  }
  lines.push("", `Release \`${record.release}\`${record.gitSha ? `, commit ${record.gitSha.slice(0, 12)}` : ""}, published ${record.at}.`);
  return `${lines.join("\n")}\n`;
}

/** Where a secret is kept, as a person reads it. */
function secretPlace(source: EnvironmentSecretSource): string {
  switch (source.store) {
    case "forge":
      return `the forge secret ${source.secret}`;
    case "aws-secrets-manager":
      return `AWS Secrets Manager, ${source.id}${source.jsonKey ? ` (key ${source.jsonKey})` : ""}`;
    case "gcp-secret-manager":
      return `Google Secret Manager, ${source.name}`;
    default:
      return `Azure Key Vault, ${source.id}`;
  }
}

/**
 * The release cut from `commit` (#5356): the newest cut whose release names
 * that commit, with its label. Undefined when none was cut from it.
 */
export async function releaseCutFrom(commit: string, opts: { cwd?: string; member?: string; ledgerPrefix?: string } = {}): Promise<{ digest: string; label: string | null; commit: string } | undefined> {
  const { readCuts, readRelease } = await import("../lifecycle/release-store");
  const { cuts } = await readCuts(opts);
  const seen = new Set<string>();
  for (const cut of [...cuts].reverse()) {
    if (seen.has(cut.releaseDigest)) continue;
    seen.add(cut.releaseDigest);
    const release = await readRelease(cut.releaseDigest, opts);
    if (release && (release.commit === commit || (commit.length >= 7 && release.commit.startsWith(commit)))) return { digest: release.releaseDigest, label: cut.label, commit: release.commit };
  }
  return undefined;
}

/** The variables of {@link resolveStageReads} set in `env` for the length of `run`, then put back as they were. */
export async function withStageReadVariables<T>(variables: Record<string, string>, run: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const before = new Map(Object.keys(variables).map((k) => [k, env[k]]));
  Object.assign(env, variables);
  try {
    return await run();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}
