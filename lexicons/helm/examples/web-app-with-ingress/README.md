# Web App with Ingress

Demonstrates a web application Helm chart with:
- TLS-ready Ingress resource
- Health probes (liveness + readiness)
- Pod and container security contexts
- HPA autoscaling
- Rolling update strategy

## Build

    chant build src --lexicon helm -o Chart.yaml

## Deploy

    helm install frontend .
