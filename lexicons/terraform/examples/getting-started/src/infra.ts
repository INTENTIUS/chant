/**
 * An existing Terraform root module, joined to a chant build.
 *
 * The estate is the `terraform/` directory next to this one: ordinary HCL,
 * unmodified, still applied by `terraform apply`. chant never writes it back.
 *
 * Nothing is declared here, on purpose. The entities come from
 * `terraform.roots` in `chant.config.ts` next door: at build time the
 * lexicon's `buildRoots()` hook parses each configured root into one entity
 * per HCL block, so the post-synth checks see them (TF001 passes here because
 * the root declares a `backend "local"`) and `chant lifecycle` has something
 * to key on. The serializer emits nothing for them.
 *
 * Typed source belongs in this directory once there is something to declare
 * beside the estate: the Ops that drive it (`*.op.ts`), or resources from
 * another lexicon that the Terraform root feeds.
 */
export {};
