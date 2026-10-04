/**
 * Semantic-convention vocabularies a collector config can depend on, and how
 * to tell that it does.
 *
 * A collector config has no metadata channel, so a config cannot say which
 * semconv version its attribute keys follow. What it can show is that it uses
 * a vocabulary: a `spanmetrics` dimension named `gen_ai.request.model`, an
 * OTTL statement deleting `gen_ai.input.messages`, a `k8sattributes`
 * processor extracting `k8s.pod.name`. `semconvUsage()` finds
 * those and pairs each vocabulary with the pin this package's keys follow, the
 * same way `collectorTopology()` pairs a component type with the pin of the
 * definition this process has. Reading a parsed YAML file and reading the
 * declaration give the same answer.
 */

import { GENAI_SEMCONV_PIN, SEMCONV_PIN, type SchemaPin } from "./define";
import { SECTION_OF, type CollectorConfig, type ComponentKind } from "./model";

/** One attribute vocabulary and the version of its conventions this package follows. */
export interface SemconvVocabulary {
  /** The attribute namespace, e.g. `gen_ai`. */
  namespace: string;
  pin: SchemaPin;
  /** True when a string in a component's config refers to this namespace. */
  matches: (text: string) => boolean;
}

// `gen_ai.` as a key, in OTTL (`attributes["gen_ai.x"]`) or in an RE2 pattern (`gen_ai\.`).
const GEN_AI_REF = /(^|[^A-Za-z0-9_])gen_ai(\\\\|\\)?\./;
// `k8s.` with the dot, so the component types `k8s_cluster` and `k8sattributes` don't count.
const K8S_REF = /(^|[^A-Za-z0-9_])k8s(\\\\|\\)?\./;

export const SEMCONV_VOCABULARIES: ReadonlyArray<SemconvVocabulary> = Object.freeze([
  { namespace: "gen_ai", pin: GENAI_SEMCONV_PIN, matches: (text: string) => GEN_AI_REF.test(text) },
  { namespace: "k8s", pin: SEMCONV_PIN, matches: (text: string) => K8S_REF.test(text) },
]);

/** A vocabulary a config uses, with the components that use it. */
export interface SemconvUsage extends SchemaPin {
  namespace: string;
  /** Component ids whose config names an attribute of this namespace, in config order. */
  components: string[];
}

function mentions(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === "string") return test(value);
  if (Array.isArray(value)) return value.some((v) => mentions(v, test));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => test(k) || mentions(v, test));
  }
  return false;
}

/** The semconv vocabularies a collector config uses, each with its pin and the components that use it. */
export function semconvUsage(config: CollectorConfig): SemconvUsage[] {
  const out: SemconvUsage[] = [];
  for (const vocab of SEMCONV_VOCABULARIES) {
    const components: string[] = [];
    for (const kind of Object.keys(SECTION_OF) as ComponentKind[]) {
      for (const [id, cfg] of Object.entries(config[SECTION_OF[kind]] ?? {})) {
        if (mentions(cfg, vocab.matches)) components.push(id);
      }
    }
    if (components.length > 0) out.push({ namespace: vocab.namespace, ...vocab.pin, components });
  }
  return out;
}
