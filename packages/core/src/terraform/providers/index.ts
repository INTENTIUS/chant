/**
 * The carve providers core ships with (#2016). Adding a provider is a file
 * here plus a line in this list — no edit to `adopt-state.ts` or
 * `carve-emit.ts`, which resolve everything through the registry.
 *
 * This module holds no runtime dependency on `../carve-provider`, so the
 * registry can import the list without an import cycle.
 */

import { awsCarveProvider } from "./aws";
import { kubernetesCarveProvider } from "./kubernetes";
import type { CarveProvider } from "../carve-provider";

export const BUILTIN_CARVE_PROVIDERS: readonly CarveProvider[] = [awsCarveProvider, kubernetesCarveProvider];

export { awsCarveProvider, kubernetesCarveProvider };
