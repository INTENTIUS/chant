/**
 * `member-outputs`: another workspace member's outputs, read through the
 * engine that member runs on, so a chant member's parameters can be planned
 * against them (#4455, design record choudoufu#2258 lane T6).
 *
 * In `behold/example-three-cloud`, `dns` (a chant member) reads each cloud's
 * endpoint as a parameter of the same name as the output the cloud's member
 * publishes. When the Azure site is a choudoufu estate, `azureEndpoint` is a
 * Terraform root output, and when the AWS site is a Pulumi stack it is a
 * stack output. Neither is a chant component, so there is nothing for a
 * `stackOutput()` reference to read. This verb is that something: a
 * component in the consumer's project whose one step names the upstream
 * member, and whose capability answers the two questions the components
 * machinery already asks of an upstream:
 *
 * - `outputs` (applied): what the member exposes now. A pull request that
 *   does not touch the member plans the consumer against these
 *   (`deployedOutputs`, #4104).
 * - `plan` (planned): what the member will expose once its own plan applies,
 *   with the outputs known only after apply named (`PlannedOutputs`, #3999).
 *   A pull request that touches the member plans the consumer against the
 *   known ones. A reference to an unknown one is unresolved, so the
 *   consumer's step is planned with `DeployContext.unresolvedInputs` naming
 *   the member, the pull request's report lists `<member>.<output>` under the
 *   consumer's `unknownInputs`, and the apply holds the consumer back until
 *   the member applied, then plans it again (`pr-run.ts`, "Planning again
 *   once an upstream applied"). That is the hold chant already puts on a
 *   root waiting on another root's unknown output; nothing here adds a
 *   second one.
 *
 * The consumer writes it as two components:
 *
 * ```ts
 * export const azure = memberOutputsComponent("azure");
 * export const records: Component = {
 *   name: "records",
 *   dependsOn: ["azure"],
 *   deploy: [phase("Apply", [{ kind: "cfn-deploy", template: "dist/dns.json",
 *     inputs: { azureEndpoint: stackOutput("azure", "azureEndpoint") } }])],
 * };
 * ```
 *
 * ## Engines: the seam
 *
 * The member is looked up in the workspace declaration (`chant.workspace.json`)
 * by name, and its `kind` picks the {@link EngineOutputSource} that reads it.
 * Sources are not capabilities: each lexicon that drives an engine
 * contributes one through `CapabilityPlugin.engineOutputSources()`, the way
 * the cloud lexicons contribute registry logins to `publish-image`, and the
 * registry binds them into this one verb when it is built
 * (`registerCapabilityPlugins`). So two engines never register the same
 * kind, and a consumer's step does not change when the member moves between
 * engines.
 *
 * - `choudoufu` (the terraform lexicon, `choudoufuOutputSource`): applied
 *   values from `choudoufu output -json` in the member's directory, which in
 *   live mode reads the estate's record store; planned values from
 *   `live-plan-set -json` over the member's root, its plan's
 *   `planned_values.outputs` with every output whose `output_changes` entry
 *   marks any part `after_unknown` named unknown (`terraformPlannedOutputs`).
 * - `pulumi` (the pulumi lexicon, `pulumiOutputSource`): applied values
 *   from `pulumi stack output --json --show-secrets=false`, or from the
 *   member's checked-in `stack-export.json` when chant must not run pulumi
 *   (`CHANT_PULUMI_APPLIED_OUTPUTS=export`); planned values from `pulumi
 *   preview --json`, the stack step's outputs, where an output holding
 *   Pulumi's unknown sentinel is unknown. Secret outputs are left out of
 *   both. A member on plunge runs the same commands under `plunge`.
 *   Nothing in this module or in the consumer changes for it.
 *
 * ## Run reads, it never applies
 *
 * The member applies through its own pipeline. `run` checks that the
 * member's plan has nothing left to apply (`changes` false) and answers its
 * applied outputs; a member with changes still to apply refuses the run
 * with {@link MemberOutputsPendingError}, so the consumer is blocked behind
 * it and never applies against values from before the member's change. A
 * workspace orders the member's own run before the consumer's (members that
 * link to a producer run after it, `chant workspace run`).
 *
 * ## Which changes reach the member
 *
 * The component is a deploy unit named after the member (`DEPLOY_UNIT_RULES`),
 * so a change signal that names the member as a changed unit puts it in the
 * change. The terraform lexicon names it when the consumer's
 * `terraform.roots` has an entry of that name whose files changed;
 * `--from-affected` can name it too.
 */

import type { Capability, CapabilityPlan, DeployContext, PlannedOutputs } from "../capability";
import type { ChangeSetHole, ChangeSetPart } from "../../change-set";
import { computePlanDigest } from "../../lifecycle/plan-digest";
import type { Component } from "../component";

/** The step kind. */
export const MEMBER_OUTPUTS_KIND = "member-outputs";

/** The `member-outputs` step's input. */
export interface MemberOutputsInput {
  /** The upstream member's name in the workspace declaration. Also the component's name, by convention. */
  member: string;
  /**
   * Where the declaration search starts. Default: the current directory,
   * which is the consumer's project root under `chant run`.
   */
  cwd?: string;
}

/** What `run` returns: the member's applied outputs, under `outputs`, where the driver collects a stack's outputs from. */
export interface MemberOutputsOutput {
  member: string;
  outputs: Record<string, unknown>;
}

/** The upstream member a source reads, as the workspace declares it. */
export interface EngineMemberRef {
  /** The member's name. */
  member: string;
  /** Its declared kind, which picked the source: `choudoufu`, `pulumi`. */
  kind: string;
  /** Its directory, absolute. */
  dir: string;
  /** The workspace root, absolute. A source that must run from above the member's directory runs from here. */
  workspaceRoot: string;
}

/** What a source's plan of the member says about its outputs. */
export interface EnginePlannedOutputs extends PlannedOutputs {
  /**
   * A digest of the member's plan, the engine's own or chant's over it. The
   * consumer's approval binds it, so a plan of the member that moves after
   * review moves the consumer's digest too.
   */
  planDigest: string;
  /** Whether the member's plan has anything to apply. `run` refuses while it does. */
  changes: boolean;
}

/**
 * Reads one engine's member outputs (#4455). One per engine, contributed by
 * the lexicon that drives it through `CapabilityPlugin.engineOutputSources()`.
 */
export interface EngineOutputSource {
  /** The member kinds this source reads, as declared in `chant.workspace.json`. */
  readonly kinds: readonly string[];
  /** The member's outputs as applied now, by name. */
  applied(ctx: DeployContext, ref: EngineMemberRef): Promise<Record<string, unknown>>;
  /** The member's outputs once its current plan applies, the ones known only after apply named. */
  planned(ctx: DeployContext, ref: EngineMemberRef): Promise<EnginePlannedOutputs>;
}

/** Finds a member in the workspace above `cwd`: its kind and directory. */
export type MemberLookup = (cwd: string, member: string) => Promise<EngineMemberRef>;

/** No source for the member's kind is loaded. */
export class EngineOutputSourceMissingError extends Error {
  constructor(
    readonly member: string,
    readonly kind: string,
    readonly available: readonly string[],
  ) {
    super(
      `${MEMBER_OUTPUTS_KIND}: member "${member}" is kind ${kind}, and no loaded lexicon reads that engine's outputs` +
        (available.length > 0 ? ` (loaded: ${available.join(", ")})` : "") +
        `. ${kind === "choudoufu" ? 'Add "terraform" to the project\'s lexicons.' : kind === "pulumi" ? 'Add "pulumi" to the project\'s lexicons.' : "Load the lexicon that drives it."}`,
    );
    this.name = "EngineOutputSourceMissingError";
  }
}

/** The member's plan has changes its own pipeline has not applied. Nothing was read. */
export class MemberOutputsPendingError extends Error {
  constructor(readonly member: string) {
    super(
      `${MEMBER_OUTPUTS_KIND}: member "${member}" has changes its own pipeline has not applied yet, ` +
        `so its outputs are still the ones from before them. Apply ${member} first; whatever reads its outputs runs after it.`,
    );
    this.name = "MemberOutputsPendingError";
  }
}

/** The member a {@link MemberOutputsInput} reads plans as, in the consumer's change set. */
export const memberOutputsMemberName = (member: string): string => `${member}#outputs`;

/**
 * The member's name in the declaration above `cwd`, with its kind and
 * directory. Reads the working tree. Imported lazily: the verb set is
 * loaded where the workspace reader's dependencies may not be.
 */
export const workspaceMemberLookup: MemberLookup = async (cwd, member) => {
  const { locateWorkspace } = await import("../../workspace/which-chant");
  const { readDeclaration } = await import("../../workspace/declaration");
  const { join } = await import("node:path");
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree);
  const found = declaration.members.find((m) => m.name === member);
  if (!found) {
    const names = declaration.members.map((m) => m.name).sort();
    throw new Error(`${MEMBER_OUTPUTS_KIND}: the workspace at ${located.rootOnDisk} declares no member "${member}" (members: ${names.join(", ")})`);
  }
  return {
    member: found.name,
    kind: found.kind,
    dir: found.dir === "." ? located.rootOnDisk : join(located.rootOnDisk, ...found.dir.split("/")),
    workspaceRoot: located.rootOnDisk,
  };
};

function requireMember(input: MemberOutputsInput): void {
  if (typeof input?.member !== "string" || input.member === "") {
    throw new Error(`${MEMBER_OUTPUTS_KIND}: "member" is required and names a member of the workspace`);
  }
}

/** Implemented by a capability that wants the plugins' engine output sources injected when a registry is built. */
export interface EngineOutputSourceConsumer {
  withEngineOutputSources(sources: readonly EngineOutputSource[]): Capability<never, unknown>;
}

export function isEngineOutputSourceConsumer(value: unknown): value is EngineOutputSourceConsumer {
  return typeof value === "object" && value !== null && typeof (value as EngineOutputSourceConsumer).withEngineOutputSources === "function";
}

/**
 * The member's part of the consumer's change set: no entries, since the
 * member's own pipeline plans and applies its changes, and a hole per output
 * known only after apply, naming the member and the output.
 */
function outputsPart(member: string, planDigest: string, unknown: readonly string[]): ChangeSetPart {
  const holes: ChangeSetHole[] = unknown.map((name) => ({
    address: `${member}.${name}`,
    type: "output",
    reason: `${member}.${name} is known only after ${member} applies; what reads it is planned again then`,
  }));
  return {
    member: { member: memberOutputsMemberName(member), lexicon: "chant", planner: "chant", status: "planned", planDigest, holes },
    entries: [],
  };
}

export interface MemberOutputsCapabilityOptions {
  /** The engines' sources. Bound by the registry from the loaded plugins; empty until then. */
  sources?: readonly EngineOutputSource[];
  /** How a member is found. Default: {@link workspaceMemberLookup}. */
  lookup?: MemberLookup;
}

/** `member-outputs` over the given sources. */
export function memberOutputsCapability(
  options: MemberOutputsCapabilityOptions = {},
): Capability<MemberOutputsInput, MemberOutputsOutput> & EngineOutputSourceConsumer {
  const sources = options.sources ?? [];
  const lookup = options.lookup ?? workspaceMemberLookup;

  async function resolve(input: MemberOutputsInput): Promise<{ ref: EngineMemberRef; source: EngineOutputSource }> {
    requireMember(input);
    const ref = await lookup(input.cwd ?? process.cwd(), input.member);
    const source = sources.find((s) => s.kinds.includes(ref.kind));
    if (!source) throw new EngineOutputSourceMissingError(ref.member, ref.kind, [...new Set(sources.flatMap((s) => s.kinds))].sort());
    return { ref, source };
  }

  return {
    kind: MEMBER_OUTPUTS_KIND,
    // It reads; the member's own pipeline applies. Nothing to compensate.
    rollbackPolicy: "none-by-design",
    targets: { refuse: "it reads another member's outputs; narrow that member's own plan instead" },
    async plan(ctx: DeployContext, input: MemberOutputsInput): Promise<CapabilityPlan> {
      const { ref, source } = await resolve(input);
      const planned = await source.planned(ctx, ref);
      const unknown = [...new Set(planned.unknown)].sort();
      const known = Object.fromEntries(Object.entries(planned.known).filter(([name]) => !unknown.includes(name)));
      const member = memberOutputsMemberName(ref.member);
      const planDigest = computePlanDigest(MEMBER_OUTPUTS_KIND, { env: ctx.env, member: ref.member, kind: ref.kind, plan: planned.planDigest, known, unknown });
      return { member, planDigest, changeSet: outputsPart(ref.member, planDigest, unknown), outputs: { known, unknown } };
    },
    async outputs(ctx: DeployContext, input: MemberOutputsInput): Promise<Record<string, unknown>> {
      const { ref, source } = await resolve(input);
      return source.applied(ctx, ref);
    },
    async run(ctx: DeployContext, input: MemberOutputsInput): Promise<MemberOutputsOutput> {
      const { ref, source } = await resolve(input);
      const now = await source.planned(ctx, ref);
      if (now.changes) throw new MemberOutputsPendingError(ref.member);
      return { member: ref.member, outputs: await source.applied(ctx, ref) };
    },
    withEngineOutputSources(next: readonly EngineOutputSource[]) {
      return memberOutputsCapability({ ...options, sources: next }) as unknown as Capability<never, unknown>;
    },
  };
}

/** The starter set's `member-outputs`, with no sources until a registry binds the loaded plugins' ones. */
export const memberOutputsStarterCapability = memberOutputsCapability();

/**
 * A component in the consumer's project that stands for workspace member
 * `member` (#4455): one step reading its outputs. Named after the member, so
 * `stackOutput(member, "<output>")` reads them and `dependsOn: [member]`
 * orders the consumer after it.
 */
export function memberOutputsComponent(member: string, options: { cwd?: string } = {}): Component {
  return {
    name: member,
    archetype: "infra",
    dependsOn: [],
    deploy: [{ phase: "Outputs", steps: [{ kind: MEMBER_OUTPUTS_KIND, member, ...(options.cwd ? { cwd: options.cwd } : {}) }] }],
  };
}
