/**
 * Push this checkout's chant/lifecycle to its remote, replaying it on the
 * remote's tip when another writer pushed first (#5137).
 *
 * `chant release cut` pushes the ledger itself, but `chant workspace train
 * <env>` only records the train locally. `just release` runs this after
 * recording a train, before it pushes the release-train tag, so publish.yml
 * finds the train when it reads chant/lifecycle. Exits 1 when the push does
 * not land.
 */

import { pushLifecycleRebasing } from "../packages/core/src/lifecycle/git";

try {
  const r = await pushLifecycleRebasing({ requireLanded: true });
  if (r.pushWarning) console.error(`release-push-ledger: ${r.pushWarning}`);
  if (!r.pushed) {
    console.error("release-push-ledger: chant/lifecycle was not pushed");
    process.exit(1);
  }
} catch (err) {
  console.error(`release-push-ledger: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
