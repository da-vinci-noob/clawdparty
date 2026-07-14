import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/vitest.setup.ts"],
    include: ["src/**/*.test.tsx", "src/**/*.test.ts", "test/**/*.test.tsx"],
    css: false,
  },
});
