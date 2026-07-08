/**
 * AWS Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `aws` lexicon. Contributes the local Floci AWS
 * emulator lifecycle (`flociUp`/`flociDown`).
 */
export {
  flociUp,
  flociDown,
  flociRunCommand,
  flociRmCommand,
  flociExistsCommand,
  flociHealthUrl,
  flociEnv,
  isFlociReady,
} from "./floci";
export type { FlociUpArgs, FlociDownArgs } from "./floci";
