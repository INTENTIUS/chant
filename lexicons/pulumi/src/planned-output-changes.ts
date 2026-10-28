/**
 * Which of a stack's outputs its preview changes (#4635). A real `pulumi
 * preview --json` plans no stack outputs (recorded, #4475), so until this
 * module every output of a stack with any change was unknown, and every
 * stack reading any of them waited for the `up`. Here each output the last
 * deployment holds is traced, by value, to the resource properties in the
 * export that hold the same value, and the preview's entry for each such
 * resource says whether the value can move:
 *
 * | the resource's entry | the property | verdict |
 * |---|---|---|
 * | replace, delete, or a `mayAppear` update | any | changes |
 * | update | an input the diff names, or one that is unknown | changes |
 * | update | an input the diff leaves alone; `id`, `arn` or `urn` | stable |
 * | update | any other output (a provider-computed `version`) | may change |
 * | no-op, read, or no entry in a targeted preview | any | stable |
 *
 * An output is changing when one of its matches changes, or when every
 * match only may change; it is unchanged, with the export's value, when no
 * match changes and one is stable. An output no property matches (one the
 * program computed, such as `` `${bucket.arn}/*` ``), or an object, is
 * untraced, and so unknown while the stack has changes. A list traces each
 * string in it. Strings shorter than four characters match nothing, so a
 * `"1"` or a `"true"` traces no output. Secret outputs are left out, as
 * everywhere: chant reads outputs blind.
 *
 * The trace runs only when the preview plans no stack outputs and has
 * changes; core's `member-outputs` and `pulumi-up`'s plan then take its
 * unchanged outputs as known and the rest as unknown, so a stack reading
 * through `StackReference` (#4547) an output the change moves is held until
 * the producer applied and the reader is previewed again, and one reading
 * only unchanged outputs plans now.
 */
import type { ChangeSetEntry, ChangeSetPart } from "@intentius/chant/change-set";
import { isPulumiNodeless } from "@intentius/chant/pulumi-urn";
import { pulumiExportedStackOutputs } from "./stack-outputs";
import { isObject, isSecret } from "./values";

/** One output's verdict, and the resource property that decided it. */
export interface PulumiOutputChange {
  output: string;
  verdict: "changing" | "unchanged" | "untraced";
  /** The deciding match: `<urn tail>.<property>` and the resource's action. Absent when untraced. */
  because?: string;
}

/** The trace of every output the export holds that is not secret, by name. */
export interface PulumiPlannedOutputChanges {
  outputs: PulumiOutputChange[];
  /** Unchanged outputs with the export's value. */
  known: Record<string, unknown>;
  /** Changing and untraced outputs. */
  unknown: string[];
}

/** Properties that stay put through an in-place update. */
const STABLE_OUTPUTS = new Set(["id", "arn", "urn"]);

type Verdict = "changes" | "stable" | "maybe";

interface Holder {
  urn: string;
  prop: string;
  input: boolean;
}

const tailOf = (urn: string): string => urn.split("::").slice(2).join("::") || urn;

/** Every (resource, property) of the export holding a string worth matching, by value. */
function holdersByValue(exported: unknown): Map<string, Holder[]> {
  const deployment = isObject(exported) && isObject(exported.deployment) ? exported.deployment : {};
  const resources = Array.isArray(deployment.resources) ? deployment.resources : [];
  const by = new Map<string, Holder[]>();
  const add = (value: unknown, h: Holder) => {
    if (typeof value !== "string" || value.length < 4) return;
    const list = by.get(value) ?? [];
    list.push(h);
    by.set(value, list);
  };
  for (const r of resources) {
    if (!isObject(r) || typeof r.urn !== "string" || typeof r.type !== "string") continue;
    if (r.custom !== true || isPulumiNodeless(r.type)) continue;
    const inputs = isObject(r.inputs) ? r.inputs : {};
    add(r.id, { urn: r.urn, prop: "id", input: false });
    for (const [k, v] of Object.entries(isObject(r.outputs) ? r.outputs : {})) {
      if (isSecret(v)) continue;
      add(v, { urn: r.urn, prop: k, input: k in inputs });
    }
  }
  return by;
}

function verdictOf(h: Holder, entry: ChangeSetEntry | undefined, targeted: boolean): Verdict {
  if (!entry) return targeted ? "stable" : "changes";
  if (entry.mayAppear === true || entry.action === "replace" || entry.action === "delete" || entry.action === "forget") return "changes";
  if (entry.action !== "update") return "stable";
  const attr = entry.attributes.find((a) => a.path === h.prop);
  if (attr) return "changes";
  if (h.input || STABLE_OUTPUTS.has(h.prop)) return "stable";
  return "maybe";
}

/**
 * Trace each of the export's stack outputs through the member's part (the
 * change set its preview became). `targeted` says the preview was narrowed
 * with `--target`, so a resource it did not list is not touched by it.
 */
export function pulumiPlannedOutputChanges(input: { part: ChangeSetPart; exported: unknown; targeted?: boolean }): PulumiPlannedOutputChanges {
  const byUrn = new Map<string, ChangeSetEntry>();
  for (const e of input.part.entries) if (!byUrn.has(e.address)) byUrn.set(e.address, e);
  const holders = holdersByValue(input.exported);
  const targeted = input.targeted === true;

  const traceString = (value: string): { verdict: PulumiOutputChange["verdict"]; because?: string } => {
    const list = holders.get(value) ?? [];
    if (list.length === 0) return { verdict: "untraced" };
    const judged = list.map((h) => ({ h, v: verdictOf(h, byUrn.get(h.urn), targeted), action: byUrn.get(h.urn)?.action ?? "unlisted" }));
    const why = (j: (typeof judged)[number]) => `${tailOf(j.h.urn)}.${j.h.prop} (${j.action})`;
    const changes = judged.find((j) => j.v === "changes");
    if (changes) return { verdict: "changing", because: why(changes) };
    const stable = judged.find((j) => j.v === "stable");
    if (stable) return { verdict: "unchanged", because: why(stable) };
    return { verdict: "changing", because: why(judged[0]!) };
  };

  const outputs: PulumiOutputChange[] = [];
  const known: Record<string, unknown> = {};
  for (const o of pulumiExportedStackOutputs(input.exported)) {
    if (o.secret) continue;
    let traced: { verdict: PulumiOutputChange["verdict"]; because?: string };
    if (typeof o.value === "string") traced = traceString(o.value);
    else if (Array.isArray(o.value) && o.value.length > 0 && o.value.every((v) => typeof v === "string")) {
      const each = (o.value as string[]).map(traceString);
      traced = each.find((t) => t.verdict === "changing") ?? each.find((t) => t.verdict === "untraced") ?? each[0]!;
    } else traced = { verdict: "untraced" };
    outputs.push({ output: o.name, verdict: traced.verdict, ...(traced.because ? { because: traced.because } : {}) });
    if (traced.verdict === "unchanged") known[o.name] = o.value;
  }
  outputs.sort((a, b) => (a.output < b.output ? -1 : a.output > b.output ? 1 : 0));
  return { outputs, known, unknown: outputs.filter((o) => o.verdict !== "unchanged").map((o) => o.output) };
}
