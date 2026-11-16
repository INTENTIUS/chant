import type { SkillDefinition } from "@intentius/chant/lexicon";

/** The skills the prow lexicon gives an agent. */
export const prowSkills: SkillDefinition[] = [
  {
    name: "chant-prow",
    description: "Declare Prow presubmits, postsubmits and periodics with chant, build the job config and keep credentials off pull request code",
    content: `# Prow jobs with chant

Declare each job with \`Presubmit\`, \`Postsubmit\` or \`Periodic\` from
\`@intentius/chant-lexicon-prow\`. A presubmit or postsubmit names its
repository with \`repo\` (owner/name); a periodic names a schedule with
\`interval\` or \`cron\`, and its repository with \`extra_refs\`.

\`\`\`ts
import { Presubmit } from "@intentius/chant-lexicon-prow";

export const unit = new Presubmit({
  repo: "acme/app",
  name: "pull-app-unit",
  always_run: true,
  decorate: true,
  spec: { automountServiceAccountToken: false, containers: [{ name: "test", image: "golang:1.26", command: ["go", "test", "./..."] }] },
});
\`\`\`

- \`npx chant build src -o prow/jobs.yaml\` writes the job config Prow loads.
- \`npx chant import prow/jobs.yaml\` turns an existing job config into declarations.
- \`npx chant lint src\` runs the PROW rules. PROW101 to PROW103 and PROW106 are what Prow's loader refuses. PROW104 flags a presubmit that mounts a credential, and PROW105 a presubmit on a cluster where other jobs hold credentials, since a pull request's code runs there.
- Export the jobs in one array to keep their order in the file.
`,
    triggers: [
      { type: "file-pattern", value: "**/prow/**/*.yaml" },
      { type: "context", value: "prow" },
    ],
  },
];
