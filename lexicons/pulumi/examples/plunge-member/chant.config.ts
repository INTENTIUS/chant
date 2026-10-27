import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

/**
 * A member on plunge. `infra/Pulumi.yaml` names a `plunge+file://` backend,
 * which is enough: with no `engine` here, the backend URL decides, so the
 * preview, the outputs and the drift run under `plunge`. Writing
 * `engine: "pulumi"` here would run stock pulumi against a backend it cannot
 * open, which PUL015 reports.
 */
export default {
  lexicons: ["pulumi"],
  pulumi: {
    member: { dir: "./infra", label: "infra" },
  },
} satisfies ChantConfig;
