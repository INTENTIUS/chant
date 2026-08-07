---
skill: chant-cpln-workloads
description: Choose a Control Plane workload type and configure autoscaling, Capacity AI, resources and probes correctly
user-invocable: true
---

# Control Plane Workloads

## Pick the type first — it is immutable

Changing `type` means delete and recreate. Almost every other constraint follows from it.

| | Serverless | Standard | Stateful | Cron |
|---|:---:|:---:|:---:|:---:|
| Ports | **exactly 1 HTTP** | 0 or more | 0 or more | **none** |
| Scale to zero | `rps` / `concurrency` | KEDA only | KEDA only | no |
| Persistent volumes | no | no | **yes** | no |
| Multi-metric autoscaling | no | yes | yes | n/a |
| `spec.job` | forbidden | forbidden | forbidden | **required** |
| `timeoutSeconds` max | 600 | 3600 | 3600 | n/a |

- **Serverless** must expose exactly one HTTP port. Zero is the common mistake and the confusing one: it deploys, reports healthy, and serves nothing (CPL020).
- **Cron** must not expose ports and must set `spec.job.schedule`. Probes, autoscaling, `timeoutSeconds` and `debug` are all accepted and ignored, so setting them is a silent no-op (CPL021).
- **Stateful** is the only type that mounts `ext4`/`xfs` volume sets, and the only one that supports `replicaDirect` load balancing or `workloadLink` domain routing.

Max 8 containers per workload. Workload names are ≤ 49 characters and cannot end in `-headless`. Container names cannot start with `cpln-` or `debugger-`.

## Resources: the ratio is the surprise

Defaults are `cpu: 50m`, `memory: 128Mi`.

- CPU ≥ 25 millicores, memory ≥ 32 MiB.
- **`memory(MiB) / cpu(millicores)` ≤ 8.** So `2Gi` needs at least 256m of CPU. A memory-heavy, CPU-light workload is rejected — which surprises people coming from Kubernetes, where the two are independent. The `cpln/relaxMemoryToCpuRatio` tag raises the ceiling to 32.

CPL023 checks all three, using the defaults when a value is omitted, so an unset field is checked as what it will actually become.

## Autoscaling

`metric` and `multi` are alternatives, not layers. `target` belongs to the single-metric form and is capped at 100 for `cpu`/`memory` (it is a utilization percentage).

Scale to zero is the one worth being careful with. `minScale: 0` is accepted on any type and only *takes effect* for serverless under `rps`/`concurrency`, or standard/stateful under KEDA. Everywhere else the workload holds at one replica and the cost saving never arrives, with nothing reported (CPL026).

KEDA has to be enabled on the GVC before a workload in it can use it.

## Capacity AI is on by default

For serverless, standard and cron. It resizes CPU and memory from observed usage, and it is **mutually exclusive** with:

- CPU-utilization autoscaling — dynamic CPU moves the baseline the metric scales against.
- Multi-metric autoscaling — needs stable baselines.
- GPUs — GPU allocation is fixed.

These conflicts are usually reached by *adding* CPU scaling or a GPU to a workload that never opted into Capacity AI, so CPL027 says which of the two it is. Turn it off with `spec.defaultOptions.capacityAI: false`.

## Probes

Exactly one of `exec`, `grpc`, `tcpSocket`, `httpGet` per probe. A probe with only timing fields set looks configured and checks nothing (CPL024).

Defaults differ by type: readiness is TCP-on-port for serverless and **disabled** for standard, stateful and cron. And `spec.containers[].port` must match the port the process actually binds, or health checks fail.

## Firewalls start closed

Both directions of the external firewall are disabled by default, and the internal one is `none`.

- Inbound: add CIDRs (`0.0.0.0/0` for the internet).
- Outbound: CIDRs, or hostnames with a wildcard prefix (`*.amazonaws.com`). Hostname rules allow ports 80/443/445 only unless `outboundAllowPort` says otherwise.
- CIDR rules take precedence over hostname rules; blocked rules take precedence over allowed ones.

CPL010 flags outbound `0.0.0.0/0` — it is rarely needed and is the egress path for anything that gets a foothold. CPL011 flags internal `same-org`, which crosses the boundary the GVC exists to draw.

Internal traffic between workloads in a GVC is automatically mTLS-encrypted at `WORKLOAD.GVC.cpln.local:PORT`; there is nothing to configure.

## Images

- Never prefix a public image with `docker.io/` — `nginx:1.27`, not `docker.io/library/nginx:1.27` (CPL041).
- Your own org's images are `//image/NAME:TAG` in a workload spec. `<org>.registry.cpln.io` is for `docker login`/`push` only.
- Images must be `linux/amd64` — the wrong platform is an `exec format error` at runtime, not at apply.
- Pin a tag or digest. A scale-from-zero cold start re-pulls, so `:latest` means two replicas of one deploy can be different builds (CPL040).
