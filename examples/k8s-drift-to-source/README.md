# k8s-drift-to-source

A drifted field, reported against the composite argument and the source line
that set it.

`composites/web-app.ts` declares a `WebApp` composite. Its factory sets a
Deployment's `spec.replicas` from the `replicas` argument and the container
image and port from `image` and `port`. `src/app.ts` calls it once and also
declares a `worker` Deployment directly. The build emits 3 resources: the
`web-app` Deployment and Service, and the `worker` Deployment.

The factory body is a list of `const` declarations and a `return`, so
`chant build` interprets it instead of running it and records, for every
field, which argument produced it and where the call wrote that argument.
`chant lifecycle diff --live` reads that record.

## Run it against k3d

From the repository root, with Docker, k3d, kubectl and jq installed:

```bash
just drift-to-source-e2e           # scale web-app; the diff names WebApp({ replicas: 3 }) at src/app.ts:11
BREAK=1 just drift-to-source-e2e   # scale worker; the diff attributes it as direct
```

The script creates its own k3d cluster with its own kubeconfig file and
deletes it at the end.

## Run it by hand

With your kube context pointing at a cluster you can write to:

```bash
npm run build                                   # writes k8s.yaml
npm run deploy                                  # kubectl apply --server-side --field-manager=chant
kubectl scale deployment web-app --replicas=5
npm run diff                                    # chant lifecycle diff local --live
npm run teardown
```

The drift section of the diff reads:

```text
- webDeployment (K8s::Apps::Deployment)
    spec.replicas: 3 → 5 [from: composite WebApp parameter replicas]
      spec.replicas on K8s::Apps::Deployment webDeployment comes from WebApp({ replicas: 3 }) at src/app.ts:11
      change parameter `replicas` of the `web` call of composite WebApp at src/app.ts:11 so `spec.replicas` moves from 3 to 5. The composite stays.
```

See the "Drift Back to Source" guide in the chant docs for what the four
origins mean and when an origin is unknown.
