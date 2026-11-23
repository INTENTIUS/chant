import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

// The dogwood helpers (`defaultEventSchema()`, `formerly(...)`, `ctx(...)`) are
// plain function calls. Build runs the file rather than folding it, so they are
// valid here, and EVL001 (the fold subset) would flag each one.
export default {
  lexicons: ["cedar"],
  lint: { rules: { EVL001: "off" } },
  cedar: {
    schema: "schema.cedarschema",
  },
} satisfies ChantConfig;
