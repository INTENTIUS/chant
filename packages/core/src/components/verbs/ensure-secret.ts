/**
 * secrets family — `ensure-secret` (#1829, epic #1365 decision 3). The
 * capability surface over the one generated-once materialization engine
 * (../../secret-materialization.ts); the op step builder `ensureSecret(...)`
 * (../../op/builders.ts) is the other surface over the same engine.
 *
 * Contract (read-then-write): present means done. The verb never mints over
 * an existing value and never rotates implicitly; an existing secret that
 * does not match the declared key-set/metadata stops the apply with a
 * `SecretContractMismatchError` naming key names and metadata keys — never
 * values. There is no safe undo for minting a secret others may already have
 * consumed, and un-creating it would destroy the only copy of the material —
 * so `rollbackPolicy: "needs-opt-out"`: COMP003 requires a component using
 * this verb to acknowledge the compensation gap explicitly.
 *
 * The store adapter is per-provider (#1830 is the k8s row). Core registers a
 * typed stub; a provider builds the real capability with
 * {@link createEnsureSecretCapability}.
 */

import type { Capability } from "../capability";
import { CapabilityNotImplementedError } from "../capability";
import {
  ensureSecretMaterialization,
  defaultSecretMaterialGenerator,
  type EnsureSecretOutcome,
  type SecretMaterialGenerator,
  type SecretStoreAdapter,
} from "../../secret-materialization";

export interface EnsureSecretInput {
  /** The secret's name as the store knows it. */
  name: string;
  /** The declared key-set. Creation mints one value per key; verification compares names only. */
  keys: string[];
  /** Declared metadata an existing secret must carry. Mismatches are reported by KEY. */
  metadata?: Record<string, string>;
}

/** Names only — no field of the output can carry material. */
export type EnsureSecretOutput = EnsureSecretOutcome;

/**
 * Build the real `ensure-secret` capability over a provider's
 * {@link SecretStoreAdapter}. The generator seam defaults to 32 CSPRNG bytes
 * per key; the material it mints flows straight through the adapter to the
 * store and is never returned, logged, or retained (see
 * ../../secret-materialization.ts).
 */
export function createEnsureSecretCapability(deps: {
  store: SecretStoreAdapter;
  generator?: SecretMaterialGenerator;
}): Capability<EnsureSecretInput, EnsureSecretOutput> {
  return {
    kind: "ensure-secret",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      return ensureSecretMaterialization(
        deps.store,
        { name: input.name, keys: input.keys, metadata: input.metadata },
        deps.generator ?? defaultSecretMaterialGenerator,
      );
    },
  };
}

/**
 * The starter-set registration: fully typed, correct `rollbackPolicy` for
 * COMP003, but no store adapter — running it throws
 * `CapabilityNotImplementedError` until a provider row (#1830, k8s) wires a
 * real adapter via {@link createEnsureSecretCapability}.
 */
export const ensureSecretCapability: Capability<EnsureSecretInput, EnsureSecretOutput> = {
  kind: "ensure-secret",
  rollbackPolicy: "needs-opt-out",
  async run(): Promise<EnsureSecretOutput> {
    throw new CapabilityNotImplementedError("ensure-secret");
  },
};
