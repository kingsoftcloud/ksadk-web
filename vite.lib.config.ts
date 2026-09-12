import path from "path"
import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import packageJson from "./package.json" with { type: "json" }

const external = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

export default defineConfig({
  plugins: [react(), { name: "teams-styles", generateBundle() { this.emitFile({ type: "asset", fileName: "teams.css", source: readFileSync(path.resolve(__dirname, "src/components/teams/teams.css"), "utf8") }); } }],
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    lib: {
      entry: {
        capabilities: path.resolve(__dirname, "src/public/capabilities.ts"),
        "chat-composer": path.resolve(__dirname, "src/public/chat-composer.ts"),
        "chat-timeline": path.resolve(__dirname, "src/public/chat-timeline.ts"),
        components: path.resolve(__dirname, "src/public/components.ts"),
        conversation: path.resolve(__dirname, "src/public/conversation.ts"),
        hooks: path.resolve(__dirname, "src/public/hooks.ts"),
        runtime: path.resolve(__dirname, "src/public/runtime.ts"),
        styles: path.resolve(__dirname, "src/public/styles.ts"),
        types: path.resolve(__dirname, "src/public/types.ts"),
        teams: path.resolve(__dirname, "src/public/teams.ts"),
        "team-components": path.resolve(__dirname, "src/public/team-components.ts"),
        "team-execution": path.resolve(__dirname, "src/public/team-execution.ts"),
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
