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
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { observation, unobservedAll, type DescribeResourcesResult } from "@intentius/chant/observation";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import type { PulumiConfig } from "./config";
import { readPlungeEngineGraph } from "./engine-graph";
import { pulumiMemberEngine } from "./member-engine";
import { plungeMemberGraph, type PulumiRunner } from "./run";
import type { PulumiMemberConfig } from "./workspace-member";

/** The `describeResources` options this read uses. */
export interface DescribePulumiOptions {
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
}

/** Injectable for tests: the member (else read from the project's config) and the plunge runner. */
export interface DescribePulumiDeps {
  /** The member, as the reader project's `pulumi.member` names it. Default: loaded from the config above `cwd`. */
  member?: PulumiMemberConfig;
  /** Where the config search starts. Default: the process cwd. */
  cwd?: string;
  plunge?: PulumiRunner;
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
  const names = [...options.entities.keys()];
  const member = deps.member ?? (await configuredMember(resolve(deps.cwd ?? process.cwd())));
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
