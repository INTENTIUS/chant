/**
 * Pilot pair: JAR producer -> EMR consumer, cross-component artifact outputs
 * (#561, epic #551).
 *
 * This is the epic's worked example for cross-component wiring (#551
 * §"Cross-component outputs", docs/components/composition-and-wiring.mdx
 * §"Cross-component outputs"): a **producer-library** component
 * (`jar-lib`) that only builds and publishes an artifact — no apply, no
 * service — paired with an **infra** consumer (`emr-job`) that submits an
 * EMR job run against the producer's published S3 URI.
 *
 * The wiring itself needs no new machinery: `dependsOn: ["jar-lib"]` orders
 * the producer first (`resolveComponentGraph`, ../driver.ts), and
 * `"@jar-lib.publish.uri"` is the same `@<component>.publish.uri|digest|key`
 * reference form `resolveWiring` (../driver.ts) already resolves generically
 * from `componentOutputs`, which `runComponentDeploy` already populates from
 * any step whose output carries `uri`/`digest`/`key` (`findPublishOutput`) —
 * both landed with #556/#560 and are exercised by ../driver.test.ts's
 * "wires a cross-component artifact reference" case. What #561 actually adds
 * is: this pair authored as real typed `Component`s (rather than only the
 * hand-written JSON fixtures), and a real `emr-start-job-run`/`wait-job`
 * capability implementation (../verbs/job-submission.ts,
 * ../verbs/wait-verify.ts) so the pair runs to completion against a mocked
 * `CloudExecutor` instead of throwing `CapabilityNotImplementedError`.
 *
 * The JSON projections of these two components are authoritative at
 * ../__fixtures__/jar-lib-producer.json and
 * ../__fixtures__/emr-job-consumer.json (pre-existing, from #560) — this
 * module is the real typed `Component` authoring form that composes to those
 * same documents; see ./pilots.test.ts, which asserts the two never diverge.
 */

import type { Component } from "../component";
import { phase } from "../component";

/** Producer: a JAR built from a Maven project, published to S3. Publish-only deploy — no apply phase at all, the defining shape of the `producer-library` archetype. */
export const jarLib: Component = {
  name: "jar-lib",
  archetype: "producer-library",
  dependsOn: [],
  build: { kind: "jvm-build", context: ".", into: "archive" },
  deploy: [
    // → @jar-lib.publish.uri / @jar-lib.publish.digest, resolved by the graph
    // for any downstream consumer — never known by this component itself.
    phase("Publish", [{ kind: "publish-artifact", from: "archive", to: "$env.s3" }]),
  ],
};

/** Consumer: an EMR job run reading the producer's published JAR by S3 URI. `dependsOn: ["jar-lib"]` orders the producer first; the graph resolves the reference into the Submit step. */
export const emrJob: Component = {
  name: "emr-job",
  archetype: "infra",
  dependsOn: ["jar-lib"],
  deploy: [
    phase("Submit", [
      {
        kind: "emr-start-job-run",
        jar: "@jar-lib.publish.uri",
        args: ["--input", "$env.inputPath", "--output", "$env.outputPath"],
      },
    ]),
    phase("Verify", [{ kind: "wait-job", runId: "@Submit.runId" }]),
  ],
};
