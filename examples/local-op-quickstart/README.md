# local-op-quickstart

The smallest possible Op — runs in-process with **no Temporal server, Docker, or cloud**.

```bash
npm install
chant run hello
```

```
[phase] Greet
  ✓ shellCmd(cmd=echo hello from chant)   42ms
Op "hello" completed in 0.1s
```

`chant run` executes Ops locally by default: phased, with per-step retries and
`onFailure` compensation. Machine-readable output:

```bash
chant run hello --json
```

## Graduating to Temporal

Local mode covers dev loops, CI, and drift/observation Ops. For durable resume
after a crash, human **gates**, and **schedules**, configure a Temporal profile
in `chant.config.ts` and run with `--temporal`:

```bash
chant run hello --temporal
```

See [Local vs Temporal](https://intentius.dev/chant/guide/local-vs-temporal/) for
the full trade-off.
