# CronJob

Demonstrates a CronJob Helm chart for scheduled tasks:
- CronJob with configurable schedule
- Concurrency policy and history limits
- Backoff limit for retries
- Pod and container security contexts

## Build

    chant build src --lexicon helm -o Chart.yaml

## Deploy

    helm install cron-job .

## Teardown

    helm uninstall cron-job

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
