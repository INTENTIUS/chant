# @intentius/chant-lexicon-github

GitHub Actions lexicon for [chant](https://intentius.io/chant/) — declare workflow definitions as typed TypeScript that serializes to `.github/workflows/*.yml`.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-github
```

## Runtime observation: N/A

`chant state snapshot` and `chant state diff --live` operate by querying a runtime equivalent of each declared resource. The GitHub lexicon doesn't fit that model:

- The lexicon's chant entities describe **GitHub Actions workflow definitions**, which are git-tracked. Drift in the definition itself is just `git diff` — no observation surface needed.
- Workflow **runs** are events (per-execution), not declared state. They're observable via the GitHub API but the abstraction is `listRecentRuns()`, not `describeResources()` or `listArtifacts()`. That's a separate plugin contract if/when it's needed.
- "Is this workflow enabled in the GitHub UI?" is theoretically observable but a marginal use case.

If a concrete observation use case surfaces, file a focused issue rather than retrofitting `listArtifacts()` to fit.

## License

See the main project LICENSE file.
