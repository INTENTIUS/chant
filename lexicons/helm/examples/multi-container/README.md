# Multi-Container

Demonstrates a Deployment with a sidecar container:
- Main application container (API server)
- Sidecar container (log collector / Fluent Bit)
- Shared emptyDir volume between containers
- Service exposing the main container port
- Configurable resources for both containers

## Build

    chant build src --lexicon helm -o Chart.yaml

## Deploy

    helm install multi-container .

## Teardown

    helm uninstall multi-container

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
