# pulumi-stream

`preview-stream.ndjson` is the engine event stream of the preview in `../pulumi-preview/preview.json`, in the form `pulumi preview --json --show-sames` prints with `PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true` (one `apitype.EngineEvent` per line, INTENTIUS/chant#4541 ruling C). It was converted from that recording on 2026-10-27, not recorded itself: no engine ran for this unit.

The conversion follows plunge `pkg/backend/display/events.go` (`convertStepEventMetadata`, `convertStepEventStateMetadata`) at plunge 951f878926:

- each printed step is a `resourcePreEvent` with `planning: true`, followed by its `resOutputsEvent`;
- a `replace` step is surrounded by its non-logical `create-replacement` and `delete-replaced` steps, which the printed document leaves out (`shouldShow`);
- a state carries `inputs` and `outputs` even when empty, and `id`, `parent` and `provider` as `""` when unset;
- a blinded secret is the envelope `{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "[secret]"}` (the `BlindingCrypter`), where the printed document has `"[secret]"`;
- `detailedDiff` entries name their kind `diffKind`;
- one advisory `policyEvent` (pack `corpus-checks`, policy `sqs-dead-letter`), one ephemeral diagnostic and the `summaryEvent` are added at the end.

`engine-events.test.ts` checks that the stream's digest equals the printed document's. Replace this file with a recording of the same corpus change on floci (stock pulumi 3.272.0 and plunge, file backends, fake credentials) when the epic's runs are made.

`up-failed-plunge.ndjson` (#4579) is a plunge `up --json` that stops on a failed update with no `summaryEvent`: one create whose `resOutputsEvent` carries plunge#55's timings, then a `resOpFailedEvent` with the failed provider call's timing, then the error diagnostic. It was written by hand in the shape of plunge's `events.go`, not recorded, and a floci recording of a failing update replaces it at epic-ready.
