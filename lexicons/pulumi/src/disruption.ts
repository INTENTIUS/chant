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
 * contract from a query's `previewSteps` attribute (each step's `op`,
 * `replaceReasons` and `detailedDiff`); {@link pulumiDisruptionQueries}
 * builds those queries from a `pulumi preview --json` document, one per URN.
 * A query with no steps gets no verdict, which core reads as `unknown`.
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

/** `LexiconPlugin.classifyDisruption` for pulumi. */
export function classifyPulumiDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  const out: Record<string, DisruptionVerdict> = {};
  for (const query of options.changes) {
    const raw = query.attributes?.previewSteps;
    if (!Array.isArray(raw)) continue;
    const verdict = pulumiStepsVerdict(raw.filter(isRecord) as PulumiStep[]);
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
