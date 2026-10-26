/**
 * Nothing is declared here, on purpose. The Pulumi program is `infra/`, and
 * `pulumi up` still applies it. The entities come from `pulumi.member` in
 * `chant.config.ts`: at build time the lexicon's `buildRoots()` reads
 * `infra/stack-export.json` and every resource in it joins the build as an
 * entity keyed `infra/<type>::<name>`.
 */
export {};
