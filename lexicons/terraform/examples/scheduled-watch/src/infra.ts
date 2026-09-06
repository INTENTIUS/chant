/**
 * The estate is the `terraform/` directory beside this one, joined to the
 * build through `terraform.roots` in `chant.config.ts`, the same arrangement
 * `examples/getting-started` explains at length.
 *
 * Nothing is declared here. The Op that watches the root lives in `ops/`,
 * which is where chant looks for `*.op.ts` (`chant run <name>` and
 * `generateOpsPipeline` both discover from the project root, not from `src/`),
 * and keeping it out of `src/` is what stops the build treating a workflow
 * definition as infrastructure to serialize.
 */
export {};
