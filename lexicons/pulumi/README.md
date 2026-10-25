# @intentius/chant-lexicon-pulumi

Pulumi lexicon for [chant](https://intentius.io/chant/). It declares no resource types. It supplies the `pulumi` workspace member kind and reads a Pulumi program three ways:

| Read | Source | Module |
|---|---|---|
| the member's graph | the `pulumi stack export` checked in as `stack-export.json` | `src/workspace-member.ts` |
| its change-set part | `pulumi preview --json` | `src/change-set.ts` |
| its drift records | `pulumi refresh --preview-only --json --target <urn>`, one resource at a time | `src/drift-record.ts` |

The graph read never runs `pulumi`. The change set and drift run `preview` and `refresh --preview-only` and nothing else, so they never change a stack.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-pulumi
```

## License

See the main project LICENSE file.
