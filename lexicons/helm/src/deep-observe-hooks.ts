/**
 * The helm lexicon's deep-observation noise rules (#1247) — the k8s
 * lexicon's, by reference.
 *
 * Everything a Helm release deploys is a Kubernetes object, so the rules for
 * which fields are server-populated, which defaults are noise, which arrays
 * are sets, and which Secret paths must be masked are exactly the k8s
 * lexicon's `k8sDeepNormalizationHooks`. This is deliberately the same
 * *object*, not a copy: core applies `deepNormalizationHooks` to the
 * declared tree as well as the live one (`lexicon.ts`), and two lists would
 * drift apart the first time one gained a rule.
 *
 * Static-import safe for the same reason the k8s module is: the hooks file
 * carries no `@intentius/chant-k8s-client` dependency, so `plugin.ts` can
 * expose it as plain data without pulling the live-read machinery into the
 * build path.
 */
import { k8sDeepNormalizationHooks } from "@intentius/chant-lexicon-k8s/deep-observe-hooks";

export const helmDeepNormalizationHooks = k8sDeepNormalizationHooks;
