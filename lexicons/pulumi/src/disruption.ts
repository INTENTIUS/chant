/**
 * `classifyDisruption` for pulumi (#5338): what applying a planned update
 * costs, from a preview's steps.
 *
 * The preview says it in its ops. An `update` step is a change in place. A
 * replacement is `create-replacement`, `replace` and `delete-replaced` on one
 * URN, and the order says which kind: the delete after the create is a
 * replacement made first, the delete before it (`deleteBeforeReplace`) is a
 * window with nothing there. A `delete` step removes the resource.
 * `replaceReasons` and a `detailedDiff` kind ending in `-replace` name the
 * properties that forced the replacement.
 *
 * | steps on one URN | disruption |
 * |---|---|
 * | `update` | `in-place` |
 * | `create-replacement` before `delete-replaced`, or `replace` alone | `replace` |
 * | `delete-replaced` before `create-replacement` | `destroy` |
 * | `import-replacement` | `replace` |
 * | `delete` | `destroy` |
 *
 * The table is the change set adapter's, `pulumiStepsAction` in
 * `./change-set.ts`, so the two agree. The classifier answers through core's
 * contract from one of two attribute shapes:
 *
 * - `previewSteps` (each step's `op`, `replaceReasons` and `detailedDiff`),
 *   which {@link pulumiDisruptionQueries} builds from a `pulumi preview
 *   --json` document, one query per URN.
 * - `planActions` and `planReplacePaths`, the attributes the preview depth of
 *   `describeResources` writes on a node (`./preview-observation.ts`). The
 *   ops of `planActions[urn]` keep the preview's order, so they run through
 *   the same table; `planReplacePaths` names what forced a replacement.
 *
 * `previewSteps` wins when a query carries both. A query with neither gets no
 * verdict, which core reads as `unknown`.
 */
import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lexicon";
import { pulumiSteps, pulumiStepsAction, type PulumiStep } from "./change-set";

const DETAIL: Record<string, string> = {
  "in-place": "the preview updates it in place",
  replace: "the preview creates a replacement, then deletes the old one",
  destroy: "the preview deletes it before anything replaces it",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The properties that forced a replacement, from the steps' `replaceReasons` and `-replace` diff kinds. */
function forcing(steps: PulumiStep[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    for (const r of s.replaceReasons ?? []) out.add(r);
    for (const [path, d] of Object.entries(s.detailedDiff ?? {})) {
      if (typeof d?.kind === "string" && d.kind.endsWith("-replace")) out.add(path);
    }
  }
  return [...out].sort();
}

/** The verdict one URN's steps mean, or undefined for steps that change nothing existing. */
export function pulumiStepsVerdict(steps: PulumiStep[]): DisruptionVerdict | undefined {
  const mapped = pulumiStepsAction(steps);
  const disruption = mapped?.disruption;
  if (!disruption || !(disruption in DETAIL)) return undefined;
  const because = disruption === "in-place" ? [] : forcing(steps);
  return {
    disruption,
    ...(because.length > 0 ? { because } : {}),
    detail: because.length > 0 ? `${DETAIL[disruption]}; ${because.join(", ")} forced it` : DETAIL[disruption]!,
  };
}

const RANK: Record<string, number> = { "in-place": 0, replace: 1, destroy: 2 };

/** One attribute off the query: its observed value, else the new value of a delta on it. */
function attribute(query: DisruptionQuery, key: string): unknown {
  if (query.attributes && key in query.attributes) return query.attributes[key];
  return query.deltas.find((d) => d.path === `attributes.${key}`)?.newValue;
}

/** The verdict a preview node's `planActions` and `planReplacePaths` mean, or undefined when it carries no plan. */
function planVerdict(query: DisruptionQuery): DisruptionVerdict | undefined {
  const planActions = attribute(query, "planActions");
  if (!isRecord(planActions)) return undefined;
  let worst: DisruptionVerdict | undefined;
  for (const ops of Object.values(planActions)) {
    if (!Array.isArray(ops)) continue;
    const verdict = pulumiStepsVerdict(ops.filter((op): op is string => typeof op === "string").map((op) => ({ op }) as PulumiStep));
    if (verdict && (!worst || RANK[verdict.disruption]! > RANK[worst.disruption]!)) worst = verdict;
  }
  if (!worst) return undefined;
  const paths = attribute(query, "planReplacePaths");
  const because = worst.disruption !== "in-place" && Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (because.length === 0) return worst;
  return { disruption: worst.disruption, because, detail: `${DETAIL[worst.disruption]}; ${because.join(", ")} forced it` };
}

/** `LexiconPlugin.classifyDisruption` for pulumi. */
export function classifyPulumiDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  const out: Record<string, DisruptionVerdict> = {};
  for (const query of options.changes) {
    const raw = query.attributes?.previewSteps;
    const verdict = Array.isArray(raw) ? pulumiStepsVerdict(raw.filter(isRecord) as PulumiStep[]) : planVerdict(query);
    if (verdict) out[query.name] = verdict;
  }
  return out;
}

/**
 * The queries a `pulumi preview --json` document holds: one per URN whose
 * steps update, replace or delete something, named by the URN, with its
 * steps' `op`, `replaceReasons` and `detailedDiff` as `previewSteps`.
 */
export function pulumiDisruptionQueries(preview: unknown): DisruptionQuery[] {
  const byUrn = new Map<string, PulumiStep[]>();
  for (const s of pulumiSteps(preview) ?? []) {
    const list = byUrn.get(s.urn!) ?? [];
    list.push(s);
    byUrn.set(s.urn!, list);
  }
  const out: DisruptionQuery[] = [];
  for (const [urn, steps] of byUrn) {
    if (!pulumiStepsAction(steps)?.disruption) continue;
    const type = steps.map((s) => s.newState?.type ?? s.oldState?.type).find((t): t is string => typeof t === "string");
    out.push({
      name: urn,
      ...(type ? { type } : {}),
      deltas: [],
      attributes: {
        previewSteps: steps.map((s) => ({
          op: s.op,
          ...(s.replaceReasons ? { replaceReasons: s.replaceReasons } : {}),
          ...(s.detailedDiff ? { detailedDiff: s.detailedDiff } : {}),
        })),
      },
    });
  }
  return out;
}
