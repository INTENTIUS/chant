# Agent instructions

This is a chant repo. You author typed TypeScript and verify it. You do not
deploy. These rules constrain an agent working in this directory; a human reader
following the tutorial still runs the deploy steps themselves.

## The loop

1. Edit resources in `src/`.
2. Run `chant build src --lexicon k8s -o k8s.yaml`.
3. Run `chant lint src`. Fix every warning before opening a PR.
4. Open a PR. A human reviews the TypeScript and the built `k8s.yaml`.

## What you may run

- `chant build`, `chant lint`, `chant list`, `chant graph` — pure, no cluster,
  no credentials.
- `chant lifecycle plan` — read-only change set.
- `chant lifecycle affected --base origin/main` — scope a change to the stacks it
  touches.

## What you must not run

- `chant run deploy`, `chant run deploy-gated`, `chant run apply`,
  `chant run signal …` — deploys and their approval. A human runs these.
- `kubectl apply` / `kubectl delete` — same reason.

These are denied in `.claude/settings.json`. Do not work around the denial.

## Writing resources

chant evaluates a static subset of TypeScript. Stay inside it:

- `const` bindings only. No `let`, no `var`.
- No function calls, control flow, or dynamic property access in resource props.
- Resources are top-level `export const`. For a value that varies by
  environment, use a separate file, not an `if`.
- Prefer composites (like `WebApp`) over hand-writing every resource. They carry
  the production defaults chant's lint expects.

## Secrets

Never put a secret, account ID, or ARN as a literal in `src/`. chant blocks
fetching one at build time; a pasted constant is on you.
