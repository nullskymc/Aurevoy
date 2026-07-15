import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: "./",  // 相对路径，适用于 file:// 和 asset:// 加载
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        themeDemo: resolve(__dirname, "theme-demo.html"),
      },
      output: {
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
  server: {
    port: 1422,
    strictPort: false,
  },
});
