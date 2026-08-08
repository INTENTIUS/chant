import type { ChantConfig } from "@intentius/chant";

/**
 * The `local` environment declares floci-az's endpoint so `--live` reads reach
 * the emulator without the caller exporting AZURE_ENDPOINT_URL — an ambient
 * value still wins if one is set (see docs: Config File > environments). On
 * the azure path the environment IS the resource group, so there is no
 * `stacks` entry: observation resolves the estate per-resource inside the
 * `local` group.
 *
 * `ownership` is what makes the live reads answer "is this mine?" from the
 * resource's own tags rather than from a state file. The k8s half binds to
 * the cluster's own kubeconfig context, not a port (behold#106): the admin
 * kubeconfig floci-az's k3s writes names its context `default`, and
 * `test/azure-cc-e2e.sh` points KUBECONFIG at the extracted file.
 *
 * `temporal` is in the lexicon list so `chant run` loads the azure applier
 * activity alongside the base ones (same wiring as local-cloud-trio).
 */
export default {
  lexicons: ["azure", "k8s", "temporal"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4577" }],
  ownership: { stack: "cc-azure-canonical", env: "local" },
  k8s: { profiles: { local: { context: "default" } } },
} satisfies ChantConfig;
