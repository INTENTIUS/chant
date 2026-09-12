import type { ChantConfig } from "@intentius/chant";

/**
 * Fifteen independently-deployed CloudFormation stacks in one project: one
 * `network`, two clusters on it, and twelve apps on the clusters.
 *
 * Nothing in this file states the order they deploy in, and nothing anywhere
 * else does either. `chant components fan-out` reads `dependsOn` off the
 * `*.component.ts` files and derives the order from the change.
 */
export default {
  // The aws lexicon does both halves: `chant build` synthesizes the templates,
  // and the same lexicon contributes the `cfn-deploy` capability the components
  // dispatch through.
  lexicons: ["aws"],

  // One environment, pointed at a local AWS emulator. `--env local` on any
  // component command resolves to this endpoint; drop it (and the endpoint) to
  // run the same estate against a real account.
  environments: [{ name: "local", endpoint: "http://localhost:4566" }],

  // A multi-stack project (#932): one entry per independently-deployed stack,
  // each naming the source directory it is built from. `chant lifecycle
  // affected --base <ref>` walks this list to work out which stacks a diff
  // moved, and that stack-level answer is the change signal a fan-out starts
  // from. The stack names here are the same strings the components pass to
  // `cfn-deploy`'s `stack`, which is how a changed stack finds its component.
  stacks: [
    { name: "network", src: "src/network" },
    { name: "cluster-a", src: "src/cluster-a" },
    { name: "cluster-b", src: "src/cluster-b" },
    { name: "app-01", src: "src/app-01" },
    { name: "app-02", src: "src/app-02" },
    { name: "app-03", src: "src/app-03" },
    { name: "app-04", src: "src/app-04" },
    { name: "app-05", src: "src/app-05" },
    { name: "app-06", src: "src/app-06" },
    { name: "app-07", src: "src/app-07" },
    { name: "app-08", src: "src/app-08" },
    { name: "app-09", src: "src/app-09" },
    { name: "app-10", src: "src/app-10" },
    { name: "app-11", src: "src/app-11" },
    { name: "app-12", src: "src/app-12" },
  ],

  // The project's own identity, not any one CloudFormation stack's name. It is
  // what the aws lexicon stamps on every resource it manages here, as the
  // chant:managed-by / chant:stack / chant:env tags.
  ownership: { stack: "chant-fan-out-estate", env: "local" },
} satisfies ChantConfig;
