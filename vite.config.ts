import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { visualizer } from "rollup-plugin-visualizer"
import { a2uiAssets } from "./scripts/a2ui-assets-plugin"

const analyze = process.env.ANALYZE === "1"

export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  plugins: [
    react(),
    a2uiAssets(),
    analyze ? visualizer({
      filename: "dist/stats.html",
      gzipSize: true,
      brotliSize: true,
      template: "treemap",
    }) : null,
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // proxy /agentengine API to local fast API server
      '/agentengine': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  }
})
