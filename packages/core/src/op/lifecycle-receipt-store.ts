/**
 * A receipt store on the `chant/lifecycle` branch (#2736, ws-056).
 *
 * The aws and k8s rows keep receipts in the cloud they deploy to (an SSM
 * parameter, a ConfigMap). A target with no store of its own, such as a Fly
 * Machine, keeps them next to the release ledger instead: one file per receipt
 * at `<env>/receipts/<name>.receipt` on the lifecycle branch, written through
 * the same plumbing as the release and build ledgers (../lifecycle/git.ts), so
 * a workspace member's receipts land under its own `_members/<member>/` prefix.
 *
 * The receipt is per environment, not per checkout: every checkout that
 * fetches the branch sees which effects have fired there. Writing is local;
 * the ledger push that follows a recorded release (or `chant lifecycle push`)
 * carries it to the remote.
 */

import { readBlobFromPath, writeBlobToPath } from "../lifecycle/git";
import type { EffectReceiptRef, ReceiptStore } from "./receipt-store";

/** Options for {@link lifecycleReceiptStore}. */
export interface LifecycleReceiptStoreOptions {
  /** The environment whose ledger directory holds the receipts. Omitted, `CHANT_ENV` answers. */
  environment?: string;
  /** The checkout whose lifecycle branch is written. Defaults to the working directory. */
  cwd?: string;
  /** Environment record the `CHANT_ENV` fallback reads. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** The file name a receipt is kept under: its name with anything outside `[A-Za-z0-9_.-]` replaced. */
export function lifecycleReceiptFile(name: string): string {
  return `receipts/${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.receipt`;
}

/**
 * A {@link ReceiptStore} over the lifecycle branch. The environment is resolved
 * at first use, so constructing the store reads nothing; with none given and no
 * `CHANT_ENV`, a read or write fails rather than guessing a directory.
 */
export function lifecycleReceiptStore(options: LifecycleReceiptStoreOptions = {}): ReceiptStore {
  const environment = (): string => {
    const env = options.environment ?? (options.env ?? process.env).CHANT_ENV;
    if (!env) {
      throw new Error(
        "lifecycle receipt store: no environment. Receipts are kept per environment on chant/lifecycle; " +
          "run with --env <name>, set CHANT_ENV, or pass the environment explicitly.",
      );
    }
    return env;
  };
  const opts = options.cwd ? { cwd: options.cwd } : undefined;
  return {
    async read(receipt: EffectReceiptRef): Promise<string | undefined> {
      const content = await readBlobFromPath(environment(), lifecycleReceiptFile(receipt.name), opts);
      return content === null ? undefined : content.trim();
    },
    async write(receipt: EffectReceiptRef, expectation: string): Promise<void> {
      await writeBlobToPath(environment(), lifecycleReceiptFile(receipt.name), `${expectation}\n`, `Receipt ${receipt.name}`, opts);
    },
  };
}
