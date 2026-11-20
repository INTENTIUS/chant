/**
 * `describeResources` for a Pulumi member (#4529, designed on #4520 section
 * 4): engine facts for a member on plunge.
 *
 * A member on plunge is read with one `plunge graph --json --stack <stack>`
 * (`./run.ts`, `plungeMemberGraph`), the stack chosen as every other read
 * chooses it (`memberStack`: the declared one, else the one the checked-in
 * export's URNs name). plunge prints the stack's graph from its records in
 * chant#4520's document: no provider call, no output value. Each node becomes
 * a resource keyed like the member graph's node (`<label>/<urn tail>`, by
 * `pulumiNodeKey`), with plunge's `physicalId` and its facts on
 * `ResourceMetadata.facts`, which `buildLiveGraphIr` copies onto the node.
 * Provider resources and the root stack have no node and are left out.
 *
 * What it does not do:
 *
 * - Decide anything. `ownership` is `unknown` on every resource and no
 *   `marker` is set, so the change set never reads a delete from it and a
 *   teardown never selects it. plunge's markers carry `source: "record"`
 *   (#4520 Q5): what the record says was written, not a read of the object.
 * - Run anything for a stock member. `pulumiMemberEngine` decides, and a
 *   member on stock `pulumi` has every entity not-observed with
 *   `no-binding`, with no argv run.
 * - Ask for record versions. `--versions` costs one version listing per
 *   record (#4520 Q6), so this read leaves it off.
 *
 * A run that fails leaves every declared entity not-observed with the
 * reason, never absent. That includes a plunge older than `plunge graph`
 * (INTENTIUS/plunge#40).
 *
 * ## The preview depth (#5332)
 *
 * `CHANT_PULUMI_OBSERVE=preview` (or `depth: "preview"` from a caller) reads
 * any member, stock or plunge, with its engine's preview instead
 * (`./preview-observation.ts`): each resource gets the plan attributes the
 * terraform plan depth uses, and a resource the graph does not hold becomes
 * a node marked `planned`, which is every resource of a stack with no
 * export. The member's `rootReads` entry, `pulumi.members.<member>`, says
 * `depth: "preview"`. When the preview fails, the read above answers
 * instead (`fellBackTo` `state` when plunge's records did, `declared` when
 * nothing did) and `reason` is one of `PREVIEW_READ_REASONS`.
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { normalizeObservation, observation, unobservedAll, type DescribeResourcesResult, type RootRead } from "@intentius/chant/observation";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import type { PulumiConfig } from "./config";
import { readPlungeEngineGraph } from "./engine-graph";
import { pulumiMemberEngine } from "./member-engine";
import { observePreview, previewReadReason, PULUMI_OBSERVE_ENV, type PulumiObserveDepth } from "./preview-observation";
import { plungeMemberGraph, previewPulumiMemberRead, type PulumiRunner } from "./run";
import type { PulumiMemberConfig } from "./workspace-member";
import type { SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";

/** The `describeResources` options this read uses. */
export interface DescribePulumiOptions {
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
  /** Read at this depth, over `CHANT_PULUMI_OBSERVE` (#5332). */
  depth?: PulumiObserveDepth;
}

/** Injectable for tests: the member (else read from the project's config) and the plunge runner. */
export interface DescribePulumiDeps {
  /** The member, as the reader project's `pulumi.member` names it. Default: loaded from the config above `cwd`. */
  member?: PulumiMemberConfig;
  /** Where the config search starts. Default: the process cwd. */
  cwd?: string;
  plunge?: PulumiRunner;
  /** Runs stock pulumi, for the preview depth. */
  run?: PulumiRunner;
  /** The index store the preview depth reads the member's export from. Default: the project's; `null` reads the checked-in file only. */
  exportStore?: SnapshotStore | null;
  /** The environment the depth is read from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
}

/** The `sources` value on each entity this read answered. */
export const PLUNGE_GRAPH_SOURCE = "plunge-graph";

async function configuredMember(cwd: string): Promise<PulumiMemberConfig | undefined> {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { config, configPath } = await loadChantConfigUpward(cwd);
  const member = (config as { pulumi?: PulumiConfig }).pulumi?.member;
  if (!member) return undefined;
  const root = configPath ? dirname(configPath) : cwd;
  return isAbsolute(member.dir) ? member : { ...member, dir: resolve(root, member.dir) };
}

/** `LexiconPlugin.describeResources` for the pulumi lexicon. */
export async function describePulumiResources(options: DescribePulumiOptions, deps: DescribePulumiDeps = {}): Promise<DescribeResourcesResult> {
  const notes: string[] = [];
  const depth = observeDepth(options.depth, deps.env ?? process.env, notes);
  const member = deps.member ?? (await configuredMember(resolve(deps.cwd ?? process.cwd())));
  if (depth !== "preview" || !member) {
    const result = await describeFromRecords(options, deps, member);
    return notes.length > 0 ? addNotes(result, notes) : result;
  }
  return describeFromPreview(options, deps, member, notes);
}

/** The depth asked for: the caller's, then `CHANT_PULUMI_OBSERVE`, else `state`. */
function observeDepth(asked: PulumiObserveDepth | undefined, env: Record<string, string | undefined>, notes: string[]): PulumiObserveDepth {
  if (asked) return asked;
  const value = env[PULUMI_OBSERVE_ENV];
  if (value === "preview" || value === "state") return value;
  if (value) notes.push(`${PULUMI_OBSERVE_ENV}=${JSON.stringify(value)} is neither "state" nor "preview" and was ignored`);
  return "state";
}

function addNotes(result: DescribeResourcesResult, notes: string[]): DescribeResourcesResult {
  const n = normalizeObservation(result);
  return observation(n.resources, n.unobserved, n.queried, [...n.notes, ...notes], n.stackExports, n.sources, n.annotations, n.rootReads, n.edges);
}

/** The first line of an engine error, for a note. */
const firstLine = (text: string): string => text.split("\n").find((l) => l.trim() !== "")?.trim() ?? text;

/**
 * The preview depth: the member's preview, and when it fails the records
 * read below, with the reason on `rootReads`.
 */
async function describeFromPreview(options: DescribePulumiOptions, deps: DescribePulumiDeps, member: PulumiMemberConfig, notes: string[]): Promise<DescribeResourcesResult> {
  const label = member.label ?? basename(member.dir);
  const rootKey = `pulumi.members.${label}`;
  const engine = pulumiMemberEngine(member.dir, member.engine).engine;
  const read = await previewPulumiMemberRead({
    member: label,
    dir: member.dir,
    ...(member.stack ? { stack: member.stack } : {}),
    engine,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.plunge ? { plunge: deps.plunge } : {}),
    ...(deps.exportStore !== undefined ? { exportStore: deps.exportStore } : {}),
  });
  const failure = read.part.member.status === "failed" ? (read.part.member.error ?? "the preview failed") : undefined;
  const observed = failure === undefined ? observePreview({ label, preview: read.preview, declared: options.entities as Map<string, { entityType: string }> }) : undefined;
  if (observed) {
    const note = `${rootKey}: the ${engine} preview answered${observed.unmapped > 0 ? `; ${observed.unmapped} URN(s) had an op the change set has no action for` : ""}`;
    return observation(observed.resources, observed.unobserved, observed.queried, [...notes, note], undefined, observed.sources, undefined, { [rootKey]: { depth: "preview" } });
  }

  const error = failure ?? `${engine} preview --json printed no steps`;
  const reason = previewReadReason(error);
  const result = await describeFromRecords(options, deps, member);
  const answered = normalizeObservation(result);
  const fellBackTo: RootRead["fellBackTo"] = Object.keys(answered.resources).length > 0 ? "state" : "declared";
  const withReason = addNotes(result, [
    ...notes,
    `${rootKey}: the ${engine} preview failed (${reason}: ${firstLine(error)}), so ${fellBackTo === "state" ? "plunge's records answered" : "no read answered, declared only"}; plan attributes are absent`,
  ]);
  const n = normalizeObservation(withReason);
  return observation(n.resources, n.unobserved, n.queried, n.notes, n.stackExports, n.sources, n.annotations, { ...n.rootReads, [rootKey]: { depth: "preview", fellBackTo, reason } }, n.edges);
}

/** The records read: plunge's graph for a member on plunge, nothing for a stock member. */
async function describeFromRecords(options: DescribePulumiOptions, deps: DescribePulumiDeps, configured: PulumiMemberConfig | undefined): Promise<DescribeResourcesResult> {
  const names = [...options.entities.keys()];
  const member = configured;
  if (!member) {
    return observation({}, unobservedAll(names, "no-binding", "pulumi.member names no member; chant workspace graph writes it into a pulumi member's reader project", options.entities));
  }
  const label = member.label ?? basename(member.dir);
  const engine = pulumiMemberEngine(member.dir, member.engine);
  if (engine.engine !== "plunge") {
    // Stock pulumi has no record read; nothing runs (#4529).
    return observation(
      {},
      unobservedAll(names, "no-binding", `member ${label} runs on stock pulumi (${engine.because}); only a member on plunge is described, by plunge graph`, options.entities),
    );
  }

  const read = await plungeMemberGraph({ dir: member.dir, ...(member.stack ? { stack: member.stack } : {}), ...(deps.plunge ? { plunge: deps.plunge } : {}) });
  if (!read.ok) return observation({}, unobservedAll(names, read.reason, `${read.command} in ${member.dir}: ${read.detail}`, options.entities));
  const parsed = readPlungeEngineGraph(read.doc);
  if ("error" in parsed) {
    return observation({}, unobservedAll(names, "read-failed", `${read.command} in ${member.dir} printed a document chant can't read: ${parsed.error}`, options.entities));
  }

  const resources: Record<string, ResourceMetadata> = {};
  const queried: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const n of parsed.graph.nodes) {
    if (isPulumiNodeless(n.kind)) continue;
    const tail = pulumiNodeKey(n.urn);
    if (tail === null) continue;
    const key = `${label}/${tail}`;
    resources[key] = {
      type: n.kind,
      ...(n.physicalId ? { physicalId: n.physicalId } : {}),
      // The record's word, not a provider's: bound or pending (#4520 Q5).
      status: n.facts?.ownership ?? "recorded",
      // Never a verdict: see the module comment.
      ownership: "unknown",
      ...(n.facts ? { facts: n.facts } : {}),
    };
    queried[key] = n.urn;
    sources[key] = PLUNGE_GRAPH_SOURCE;
  }
  const notes: string[] = [];
  if (options.owned) {
    notes.push(`member ${label}: plunge graph reads records, not live markers, so ownership stays unknown; facts.markers says what the record wrote (source: record)`);
  }
  if (parsed.graph.gaps > 0) notes.push(`member ${label}: ${read.command} could not describe ${parsed.graph.gaps} record(s); see its meta.engineGraph.gaps`);
  return observation(resources, {}, queried, notes, undefined, sources);
}
