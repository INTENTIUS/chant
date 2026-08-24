/**
 * Receipt store seam (#1834, epic #1703) — how the `effect()` step and the
 * receipt-reading Ops reach a materialized receipt without knowing which
 * lexicon materializes it.
 *
 * The store is injectable: core defines the {@link ReceiptStore} interface and
 * the activity contracts; the receipt row's lexicon implements the store over
 * its own resource (#1835's aws row over `AWS::SSM::Parameter`) and exports
 * the bound activities (`receiptRead`, `receiptWrite`, `receiptStaleness`)
 * from its `op/activities` module via {@link receiptActivities}. The activity
 * registry then resolves them by name, exactly like `ensureSecret`
 * (#1829/#1830, provided by the k8s lexicon). Tests bind a mock store the
 * same way.
 *
 * Write discipline (epic #1703 decision log, item 3): the `effect()` step is
 * the SOLE writer of a receipt — on success of its nested steps, last. The
 * store interface carries a `write`, but only the effect step's emitted
 * read-compare-run-write (and its local-executor twin) reaches it.
 * `receiptStaleness` — the WatchOp phase (#1834) — is read-only by
 * construction: it never touches `write` and runs nothing.
 *
 * Expectation resolution follows the resolution split (decision 5): a fully
 * static receipt's expectation is stamped at synthesis and rides the step
 * data ({@link receiptCheckInput}); a hash-flavor receipt with reference
 * inputs resolves at run, through the store lexicon's
 * {@link ReceiptActivityOptions.resolveExpectation} hook — never by hashing
 * placeholders.
 */

import {
  EXISTENCE_EXPECTATION,
  isEffectReceipt,
  receiptExpectation,
  referenceInputPaths,
  type EffectReceiptDeclaration,
  type EffectReceiptFlavor,
} from "../effect-receipt";

/**
 * The serializable identity + declaration data of an effect receipt — what an
 * `effect()` step and a `receiptStaleness` check carry through codegen. Built
 * from the typed {@link EffectReceiptDeclaration} only ({@link receiptCheckInput});
 * there is no string form. Reference inputs stay in placeholder form.
 */
export interface EffectReceiptRef {
  /** The receipt's own name (the export-level identity of the witness). */
  name: string;
  /** The effect this receipt witnesses. */
  effect: string;
  /** How the receipt is compared: mere presence, or a digest of the inputs. */
  flavor: EffectReceiptFlavor;
  /** The effect's inputs as recorded at synthesis (references as placeholders). */
  inputs: Record<string, unknown>;
}

/**
 * The injectable seam over the materialized receipt (#1835 implements it for
 * SSM; tests implement it with a map). `read` returns the receipt's current
 * stored value, or `undefined` when the receipt is absent. `write` stores the
 * expectation as the new value — called only by the effect step, on success,
 * last.
 */
export interface ReceiptStore {
  read(receipt: EffectReceiptRef): Promise<string | undefined>;
  write(receipt: EffectReceiptRef, expectation: string): Promise<void>;
}

/** One receipt to check: its identity plus, when the receipt is fully static,
 * the expectation stamped at synthesis. */
export interface ReceiptCheckInput {
  receipt: EffectReceiptRef;
  /** Present when the expectation was computable at synthesis; absent when
   * reference inputs resolve at run (decision 5). */
  expectation?: string;
}

/**
 * Snapshot a typed receipt declaration into check-input data: the
 * {@link EffectReceiptRef} plus the synthesis-time expectation when the
 * receipt is fully static. Used by the `effect()` builder and by WatchOp's
 * staleness phase — the single place "static enough to hash now" is decided.
 */
export function receiptCheckInput(receipt: EffectReceiptDeclaration): ReceiptCheckInput {
  if (!isEffectReceipt(receipt)) {
    throw new Error(
      "receiptCheckInput: expected an EffectReceipt declaration — import the exported const; there is no string form",
    );
  }
  const ref: EffectReceiptRef = {
    name: receipt.name,
    effect: receipt.effect,
    flavor: receipt.flavor,
    inputs: receipt.inputs as Record<string, unknown>,
  };
  // An existence receipt's expectation is a constant, references or not; a
  // hash receipt is static only when no reference inputs remain.
  const isStatic = receipt.flavor === "existence" || referenceInputPaths(receipt).length === 0;
  return isStatic ? { receipt: ref, expectation: receiptExpectation(receipt) } : { receipt: ref };
}

// ── Activity contracts ────────────────────────────────────────────────────────

/** Args of the `receiptRead` activity, as the effect step's codegen emits them. */
export interface ReceiptReadArgs extends ReceiptCheckInput {}

/** Result of the `receiptRead` activity. `current` is `null` (not `undefined`)
 * for an absent receipt so the value survives JSON transport. */
export interface ReceiptReadResult {
  /** The receipt's live stored value, or null when absent. */
  current: string | null;
  /** The resolved expectation the workflow compares and later writes. */
  expectation: string;
  /** Convenience: `current === expectation`. */
  applied: boolean;
}

/** Args of the `receiptWrite` activity — the receipt and the resolved
 * expectation returned by the preceding `receiptRead`. */
export interface ReceiptWriteArgs {
  receipt: EffectReceiptRef;
  expectation: string;
}

/** Args of the read-only `receiptStaleness` activity (WatchOp). */
export interface ReceiptStalenessArgs {
  receipts: ReceiptCheckInput[];
}

/** One stale receipt, reported as a finding — never acted on. */
export interface ReceiptStaleFinding {
  /** The receipt's name. */
  receipt: string;
  /** The effect the receipt witnesses. */
  effect: string;
  /** `absent` — no receipt stored; `differs` — stored value is not the expectation. */
  kind: "absent" | "differs";
  /** The resolved expectation. */
  expected: string;
  /** The live stored value (present only for `differs`). */
  current?: string;
}

/** Result of the `receiptStaleness` activity. */
export interface ReceiptStalenessResult {
  stale: boolean;
  findings: ReceiptStaleFinding[];
}

/** Options for {@link receiptActivities}. */
export interface ReceiptActivityOptions {
  /**
   * Resolve a reference-carrying receipt's expectation at run (decision 5) —
   * the store lexicon's hook to deploy-time values, typically wrapping core's
   * `resolveReceiptExpectation`. Without it, a check input that carries no
   * synthesis-time expectation fails loudly rather than hashing placeholders.
   */
  resolveExpectation?: (receipt: EffectReceiptRef) => Promise<string> | string;
}

/** The three receipt activities, bound to one store. */
export interface ReceiptActivities {
  receiptRead: (args: ReceiptReadArgs, signal?: AbortSignal) => Promise<ReceiptReadResult>;
  receiptWrite: (args: ReceiptWriteArgs, signal?: AbortSignal) => Promise<{ written: true; receipt: string }>;
  receiptStaleness: (args: ReceiptStalenessArgs, signal?: AbortSignal) => Promise<ReceiptStalenessResult>;
}

/**
 * Bind the receipt activities to a store. The store's lexicon calls this once
 * and re-exports the result from its `op/activities` module; the activity
 * registry picks the functions up by name for both executors.
 */
export function receiptActivities(store: ReceiptStore, opts?: ReceiptActivityOptions): ReceiptActivities {
  const expectationOf = async (input: ReceiptCheckInput): Promise<string> => {
    if (input.expectation !== undefined) return input.expectation;
    if (input.receipt.flavor === "existence") return EXISTENCE_EXPECTATION;
    if (opts?.resolveExpectation) return await opts.resolveExpectation(input.receipt);
    throw new Error(
      `receipt "${input.receipt.name}": no synthesis-time expectation and no resolveExpectation hook — ` +
        `a hash-flavor receipt with reference inputs resolves at run (#1703 decision 5), ` +
        `and hashing placeholders would be a wrong expectation`,
    );
  };

  return {
    async receiptRead(args: ReceiptReadArgs): Promise<ReceiptReadResult> {
      const expectation = await expectationOf(args);
      const current = await store.read(args.receipt);
      return { current: current ?? null, expectation, applied: current === expectation };
    },

    async receiptWrite(args: ReceiptWriteArgs): Promise<{ written: true; receipt: string }> {
      await store.write(args.receipt, args.expectation);
      return { written: true, receipt: args.receipt.name };
    },

    // Read-only: reads and reports, runs nothing, never writes.
    async receiptStaleness(args: ReceiptStalenessArgs): Promise<ReceiptStalenessResult> {
      const findings: ReceiptStaleFinding[] = [];
      for (const input of args.receipts) {
        const expected = await expectationOf(input);
        const current = await store.read(input.receipt);
        if (current === undefined) {
          findings.push({ receipt: input.receipt.name, effect: input.receipt.effect, kind: "absent", expected });
        } else if (current !== expected) {
          findings.push({ receipt: input.receipt.name, effect: input.receipt.effect, kind: "differs", expected, current });
        }
      }
      return { stale: findings.length > 0, findings };
    },
  };
}
