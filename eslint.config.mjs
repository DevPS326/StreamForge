import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "apps/web/**",
      "**/dist/**",
      "**/generated/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/next-env.d.ts",
      "**/artifacts/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.jest },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.cjs", "**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["tests/load/**/*.js"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        open: "readonly",
      },
    },
  },
);
