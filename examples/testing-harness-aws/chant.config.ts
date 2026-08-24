import type { ChantConfig } from "@intentius/chant";

// The worked example for the live-stack test harness (#1224).
//
// - `ownership.stack` is required by the harness: `destroy()` is marker-scoped,
//   and a deploy that stamps nothing is a deploy nothing can sweep.
// - The `"test-*"` pattern entry (#1221) legalizes the per-run environment
//   names the harness derives (`test-<suite>-<nonce>`), and carries the
//   default Floci endpoint (#1166) so `chant emulator up` plus the suite works
//   with nothing exported. An ambient `AWS_ENDPOINT_URL` always wins over it.
export default {
  lexicons: ["aws"],
  ownership: { stack: "testing-harness-aws" },
  environments: ["dev", { name: "test-*", endpoint: "http://localhost:4566" }],
} satisfies ChantConfig;
