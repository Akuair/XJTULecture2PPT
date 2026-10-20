import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@xjtu-lecture2ppt/document-exporter",
          "@xjtu-lecture2ppt/downloader",
          "@xjtu-lecture2ppt/shared",
          "@xjtu-lecture2ppt/xjtu-client",
          "jszip",
        ],
      }),
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          conversion: resolve("src/preload/conversion.ts"),
        },
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@xjtu-lecture2ppt/xjtu-client"] })],
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          conversion: resolve("src/renderer/conversion.html"),
        },
      },
    },
    plugins: [react()],
  },
});
