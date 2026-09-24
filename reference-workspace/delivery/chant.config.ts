import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["docker"],
  lint: {
    rules: {
      // COR004 flags an exported declarable nothing in its file references.
      // This project's one Service is its whole output, so nothing refers to it.
      COR004: "off",
    },
  },
} satisfies ChantConfig;
