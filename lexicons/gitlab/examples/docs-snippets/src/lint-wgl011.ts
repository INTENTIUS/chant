import * as _ from "./_";

// chant-disable-next-line WGL011
export const noop = new _.Job({
  script: ["echo unreachable"],
  rules: [
    new _.Rule({ ifCondition: _.CI.CommitBranch, when: "never" }),
    new _.Rule({ ifCondition: _.CI.CommitTag, when: "never" }),
  ],
});
