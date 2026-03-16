import { Job, Rule, CI } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL011
export const noop = new Job({
  script: ["echo unreachable"],
  rules: [
    new Rule({ if: CI.CommitBranch, when: "never" }),
    new Rule({ if: CI.CommitTag, when: "never" }),
  ],
});
