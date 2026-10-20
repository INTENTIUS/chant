#!/usr/bin/env tsx
/** `npm run generate` for the e2b lexicon: writes the post-synth barrel. */
import { generate } from "./generate";

console.error(`Generated the e2b post-synth barrel: ${generate()} checks`);
