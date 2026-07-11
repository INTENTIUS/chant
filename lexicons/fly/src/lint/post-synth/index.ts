import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { fly010 } from "./fly010-machine-requires-image";

export { fly010 } from "./fly010-machine-requires-image";

/** All post-synth checks provided by the fly lexicon. */
export const postSynthChecks: PostSynthCheck[] = [fly010];
