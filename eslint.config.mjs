import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/release/**",
      "**/coverage/**",
      ".dev-session/**",
      ".har/**",
      ".network-logs/**",
      ".pnpm-store/**",
      "downloads/**",
      "temp/**",
      "third_party/video-to-ppt-upstream/**",
      "third_party/upstream/**",
      "third_party/runtime/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    ...reactHooks.configs["flat/recommended"][0],
  },
  prettier,
);
