---
skill: chant-eks-microservice
description: Build, deploy, and manage the EKS microservice example
user-invocable: true
---

# EKS Microservice Example

This project defines AWS EKS infrastructure (CloudFormation) and Kubernetes
workloads in TypeScript using two chant lexicons. See also the lexicon skills
`chant-eks`, `chant-k8s-eks`, `chant-k8s`, and `chant-k8s-patterns` for
composite reference and advanced patterns.

## Project layout

- `src/infra/` — AWS resources (VPC, EKS cluster, IAM roles, addons, Route53, ACM cert, parameters)
- `src/k8s/` — K8s resources (app, ingress, observability, storage, namespace)
- `src/config.ts` — cross-lexicon config (env vars populated by `just load-outputs`)
- `.env` — auto-populated ARNs from CF stack outputs (gitignored)

## Local verification (no AWS required)

Run from the example directory (`examples/k8s-eks-microservice/`):

```bash
just build              # generates templates/infra.json (34 CF resources) + k8s.yaml (36 K8s resources)
just lint               # zero errors expected
```

Run tests from the repo root:

```bash
bun test examples/k8s-eks-microservice/   # 27 tests
```

## Deploy workflow

The default domain `api.eks-microservice-demo.dev` works for building and testing. For a real
deployment, pass your domain — Route53 creates the hosted zone and ACM cert
in-stack, so the only prerequisite is a registered domain.

```bash
just deploy domain=myapp.example.com       # phase 1: build → deploy-infra → configure-kubectl → load-outputs → build-k8s → apply → wait → status
```

Or step by step:

```bash
just build                                  # CF template + K8s manifests
just deploy-infra domain=myapp.example.com  # CF stack (34 resources)
just configure-kubectl                      # update kubeconfig
just load-outputs                           # write .env from CF outputs, prints Route53 nameservers
# --- NS delegation at your registrar ---
just deploy-cert                            # ACM cert + DNS validation (after NS delegation)
just load-outputs                           # re-run to pick up cert ARN
just build-k8s                              # rebuild K8s with real ARNs
just apply                                  # kubectl apply
just wait                                   # rollout status
just status                                 # check pods, ingress, daemonsets
```

After deploy, `just load-outputs` prints Route53 nameservers — update your
domain registrar's NS records to these. Then run `just deploy-cert` to create
and validate the ACM certificate (requires NS delegation first).

Optionally restrict the EKS API endpoint: `just deploy-infra domain=myapp.example.com cidr=203.0.113.1/32`

## Verify

```bash
just status
just logs               # app pod logs
```

## Teardown

```bash
just teardown           # delete K8s → wait for ALB drain → delete CF stack
```

Delete order matters — K8s resources must be removed first so the ALB controller
addon can clean up the ALB before the CF stack deletes it.

## Troubleshooting

- ALB not provisioning → check ALB controller addon: `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller`
- Pods pending → check node group scaling: `kubectl get nodes`
- IRSA not working → verify OIDC provider thumbprint and role trust policy
- ExternalDNS not updating → check Route53 hosted zone and role access
- ACM cert stuck in PENDING_VALIDATION → ensure `just load-outputs` shows nameservers and your registrar NS records match
