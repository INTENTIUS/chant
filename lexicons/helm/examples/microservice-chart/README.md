# Microservice Chart

Demonstrates a production-ready microservice Helm chart with:
- Deployment with health probes and resource limits
- Service and ServiceAccount
- ConfigMap for application config
- Ingress with path-based routing
- HPA for CPU/memory autoscaling
- PodDisruptionBudget for availability

## Build

    chant build src --lexicon helm -o Chart.yaml

## Deploy

    helm install payment-api .
