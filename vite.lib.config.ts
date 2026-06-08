import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import packageJson from "./package.json" with { type: "json" }

const external = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    lib: {
      entry: {
        capabilities: path.resolve(__dirname, "src/public/capabilities.ts"),
        components: path.resolve(__dirname, "src/public/components.ts"),
        runtime: path.resolve(__dirname, "src/public/runtime.ts"),
        styles: path.resolve(__dirname, "src/public/styles.ts"),
        types: path.resolve(__dirname, "src/public/types.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: "styles",
    },
    rollupOptions: {
      external: (id) => external.some((dependency) => id === dependency || id.startsWith(`${dependency}/`)),
    },
  },
})
