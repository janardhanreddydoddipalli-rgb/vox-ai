import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false, // tests share one Postgres test database
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
