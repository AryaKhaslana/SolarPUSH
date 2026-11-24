import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "sonarmesh-native": path.resolve(
        __dirname,
        "modules/sonarmesh-native/src/index.ts"
      ),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**", "android/**", "dist/**"],
  },
});
