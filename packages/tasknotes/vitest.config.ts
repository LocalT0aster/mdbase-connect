import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mdbase/connect-sync": fileURLToPath(new URL("../sync/src/index.ts", import.meta.url))
    }
  },
  test: { include: ["src/**/*.test.ts"] }
});
