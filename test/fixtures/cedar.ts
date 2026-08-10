import { Policy, ReadAction, WriteAction } from "@intentius/chant-lexicon-cedar";

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});

export const confidentialWrite = new Policy({
  effect: "forbid",
  principal: { is: "App::User" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: ["context.mfa == true"],
});
