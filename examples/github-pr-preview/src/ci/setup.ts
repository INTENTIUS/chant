// Steps both jobs share: checkout, Node, install, cluster credential.
//
// Every `uses:` is pinned to a full commit SHA — the github lexicon's lint
// treats an unpinned checkout as an error and any other unpinned action as a
// warning. The cluster credential arrives through an env var, never
// interpolated into script text.

import { Step } from "@intentius/chant-lexicon-github";

const CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"; // v4.2.2
const SETUP_NODE = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"; // v4.4.0

export const checkout = new Step({ name: "Checkout", uses: CHECKOUT });

export const setupNode = new Step({
  name: "Setup Node",
  uses: SETUP_NODE,
  with: { "node-version": "22" },
});

export const install = new Step({ name: "Install", run: "npm ci" });

export const clusterAccess = new Step({
  name: "Configure cluster access",
  env: { KUBECONFIG_DATA: "${{ secrets.PREVIEW_KUBECONFIG }}" },
  run: 'mkdir -p "$HOME/.kube" && printf \'%s\' "$KUBECONFIG_DATA" | base64 -d > "$HOME/.kube/config"',
});
