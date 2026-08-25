---
skill: chant-k3s
description: Declare k3s host configuration — server/agent config.yaml and registries.yaml — as typed chant source
user-invocable: true
---

# k3s with chant

The k3s lexicon declares the files k3s itself consumes: `config.yaml` for
`k3s server` / `k3s agent`, and `registries.yaml` for the embedded
containerd. The emitted files are exactly what the native tool accepts —
drop them at `/etc/rancher/k3s/` (or pass `--config`) and chant is nowhere
in sight.

Config keys are the CLI flag names, verbatim. If `k3s server --help` shows
`--write-kubeconfig-mode`, the declaration key is `"write-kubeconfig-mode"`.
Quoted kebab-case keys are normal here.

## Declaring a server

```typescript
import { Server } from "@intentius/chant-lexicon-k3s";

export const controlPlane = new Server({
  "cluster-init": true,                      // embedded etcd, first node
  "tls-san": ["10.0.0.10", "cp.example.internal"],
  "write-kubeconfig-mode": "0600",           // wider than 0644 trips K3S104
  disable: ["traefik"],
});
```

## Declaring an agent

```typescript
import { Agent } from "@intentius/chant-lexicon-k3s";

export const worker = new Agent({
  server: "https://cp.example.internal:6443", // required — K3S103 without it
  "token-file": "/etc/rancher/k3s/agent-token",
});
```

## The token boundary

There is no `token` property, on purpose. The join secret reaches the node
as a file (`token-file`, `agent-token-file`) or as `K3S_TOKEN` /
`K3S_TOKEN_FILE` in the installer's environment — never as a value in
source. A literal that arrives through raw props anyway fails K3S001 at
lint and K3S101 at build. The same wall covers `etcd-s3-secret-key` and
`etcd-s3-session-token`; use `etcd-s3-config-secret` (a Secret on the
cluster) for snapshot-store credentials.

## Private registries

```typescript
import { Mirror, Registries, RegistryConfig, RegistryTLS } from "@intentius/chant-lexicon-k3s";

export const registries = new Registries({
  mirrors: {
    "docker.io": new Mirror({ endpoint: ["https://mirror.internal:5000"] }),
  },
  configs: {
    "mirror.internal:5000": new RegistryConfig({
      tls: new RegistryTLS({ ca_file: "/etc/ssl/certs/mirror-ca.pem" }),
    }),
  },
});
```

Literal `auth.password` / `auth.token` fail K3S102; `insecure_skip_verify`
warns via K3S105 — pin the CA instead.

## Op lifecycle (reachable-host case)

`k3sInstall` / `k3sUninstall` (chant#1601) drive a k3s installer against a
host the Op runs on or can reach directly — the same boundary `k3dUp`/
`k3dDown` draw (chant#1410): no host provisioning, no SSH orchestration.
Requires `"k3s"` in the project's `chant.config.ts` `lexicons`.

```typescript
import { Op, phase, k3sInstall, k3sUninstall } from "@intentius/chant-lexicon-temporal";

export default Op({
  name: "k3s-controlplane",
  phases: [
    phase("Install", [
      k3sInstall("server", { configFile: "/etc/rancher/k3s/config.yaml" }),
    ]),
  ],
});
```

`k3sInstall` runs the pinned `get.k3s.io` installer (`INSTALL_K3S_VERSION`
from the lexicon's pin, or an explicit `version` override) with `--config`
pointing at a config.yaml already on the host — a build/apply step upstream
puts it there. It is idempotent on an already-installed matching version:
`k3s --version` is checked first, and a match skips the install entirely.
`k3sUninstall` runs the matching uninstall script; a host where k3s was
never installed is a no-op success.

**The token boundary carries through to the Op surface.** There is no
`token` option on `k3sInstall` — only `tokenFile`, a path passed to the
installer as `K3S_TOKEN_FILE`. The join secret's value never appears in
Op-authored TypeScript (which is committed source, same as a config.yaml
declaration), is never logged, and is never interpolated into the installer
command string — it travels only as an environment variable set on the
child process at install time.

```typescript
k3sInstall("agent", {
  configFile: "/etc/rancher/k3s/config.yaml",
  tokenFile: "/etc/rancher/k3s/agent-token", // a path, not the secret
});
```

## Output shape

One file per declared entity. The first Server/Agent config is the primary
build output; further configs land beside it as `<name>.config.yaml`, and
a Registries entity as `registries.yaml`. A build carrying an ownership
marker stamps it into `node-label`, so the registered Node is attributable
with any kubectl.

## Rules

| Rule | Severity | What it catches |
|---|---|---|
| K3S001 | error | literal `token` / `agent-token` in source |
| K3S101 | error | a literal secret reaching the build (token, etcd S3 keys) |
| K3S102 | error | literal registry credentials in registries.yaml |
| K3S103 | error | an Agent with no `server` to join |
| K3S104 | warning | kubeconfig written wider than 0644 |
| K3S105 | warning | registry TLS verification disabled |
