import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.codebuddy/**",
      "**/.session_tmps/**",
      "**/.thumbs/**",
      "**/dist-release*/**",
      "**/desktop/dist-renderer/**",
    ],
  },
});
