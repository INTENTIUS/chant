# Stateful Service

Demonstrates a StatefulSet Helm chart with persistent storage:
- StatefulSet with volumeClaimTemplates
- Headless Service for stable DNS
- Liveness and readiness probes
- Pod and container security contexts
- Rolling update strategy

## Build

    chant build src --lexicon helm -o Chart.yaml

## Deploy

    helm install stateful-service .

## Teardown

    helm uninstall stateful-service

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
