export default {
  lexicons: ["aws"],

  lint: {
    extends: ["@intentius/chant/lint/presets/strict"],

    rules: {
      "EVL001": "error",
      "COR002": "warning",
      "COR009": "off",
    },

    overrides: [
      {
        files: ["src/legacy/**/*.ts"],
        rules: {
          "EVL001": "warning",
          "COR005": "off",
        },
      },
    ],

    plugins: ["./lint-rules/org-standards.ts"],
  },
};
