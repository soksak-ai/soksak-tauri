import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // 제품 셸은 자기 이름을 반드시 선언한다. 누락/오타를 Tauri로 해석하는 fallback은 없다.
  // Vitest만 제품 셸이 아닌 중립 어댑터를 쓴다. 프레임워크 테스트는 각 구현을 직접 import한다.
  // @ts-expect-error process is a nodejs global
  const declared = process.env.SOKSAK_FRAMEWORK;
  const framework = mode === "test" ? "test" : declared;
  if (framework !== "tauri" && framework !== "electron" && framework !== "test") {
    throw new Error(
      "SOKSAK_FRAMEWORK를 tauri 또는 electron으로 명시해야 합니다",
    );
  }
  const selectedAdapter = resolve(
    process.cwd(),
    `src/framework/selected.${framework}.ts`,
  );

  return {
  plugins: [react()],
  resolve: {
    alias: {
      "#framework-adapter": selectedAdapter,
    },
  },
  build: {
    outDir: `dist/${framework}`,
    emptyOutDir: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `frameworks/tauri`
      ignored: ["**/frameworks/tauri/**"],
    },
  },
  };
});
