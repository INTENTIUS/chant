# @intentius/chant-k8s-client

The typed Kubernetes API client behind [chant](https://www.npmjs.com/package/@intentius/chant)'s live-cluster surfaces: `chant lifecycle diff --live`, `chant lifecycle plan`, `chant kube`, the `kubectlApply`/`waitForReady` Op activities, and [behold](https://github.com/INTENTIUS/behold)'s overlay.

You normally don't install this directly — the k8s lexicon declares it as an **optional dependency**:

```sh
npm install @intentius/chant-lexicon-k8s
```

Without it installed, chant's build/synthesis path is completely unaffected (this package is never importable from it — enforced by test); live observation reports honest "not observed" holes instead of failing.

## What it does

- **Any kind the cluster serves** — the operation surface is generated from the same OpenAPI/CRD pass that produces the lexicon's resource types (they cannot skew), then confirmed against the cluster's own API discovery. CRDs included; no hand-maintained kind map.
- **Server-side apply as `chant:<stack>`** — a stable field-manager identity per stack, with 409 conflicts surfaced as typed errors naming the competing manager and contested field paths. Force is per-call only, never a default.
- **managedFields primitives** — per-manager field-set parsing that powers chant's derived (not hand-maintained) property-level drift.
- **Cluster binding honored** — `k8s.profiles.<env>.context` from `chant.config.ts` is enforced; a mismatch with the ambient context is a refusal, not a read of the wrong cluster.
- Transport and auth are rented from [`@kubernetes/client-node`](https://github.com/kubernetes-client/javascript) (kubeconfig, exec credential plugins, token refresh).

## Documentation

- [The API client](https://intentius.io/chant/lexicons/k8s/api-client/) — coverage, concurrency, credentials, and why this is a separate package
- [`chant kube`](https://intentius.io/chant/lexicons/k8s/kube/) — the terminal surface over this client
