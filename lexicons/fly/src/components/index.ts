/**
 * The fly lexicon's component/release surface: the `run-agent` capability,
 * its real `SpriteActivities` adapter, and the `flyCapabilityPlugin` core
 * loads when a project declares `lexicons: ["fly"]` (#1942). Component
 * authors reach these from `@intentius/chant-lexicon-fly/components`, the way
 * AWS and helm verbs come from their lexicons' `/components` entries.
 */
export { flyCapabilityPlugin, FLY_VERB_FAMILIES } from "./capability-plugin";
export {
  flyRunAgentCapability,
  createFlyRunAgentCapability,
  createFlySpriteActivities,
  parseSpriteExecFailure,
} from "./run-agent";
