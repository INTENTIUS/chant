// Shared, static configuration — plain `const` values.
//
// Resolved at synthesis, never looked up at build time. This is the bulk of what
// you write, and the only thing that resolves during the build.
export const appName = "web";

// A pinned image tag. chant's lint flags `:latest` or an untagged image —
// non-deterministic rollouts are a correctness problem, not a style nit.
export const image = "nginxinc/nginx-unprivileged:1.27-alpine";
