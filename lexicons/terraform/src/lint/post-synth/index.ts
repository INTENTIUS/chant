import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { tf001 } from "./tf001";

export { tf001 } from "./tf001";

/** All post-synth checks provided by this lexicon (returned by plugin.postSynthChecks()). */
export const postSynthChecks: PostSynthCheck[] = [tf001];
