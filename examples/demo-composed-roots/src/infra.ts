/**
 * Nothing is declared here. The entities come from `terraform.roots` in
 * `chant.config.ts`: at build time the terraform lexicon parses each root
 * under `roots/` into one entity per HCL block, so the post-synth checks see
 * them. The serializer emits nothing for them.
 */
export {};
