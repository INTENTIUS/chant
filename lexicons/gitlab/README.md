# @intentius/chant-lexicon-gitlab

GitLab CI lexicon for [chant](https://intentius.io/chant/) — declare CI/CD pipelines as typed TypeScript that serializes to `.gitlab-ci.yml`.

This package provides typed constructors for all GitLab CI keywords (Jobs, Workflows, Default, and property types like Artifacts, Cache, Image, Rule, Environment, and Trigger), the `CI` pseudo-parameter object for predefined variables, the `reference()` intrinsic for YAML `!reference` tags, and GitLab-specific lint rules. It also includes LSP and MCP server support for editor completions and hover.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-gitlab
```

**[Documentation →](https://intentius.io/chant/lexicons/gitlab/)**

## Related Packages

| Package | Role |
|---------|------|
| [@intentius/chant](https://www.npmjs.com/package/@intentius/chant) | Core type system, CLI, build pipeline |
| [@intentius/chant-lexicon-aws](https://www.npmjs.com/package/@intentius/chant-lexicon-aws) | AWS CloudFormation lexicon |

## Runtime observation: N/A

`chant state snapshot` and `chant state diff --live` operate by querying a runtime equivalent of each declared resource. The GitLab lexicon doesn't fit that model:

- The lexicon's chant entities (`Job`, `Workflow`, `Default`, `Image`, `Rule`, etc.) describe **CI pipeline definitions**, which are git-tracked. Drift in the definition itself is just `git diff` — no observation surface needed.
- Pipeline **runs** are events (per-execution), not declared state. They're observable via the GitLab API but the abstraction is `listRecentRuns()`, not `describeResources()` or `listArtifacts()`. That's a separate plugin contract if/when it's needed.
- "Is this workflow enabled in the GitLab UI?" is theoretically observable but a marginal use case.

If a concrete observation use case surfaces, file a focused issue rather than retrofitting `listArtifacts()` to fit.

## GitHub Actions migration

`chant migrate` translates `.github/workflows/*.yml` into `.gitlab-ci.yml` or typed chant TypeScript. The transformer, action-mapping registry, and provenance model are ported from `gitlab-org/ci-cd/github-actions-to-gitlab-ci` (MIT). See [Migration](https://intentius.io/chant/lexicons/gitlab/migration/) and [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).

## License

See the main project LICENSE file.
