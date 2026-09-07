/**
 * An existing Terraform root module, joined to a chant build.
 *
 * The estate is the `terraform/` directory next to this one: ordinary HCL,
 * unmodified, still applied by `terraform apply`. chant never writes it back.
 *
 * Nothing is declared here, on purpose. The entities come from
 * `terraform.roots` in `chant.config.ts` next door: at build time the
 * lexicon's `buildRoots()` hook parses each configured root into one entity
 * per HCL block, so the post-synth checks see them and `chant lifecycle` has
 * something to key on. The serializer emits nothing for them.
 *
 * TF001 has something to say about that root: `backend "local"` keeps state
 * on the disk of whoever runs the apply, and the check reports the local
 * backend whether it is named or fallen back into (#2218). This example keeps
 * it anyway, since a remote backend would make a first run need credentials
 * and a bucket, so `terraform/main.tf` carries a
 * `# chant-ignore-block: TF001` above its terraform block with that reason.
 * An estate anyone else applies should declare a real backend instead.
 *
 * Typed source belongs in this directory once there is something to declare
 * beside the estate: the Ops that drive it (`*.op.ts`), or resources from
 * another lexicon that the Terraform root feeds.
 */
export {};
