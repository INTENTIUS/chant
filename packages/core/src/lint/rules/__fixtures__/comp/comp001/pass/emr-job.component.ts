import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** Consumer that references jar-lib's published artifact — makes jar-lib's publish step "consumed" for COMP001. */
export const emrJob: Component = {
  name: "emr-job",
  archetype: "infra",
  dependsOn: ["jar-lib"],
  deploy: [
    phase("Submit", [{ kind: "emr-start-job-run", jar: "@jar-lib.publish.uri", args: ["--input", "$env.inputPath"] }]),
    phase("Verify", [{ kind: "wait-job", runId: "@Submit.runId" }]),
  ],
};
