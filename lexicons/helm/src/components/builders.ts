/**
 * Typed step-builders for the helm lexicon's verbs — the same ergonomic
 * sugar the aws and k8s lexicons' `components/builders.ts` offer (#658),
 * reusing the exported `step` projection from `@intentius/chant/components`.
 * No `noRollback` admission here, unlike `kubectlApply`: `helm-upgrade`
 * carries a native rollback, so COMP003 never asks for the opt-out.
 */
import { step } from "@intentius/chant/components";
import type { HelmUpgradeInput } from "./helm-upgrade";

export const helmUpgrade = step<HelmUpgradeInput>("helm-upgrade");
