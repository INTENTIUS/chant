import { Template } from "@intentius/chant-lexicon-e2b";

// The template a steward's sandbox is made from. The full node image brings
// Node and git, which the runtime needs; the run step adds the tools this
// project's Ops call, installed once at build time rather than on every run.
const steward = new Template({
  name: "chant-steward",
  fromImage: "node:22-bookworm",
  run: [
    "apt-get update && apt-get install -y --no-install-recommends jq gh && rm -rf /var/lib/apt/lists/*",
  ],
  cpuCount: 2,
  memoryMB: 2048,
});

export { steward };
