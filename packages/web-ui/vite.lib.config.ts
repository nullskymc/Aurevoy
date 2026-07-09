import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function injectLibraryCss(): Plugin {
  return {
    name: "aurevoy-lib-css-entry",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry) continue;
        if (chunk.code.includes(`import "./style.css";`)) continue;
        // Library consumers import JS entrypoints, so keep the generated CSS attached to the entry.
        chunk.code = `import "./style.css";\n${chunk.code}`;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), injectLibraryCss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "@aurevoy/shared",
      ],
    },
  },
});
