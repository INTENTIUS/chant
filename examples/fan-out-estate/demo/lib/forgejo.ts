/**
 * The forge, for real: the demo's Forgejo, through its REST API and git over
 * http, as three people. It is the e2e harness's ForgejoForge (chant#4587)
 * on the demo repo, chant-demo/fan-out-estate, with every git command kept
 * outside the chant checkout. The author pushes, opens and merges; the
 * reviewer approves; the admin forces main back to the base and deletes
 * branches at a reset.
 */
import { ForgejoForge as HarnessForgejo, type ForgejoOptions as HarnessOptions } from "../../../../packages/core/src/e2e-harness/forgejo.js";
import { REPO } from "../steps.js";
import { CHECKOUT } from "./git.js";

export { forgejoApi, type Person } from "../../../../packages/core/src/e2e-harness/forgejo.js";

export type ForgejoOptions = Omit<HarnessOptions, "repo" | "checkout" | "emailDomain">;

export class ForgejoForge extends HarnessForgejo {
  constructor(o: ForgejoOptions) {
    super({ ...o, repo: REPO, checkout: CHECKOUT, emailDomain: "chant-demo.local" });
  }
}
