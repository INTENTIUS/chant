# @intentius/chant-lexicon-gcp

GCP lexicon for [chant](https://intentius.io/chant/): declare infrastructure as TypeScript that serializes to [Config Connector](https://cloud.google.com/config-connector/docs/overview) objects. You can apply them two ways. A cluster running the Config Connector operator takes them with `kubectl apply`. Without one, chant's own applier, `gcpApply`, maps each object to its Google REST API and creates, updates or deletes the resource directly. Deployment Manager is not involved: Google retired it.

This package provides generated constructors for GCP resource types, type-safe properties, composites for grouping related resources, and GCP-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-gcp
```

**[Documentation →](https://intentius.io/chant/lexicons/gcp/)**

## Lifecycle

chant marks what it owns on two surfaces (`src/ownership.ts`). The Config Connector objects carry the Kubernetes labels `app.kubernetes.io/managed-by`, `chant-stack` and `chant-env`. The GCP resources `gcpApply` writes carry `managed-by`, `chant-stack` and `chant-env` as GCP labels, since a GCP label key can't hold `/` or `.`.

- `chant lifecycle diff <env> --live` and `chant lifecycle plan <env>` read each resource over the same REST mapping the applier writes with, so no cluster is needed. A kind whose REST body has no labels, such as a Pub/Sub topic, reads with ownership unknown.
- `gcpApply`, the Op activity, and `gcp-apply`, the component step, PUT each resource to its REST API. `GCP_ENDPOINT_URL` points them at an emulator such as floci-gcp.
- With `prune`, the applier deletes chant-owned resources the manifest no longer declares, and nothing it doesn't own.

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |
| [@intentius/chant-lexicon-azure](https://www.npmjs.com/package/@intentius/chant-lexicon-azure) | Azure ARM lexicon |

## License

See the main project LICENSE file.
