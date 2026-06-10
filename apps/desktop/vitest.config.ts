import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 前端组件单测配置：jsdom 环境 + Testing Library 断言扩展。
// 与 vite.config.ts 分离，避免污染 Tauri 开发/构建配置。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
