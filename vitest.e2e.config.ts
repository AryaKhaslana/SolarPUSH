import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __DEV__: true,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "sonarmesh-native": path.resolve(__dirname, "modules/sonarmesh-native/src/index.ts"),
      "react-native": path.resolve(__dirname, "tests/e2e/helpers/reactNativeShim.ts"),
      "react-native-svg": path.resolve(__dirname, "tests/e2e/helpers/svgShim.ts"),
      "react-native-safe-area-context": path.resolve(__dirname, "tests/e2e/helpers/safeAreaShim.ts"),
      "expo-status-bar": path.resolve(__dirname, "tests/e2e/helpers/statusBarShim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.{ts,tsx}"],
    setupFiles: ["tests/e2e/helpers/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
