import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  splitting: false,
  // gray-matter is CJS — must stay external. Node resolves deps from the
  // obsidian-quant-mcp/node_modules/ directory up the tree at runtime.
});
