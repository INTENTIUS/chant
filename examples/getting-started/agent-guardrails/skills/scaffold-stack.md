---
name: scaffold-stack
description: Add a Kubernetes resource to src/ following chant's static-subset and lint conventions, then verify it builds and lints clean.
---

# Scaffold a resource

Use this when adding a resource to `src/`.

1. Create `src/<name>.ts`. Prefer a composite (like `WebApp`) from
   `@intentius/chant-lexicon-k8s` over hand-writing every resource — composites
   carry the production defaults lint expects.
2. Put each config value in its own `const` above the resource. Do not inline
   objects in a constructor (lint rule COR001).
3. Export the resources the composite produced (`export const deployment = …`).
   An exported `new` declarable that nothing references warns (COR004).
4. Verify:

   ```bash
   chant build src --lexicon k8s -o k8s.yaml
   chant lint src
   ```

Both must be clean before you open a PR. You do not deploy.
