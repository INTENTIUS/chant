/**
 * The rule that used to be a gate.
 *
 * Publishing the three regional UIs waits on one thing chant cannot do:
 * somebody delegating `east`/`central`/`west` at the registrar, using the
 * nameservers `crdb-publish-ui` prints. That used to be a `gate` inside
 * `crdb-publish-ui` — a wait held open for up to 72 hours, released by a
 * signal somebody had to remember to send after they had already done the
 * work at the registrar.
 *
 * It is a rule now. Every quarter hour the tick observes the estate: while
 * the UI stack is short of what `src/*` declares — no certificate, no
 * ingress backend, nothing serving — the `updateCount` is non-zero and the
 * rule dispatches `crdb-publish-ui`. Before delegation that dispatch fails
 * on the certificate wait, honestly and cheaply, and the tick records it.
 * The first tick after the NS records propagate is the one that goes green.
 * Nobody sends a signal; the delegation itself is the signal.
 *
 * `dial: "apply"` is the authority this needs and no more: OPS014 refuses a
 * mutating dispatch under any lower dial, and refuses a destructive target
 * under every dial. `crdb-publish-ui` is neither destructive nor gated — it
 * waits and verifies — which is what makes it a legal thing for an
 * unattended tick to run.
 *
 *   chant run crdb-ui-converge                 # one tick, here
 *   chant run crdb-ui-converge --on fountain   # on the steward's thread
 */

import { ConvergeOp, gt, run, when } from "@intentius/chant/op";

export const { op } = ConvergeOp({
  name: "crdb-ui-converge",
  env: "prod",
  dial: "apply",
  schedule: "*/15 * * * *",
  // One dispatch per tick. The op it dispatches waits up to 45 minutes on a
  // certificate, so a second attempt inside the same tick would buy nothing.
  budget: 1,
  rules: [
    when(gt("updateCount", 0), run("crdb-publish-ui"), {
      id: "ui-unpublished",
      why:
        "The UI ingresses and their managed certificates are declared but not yet live, which is what a " +
        "pending update against prod means here. Google cannot issue a certificate until the three " +
        "subdomains are delegated at the registrar, so this dispatch fails on the certificate wait until " +
        "that happens and succeeds on the first tick after it does — no gate to release, and no one to " +
        "remember releasing it.",
    }),
  ],
});

export default op;
