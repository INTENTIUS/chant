/**
 * Change set: a typed, read-only projection of a live diff.
 *
 * `chant lifecycle diff --live` computes a three-way comparison — declared now /
 * last snapshot / live now — and prints it. `buildChangeSet` promotes that
 * same signal into a classified create/update/delete/adopt/runtime/noop set
 * that other tooling (reconcile, apply) can act on.
 *
 * Strictly read-only and pure: no I/O, no mutation. The classification reads
 * ownership from the live marker only (populated downstream); until ownership
 * exists, an undeclared live resource is `adopt`, never `delete`. The snapshot
 * is evidence, never the basis for a mutation decision — it must never become
 * load-bearing.
 */
import { diffLive, type AttributeChange, type DiffLiveInput } from "./live-diff";
import { unobservedReasonText, type UnobservedReason } from "../observation";
import { renderDisruption, summarizeDisruption, type Disruption } from "./disruption";

/**
 * What the projection proposes for a single resource.
 *
 * - `create` — declared in source, and the provider **confirmed** it absent.
 * - `update` — declared and live, but live config drifted.
 * - `delete` — a chant-owned resource that is live but no longer declared.
 *   Only emitted once ownership is known (#121); never inferred from the
 *   snapshot.
 * - `adopt` — live but undeclared, ownership not established → a candidate to
 *   pull back into source, never an auto-delete.
 * - `runtime` — live but undeclared, and its owner-reference chain reaches a
 *   declared entity (#1077): a Pod a declared Deployment's controller
 *   created, for instance. Never a delete, never an adopt candidate — it is
 *   not drift, just the runtime doing its job. `runtimeOwner` names the
 *   declared entity it belongs to.
 * - `noop` — declared and live with no drift, or already reconciled.
 * - `effect` — a declared effect receipt (#1832) whose live value is absent or
 *   differs from the resolved expectation: the effect step will fire. Never a
 *   `create` or `update` — the generic apply path is observe-only to receipts,
 *   and the `effect()` step is the sole writer (epic #1703, decision 3). Read
 *   `effect` for the effect's identity and `effectReason` for why it fires.
 * - `unobserved` — declared, and the lexicon could not look (#1089). Not a
 *   proposal at all: it is the plan admitting a hole. Never a create, never a
 *   delete. Read `unobservedReason` for which hole.
 */
export type ChangeAction = "create" | "update" | "delete" | "adopt" | "runtime" | "noop" | "effect" | "unobserved";

/**
 * Why an `effect` entry proposes a fire (#1832).
 *
 * - `receipt-absent` — the provider confirmed the receipt absent: the effect
 *   has never recorded a run (or the run crashed before the write — the
 *   at-least-once case this classification exists to preserve).
 * - `receipt-stale` — the receipt is live but its value differs from the
 *   resolved expectation: the effect's inputs changed since the last run.
 * - `unresolved-input` — a reference input could not resolve at plan time, so
 *   the expectation cannot be computed. The fire is proposed rather than
 *   guessed away; the effect step resolves again at run.
 */
export type EffectFireReason = "receipt-absent" | "receipt-stale" | "unresolved-input";

/**
 * Who answers "is this resource chant's?". `unknown` until a live ownership
 * marker is queried (#120). The change set never escalates `unknown` to a
 * delete.
 */
export type Ownership = "owned" | "foreign" | "unknown";

export interface ChangeSetEntry {
  /**
   * chant entity name for a declared entity. For an undeclared live resource
   * (`adopt`, `delete`, `runtime`) this is the lexicon's live key — not an
   * IR-joinable entity name; read `physicalId` for the provider id (#1674).
   */
  name: string;
  /** Resource type, when known from either side. */
  type?: string;
  /**
   * The lexicon whose observation produced this entry (#1674). Set when the
   * change set is built for one lexicon; `lifecycle plan` merges every
   * lexicon's change set into one `entries[]`, and this is what keeps the
   * attribution through the merge.
   */
  lexicon?: string;
  /**
   * Provider-assigned physical id (ARN, resource id, pod name) from the live
   * observation's `ResourceMetadata.physicalId`, falling back to the snapshot's
   * when the resource is gone (#1674). Absent when neither side reported one.
   */
  physicalId?: string;
  action: ChangeAction;
  /** The three-way evidence the classification was derived from. */
  evidence: {
    /** Present in the current build. */
    declared: boolean;
    /** Present in the last snapshot. */
    inSnapshot: boolean;
    /** Observed present in the live system right now. */
    live: boolean;
    /**
     * The lexicon actually looked at this entity (#1089). `false` with
     * `live: false` means "unknown", not "absent" — the distinction the whole
     * change set now rests on. Absent-and-looked-at is `observed: true,
     * live: false`.
     */
    observed: boolean;
  };
  /** Attribute-level changes, for `update`. */
  deltas?: AttributeChange[];
  /** Live-marker ownership. Defaults to `unknown`. */
  ownership: Ownership;
  /** Why the entity could not be observed, for `action: "unobserved"` (#1089). */
  unobservedReason?: UnobservedReason;
  /** Human-readable backing for `unobservedReason` (the failing command, the missing binding). */
  unobservedDetail?: string;
  /**
   * The resolved address the live read was issued against (#1620), when the
   * lexicon reported one. On a `create` it says which address the provider
   * confirmed absent — the line between "not there" and "looked in the wrong
   * place" (a defaulted namespace, an endpoint override, the wrong region).
   */
  queried?: string;
  /** The declared entity this resource's owner chain resolves to, for `action: "runtime"` (#1077). */
  runtimeOwner?: string;
  /**
   * The effect a receipt witnesses (#1832), for entries derived from an effect
   * receipt. On `action: "effect"` it names what will fire; on a receipt's
   * `noop`/`unobserved` rows it keeps the attribution.
   */
  effect?: string;
  /** Why the effect fires, for `action: "effect"` (#1832). */
  effectReason?: EffectFireReason;
  /** Human-readable backing for `effectReason` (the digests that differ, the unresolved path). */
  effectDetail?: string;
  /**
   * How much applying this change hurts (#1665) — in-place / rolling / replace
   * / destroy / unknown. Set on `update` entries only: every other action
   * carries its blast radius in the action itself.
   *
   * The verdict comes from the lexicon that owns the spec
   * ({@link LexiconPlugin.classifyDisruption}), never from core, which has no
   * per-provider replacement rules and must not grow any. `unknown` is the
   * default and the only fallback — read it as "nobody could say", never as
   * "probably in place".
   */
  disruption?: Disruption;
  /** The attribute paths that forced `disruption` (#1665). */
  disruptionBecause?: string[];
  /** Human-readable backing for `disruption` — the spec knowledge behind the call, or why there is none. */
  disruptionDetail?: string;
}

export interface ChangeSet {
  env: string;
  entries: ChangeSetEntry[];
}

/**
 * Build a typed change set from the same inputs `diffLive` consumes.
 *
 * `create`/`update` are precise from declared-vs-live. `delete` is never
 * emitted here — an undeclared live resource classifies as `adopt` until
 * ownership is known.
 *
 * A declared entity the lexicon could not observe (`input.unobserved`, #1089)
 * classifies as `unobserved` and nothing else: no `create` is ever synthesized
 * from a read that did not happen.
 */
export interface ChangeSetOptions {
  /** Stamp every entry with the lexicon it was observed by (#1674). */
  lexicon?: string;
}

export function buildChangeSet(env: string, input: DiffLiveInput, options?: ChangeSetOptions): ChangeSet {
  const diff = diffLive(input);
  const { declared, observedNow } = input;
  const observedThen = input.observedThen ?? {};
  const unobservedInput = input.unobserved ?? {};

  const driftByName = new Map(
    diff.driftedSinceSnapshot.map((d) => [d.name, d.changes] as const),
  );

  const names = new Set<string>([
    ...declared,
    ...Object.keys(observedNow),
    ...Object.keys(observedThen),
    ...Object.keys(unobservedInput),
  ]);

  const entries: ChangeSetEntry[] = [];
  for (const name of names) {
    const isDeclared = declared.has(name);
    const live = Object.prototype.hasOwnProperty.call(observedNow, name);
    const inSnapshot = Object.prototype.hasOwnProperty.call(observedThen, name);
    // A returned resource was observed by definition; `unobserved` only counts
    // for entities the lexicon did not return.
    const unobservedEntry = live ? undefined : unobservedInput[name];
    const type = observedNow[name]?.type ?? observedThen[name]?.type ?? unobservedEntry?.type;
    const evidence = { declared: isDeclared, inSnapshot, live, observed: !unobservedEntry };

    // Ownership comes from the LIVE marker only (carried on observedNow), never
    // from the snapshot. This is the invariant that keeps the snapshot from
    // becoming load-bearing: a mutation decision (delete) is never made from a
    // record chant has to host.
    const ownership: Ownership = observedNow[name]?.ownership ?? "unknown";

    // Owner-reference chain (#1077), same live-only provenance as ownership
    // above. Only a `declared` root changes the classification; `unknown` is
    // deliberately not escalated (#1168's tri-state precedent — an
    // unconfirmed chain never earns the more confident verdict).
    const runtimeOwner =
      !isDeclared && observedNow[name]?.ownerChain?.root === "declared"
        ? observedNow[name]!.ownerChain!.entity
        : undefined;

    let action: ChangeAction;
    let deltas: AttributeChange[] | undefined;

    if (unobservedEntry) {
      // The lexicon never looked. Absence is not established, so neither a
      // create (declared) nor a delete/adopt (undeclared) can be proposed —
      // the entry exists to say the plan has a hole here.
      action = "unobserved";
    } else if (isDeclared && !live) {
      // Declared in source, and the provider confirmed it absent → create.
      action = "create";
    } else if (isDeclared && live) {
      const drift = driftByName.get(name);
      if (drift && drift.length > 0) {
        action = "update";
        deltas = drift;
      } else {
        action = "noop";
      }
    } else if (live && runtimeOwner) {
      // Live, undeclared, and its owner chain reaches a declared entity
      // (#1077) — expected runtime, never a delete/adopt candidate, checked
      // ahead of the ownership marker below: even a runtime child that
      // happens to carry chant's own marker (label propagation from its
      // owner's template) must never be proposed for deletion.
      action = "runtime";
    } else if (live) {
      // Live but undeclared. Only a chant-owned orphan is a safe delete; a
      // foreign or unknown orphan can be adopted but never auto-deleted.
      action = ownership === "owned" ? "delete" : "adopt";
    } else {
      // Only in the snapshot: already gone, nothing to reconcile.
      action = "noop";
    }

    // The address the read went to (#1620) — from the unobserved entry when
    // there is one, else the observation's queried map. Diagnostic only; the
    // classification above never reads it.
    const queried = unobservedEntry?.queried ?? input.queried?.[name];

    // The provider's id for the row (#1674). Live first; the snapshot's only
    // when the resource is no longer live (a snapshot-only noop).
    const physicalId = observedNow[name]?.physicalId ?? observedThen[name]?.physicalId;

    entries.push({
      name,
      type,
      ...(options?.lexicon ? { lexicon: options.lexicon } : {}),
      ...(physicalId ? { physicalId } : {}),
      action,
      evidence,
      deltas,
      ownership,
      ...(unobservedEntry
        ? {
            unobservedReason: unobservedEntry.reason,
            ...(unobservedEntry.detail ? { unobservedDetail: unobservedEntry.detail } : {}),
          }
        : {}),
      ...(queried ? { queried } : {}),
      ...(runtimeOwner ? { runtimeOwner } : {}),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { env, entries };
}

const ACTION_ORDER: ChangeAction[] = ["create", "update", "effect", "delete", "adopt", "runtime", "noop", "unobserved"];

/** Count entries per action. */
export function summarize(cs: ChangeSet): Record<ChangeAction, number> {
  const counts: Record<ChangeAction, number> = {
    create: 0,
    update: 0,
    effect: 0,
    delete: 0,
    adopt: 0,
    runtime: 0,
    noop: 0,
    unobserved: 0,
  };
  for (const e of cs.entries) counts[e.action]++;
  return counts;
}

/**
 * GitLab MR plan widget report.
 *
 * GitLab renders an `artifacts:reports:terraform` artifact in the merge-request
 * UI as "N to add, M to change, K to delete". The format is generic — any tool
 * that emits this JSON gets the widget — and the chant plan maps onto it
 * directly. Only the mutating actions count: `adopt`, `runtime`, `noop`,
 * `effect` and `unobserved` are excluded, since the widget has no column for
 * "live but undeclared", "expected runtime child" (#1077), "no change", "an
 * effect will fire" (#1832), or "could not look" (#1089). The widget is therefore a floor, not a complete plan: read
 * the full change set when entities are unobserved or classified runtime.
 *
 * The widget label reads "Terraform" regardless of producer; that is GitLab's
 * fixed string, not a claim chant makes.
 */
export interface GitlabMrReport {
  create: number;
  update: number;
  delete: number;
}

/** Project a change set onto the GitLab MR plan widget shape. Pure. */
export function gitlabMrReport(cs: ChangeSet): GitlabMrReport {
  const counts = summarize(cs);
  return { create: counts.create, update: counts.update, delete: counts.delete };
}

/**
 * Warning a plan should print when it carries a hole — a declared entity the
 * lexicon could not observe (#1089). The `--json` and `--report gitlab-mr`
 * shapes have no column for `unobserved`, so both the CLI (on stderr) and the
 * `markdown` report (in the body, since a reviewer never sees a job's stderr)
 * read this same wording rather than drifting apart. Empty when the plan has
 * no hole. Same discipline as {@link disruptionNotices} in `./disruption`.
 */
export function unobservedPlanNotice(cs: ChangeSet): string[] {
  const count = summarize(cs).unobserved;
  return count > 0
    ? [
        `${count} declared entity(ies) could not be observed — no create/update/delete is proposed for them. This plan is incomplete, not clean.`,
      ]
    : [];
}

/**
 * Section heading text for one action group — shared between {@link renderChangeSet}
 * and {@link renderChangeSetMarkdown} so the wording never drifts between the
 * terminal render and the reviewer-facing one.
 */
function actionSectionLabel(action: ChangeAction, hasDisruption: boolean): string {
  switch (action) {
    case "unobserved":
      return "UNOBSERVED (declared; chant could not read live state — no action proposed)";
    case "runtime":
      return "RUNTIME (owned by a declared resource; not drift, never a delete/adopt candidate)";
    case "effect":
      return "EFFECT (receipt absent or stale; the effect step fires — the generic apply never writes a receipt)";
    case "update":
      return hasDisruption
        ? "UPDATE (disruption from the lexicon that owns the spec; unknown means nobody could say, not that it is safe)"
        : "UPDATE";
    default:
      return action.toUpperCase();
  }
}

/** Human-readable render of a change set. Pure — returns a string. */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarize(cs);
  const header = ACTION_ORDER.map((a) => `${counts[a]} ${a}`).join(", ");
  const lines: string[] = [`Plan for ${cs.env}: ${header}`];

  // Disruption (#1665) rides the header too, so the one number that says how
  // much this plan hurts is visible without reading every row.
  const disruption = summarizeDisruption(cs);
  const disruptionParts = (Object.entries(disruption) as Array<[Disruption, number]>)
    .filter(([, n]) => n > 0)
    .map(([level, n]) => `${n} ${level}`);
  if (disruptionParts.length > 0) {
    lines.push(`Disruption: ${disruptionParts.join(", ")}`);
  }

  for (const action of ACTION_ORDER) {
    const group = cs.entries.filter((e) => e.action === action);
    if (group.length === 0) continue;
    lines.push(`\n${actionSectionLabel(action, disruptionParts.length > 0)}:`);
    for (const e of group) {
      if (e.action === "effect") {
        lines.push(
          `  effect will fire: ${e.effect ?? e.name} — receipt ${e.name}${e.type ? ` (${e.type})` : ""}` +
            `${e.effectDetail ? ` — ${e.effectDetail}` : ""}`,
        );
        continue;
      }
      const own = e.ownership === "unknown" ? "" : ` [${e.ownership}]`;
      const why = e.unobservedReason
        ? ` — ${unobservedReasonText(e.unobservedReason)}${e.unobservedDetail ? `: ${e.unobservedDetail}` : ""}`
        : "";
      const owner = e.runtimeOwner ? ` — owned by ${e.runtimeOwner}` : "";
      lines.push(`  ${e.name}${e.type ? ` (${e.type})` : ""}${own}${why}${owner}${renderDisruption(e)}`);
      const forced = new Set(e.disruptionBecause ?? []);
      for (const d of e.deltas ?? []) {
        // A path the verdict rests on is marked, so a `replace` row says which
        // of five changed properties caused it.
        lines.push(`      ${forced.has(d.path) ? "! " : ""}${d.path}: ${fmt(d.oldValue)} → ${fmt(d.newValue)}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Entries beyond this in one action group are collapsed into a `<details>`
 * block in {@link renderChangeSetMarkdown} — a group's worth of rows is fine
 * to read inline, a hundred-entry plan is not (#1983).
 */
const MARKDOWN_FOLD_THRESHOLD = 20;

/** One entry's markdown, mirroring the rows {@link renderChangeSet} prints. */
function renderMarkdownEntry(e: ChangeSetEntry): string[] {
  if (e.action === "effect") {
    return [
      `- effect will fire: \`${e.effect ?? e.name}\` — receipt \`${e.name}\`${e.type ? ` (${e.type})` : ""}` +
        `${e.effectDetail ? ` — ${e.effectDetail}` : ""}`,
    ];
  }
  const lexicon = e.lexicon ? ` \`${e.lexicon}\`` : "";
  const own = e.ownership === "unknown" ? "" : ` [${e.ownership}]`;
  const why = e.unobservedReason
    ? ` — ${unobservedReasonText(e.unobservedReason)}${e.unobservedDetail ? `: ${e.unobservedDetail}` : ""}`
    : "";
  const owner = e.runtimeOwner ? ` — owned by \`${e.runtimeOwner}\`` : "";
  // Bolded rather than the plain-text render's bare " — destroy: ..." — a
  // reviewer scanning a wall of "update" rows should see disruption without
  // reading every one (#1665).
  const disruption = e.disruption
    ? ` — **${e.disruption}**${e.disruptionDetail ? `: ${e.disruptionDetail}` : ""}`
    : "";
  const lines = [`- \`${e.name}\`${e.type ? ` (${e.type})` : ""}${lexicon}${own}${why}${owner}${disruption}`];

  if (e.deltas && e.deltas.length > 0) {
    const forced = new Set(e.disruptionBecause ?? []);
    lines.push("  ```");
    for (const d of e.deltas) {
      lines.push(`  ${forced.has(d.path) ? "! " : "  "}${d.path}: ${fmt(d.oldValue)} → ${fmt(d.newValue)}`);
    }
    lines.push("  ```");
  }
  return lines;
}

/**
 * Markdown projection of a change set (#1983) — sized for a PR/MR comment
 * rather than a terminal. A scannable counts header, entries grouped by
 * action and attributed to their lexicon, deltas in a fenced block, and any
 * group past {@link MARKDOWN_FOLD_THRESHOLD} folded into a `<details>` so a
 * large plan doesn't bury the comment. Pure — no ANSI, no I/O — and
 * deterministic: same entry ordering as {@link renderChangeSet}.
 *
 * Both a hole (#1089) and an expensive verdict (#1665) are surfaced IN the
 * body, not left to stderr the way `--json` and `--report gitlab-mr` leave
 * them: a reviewer reading a comment never sees the job's log, so a plan
 * carrying either must not read as clean.
 */
export function renderChangeSetMarkdown(cs: ChangeSet): string {
  const counts = summarize(cs);
  const lines: string[] = [`## Plan for \`${cs.env}\``, "", ACTION_ORDER.map((a) => `${counts[a]} ${a}`).join(", ")];

  const disruption = summarizeDisruption(cs);
  const disruptionParts = (Object.entries(disruption) as Array<[Disruption, number]>)
    .filter(([, n]) => n > 0)
    .map(([level, n]) => `${n} ${level}`);
  if (disruptionParts.length > 0) {
    lines.push("", `**Disruption:** ${disruptionParts.join(", ")}`);
  }

  for (const notice of unobservedPlanNotice(cs)) {
    lines.push("", `> **${notice}**`);
  }

  for (const action of ACTION_ORDER) {
    const group = cs.entries.filter((e) => e.action === action);
    if (group.length === 0) continue;

    lines.push("", `### ${actionSectionLabel(action, disruptionParts.length > 0)}`);

    const body = group.flatMap((e) => renderMarkdownEntry(e));
    if (group.length > MARKDOWN_FOLD_THRESHOLD) {
      lines.push(
        "",
        `<details><summary>${group.length} entries — click to expand</summary>`,
        "",
        ...body,
        "",
        "</details>",
      );
    } else {
      lines.push("", ...body);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function fmt(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "..." : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? json.slice(0, 57) + "..." : json;
}
