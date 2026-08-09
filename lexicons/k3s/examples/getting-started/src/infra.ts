/**
 * A two-node k3s cluster, declared.
 *
 * `chant build` emits the files k3s consumes verbatim: a config.yaml per
 * node (`k3s server --config` / `k3s agent --config`, or dropped at
 * /etc/rancher/k3s/config.yaml before the installer runs) and a
 * registries.yaml for the embedded containerd. Walk away with the files
 * any time — they carry no chant fingerprints beyond the ownership
 * node-labels a build with a marker adds.
 *
 * The join secret never appears here. The server mints one at first boot;
 * the agent reads it from a file on its host (`token-file`), or from
 * K3S_TOKEN_FILE at install time. A literal `token:` fails K3S001/K3S101.
 */
import { Agent, Mirror, Registries, RegistryConfig, RegistryTLS, Server } from "@intentius/chant-lexicon-k3s";

/** The control plane. TLS SANs cover how agents and operators reach it. */
export const controlPlane = new Server({
  "cluster-init": true,
  "tls-san": ["10.0.0.10", "cp.example.internal"],
  "write-kubeconfig-mode": "0600",
  disable: ["traefik"],
  "node-label": ["role=control-plane"],
});

/** A worker that joins it. The token arrives via a host file, never source. */
export const worker = new Agent({
  server: "https://cp.example.internal:6443",
  "token-file": "/etc/rancher/k3s/agent-token",
  "node-label": ["role=worker"],
});

/** Pull-through mirror with a pinned CA — the K3S105-clean shape. */
export const registries = new Registries({
  mirrors: {
    "docker.io": new Mirror({ endpoint: ["https://mirror.example.internal:5000"] }),
  },
  configs: {
    "mirror.example.internal:5000": new RegistryConfig({
      tls: new RegistryTLS({ ca_file: "/etc/ssl/certs/mirror-ca.pem" }),
    }),
  },
});
