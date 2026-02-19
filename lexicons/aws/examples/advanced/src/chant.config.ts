export default {
  lint: {
    extends: ["@intentius/chant/lint/presets/strict"],
    rules: {
      COR004: "off",
    },
    plugins: ["./lint/api-timeout.ts"],
  },
};
