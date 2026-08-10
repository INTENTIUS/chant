/**
 * The smallest useful Cedar policy set: one permit, one forbid.
 *
 * `Policy` and `ReadAction` are generated from the schema (`chant generate`),
 * so the action name is checked at compile time rather than at validation time.
 * See ../../basic-policies for the same idea with a project-local schema.
 */

import { Policy, ReadAction } from "@intentius/chant-lexicon-cedar";

/** Users read documents they own. */
export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});

/** Nothing confidential is readable without MFA. */
export const requireMfa = new Policy({
  effect: "forbid",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: ["context.mfa == true"],
});
