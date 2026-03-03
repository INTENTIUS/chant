# Chant

Infrastructure-as-code toolkit. TypeScript on Bun.

## E2E vs Smoke Tests
- **E2E tutorials** run DIRECTLY on the host: `cd examples/<name> && npm run deploy`. Follow the example README.
- **Smoke tests** (`test/smoke.sh`) are local tooling tests that verify packages install and build in a clean Docker environment. They are NOT for E2E validation.
- NEVER use `test/smoke.sh` to validate E2E tutorials.
