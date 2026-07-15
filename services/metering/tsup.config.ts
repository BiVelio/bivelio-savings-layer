import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  target: "es2022",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  external: ["@bivelio/protocol"],
});
