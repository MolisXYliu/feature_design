import { resolve } from "path"
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
// import {app} from "electron"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

// Plugin to copy resources to output
function copyResources(): { name: string; closeBundle: () => void } {
  return {
    name: "copy-resources",
    closeBundle(): void {
      const srcIcon = resolve("resources/icon.png")
      const destDir = resolve("out/resources")
      const destIcon = resolve("out/resources/icon.png")

      if (existsSync(srcIcon)) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true })
        }
        copyFileSync(srcIcon, destIcon)
      }

      // Copy skills directory
      const srcSkills = resolve("skills")
      const destSkills = resolve("out/skills")
      if (existsSync(srcSkills)) {
        copyDirRecursive(srcSkills, destSkills)
      }
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry)
    const destPath = resolve(dest, entry)
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

export default defineConfig({
  main: {
    // Bundle all dependencies into the main process
    build: {
      lib: {
        entry: "src/main/index.ts",
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["electron"],
        plugins: [copyResources()]
      }
    }
  },
  preload: {},
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
      // __APP_VERSION__: app.getVersion(),
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        // 访问 /api 开头的请求会转发
        "/api": {
          target: "http://localhost:3000", // 后端地址
          changeOrigin: true,
          // 去掉 /api 前缀
          rewrite: (path) => path.replace(/^\/api/, "")
        },

        // 修复marketplace代理配置
        "/marketplace": {
          target: "https://api.cmbcowork.com",
          changeOrigin: true,
          secure: true,
          // 直接转发到目标服务器，不需要重写路径
          rewrite: (path) => path
        }
      }
    }
  }
})
