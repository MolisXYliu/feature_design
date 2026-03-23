import { execSync } from "node:child_process"
import { tool } from "langchain"
import { z } from "zod"

const CHROME_MCP_URL = "http://127.0.0.1:12306/mcp"
const CHROME_MCP_EXTENSION_ZIP = "chrome-mcp-server-1.0.0.zip"

const chromeSetupSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(500)
    .max(10000)
    .optional()
    .describe("Probe timeout in milliseconds. Defaults to 2500.")
})

interface CommandResult {
  ok: boolean
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
}

function runCommand(command: string, timeoutMs: number): CommandResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    })
    return {
      ok: true,
      command,
      stdout: stdout.trim(),
      stderr: "",
      exitCode: 0
    }
  } catch (error: unknown) {
    const err = error as {
      status?: number
      stdout?: string | Buffer
      stderr?: string | Buffer
      message?: string
    }
    return {
      ok: false,
      command,
      stdout: typeof err.stdout === "string" ? err.stdout.trim() : Buffer.from(err.stdout ?? "").toString("utf-8").trim(),
      stderr:
        (typeof err.stderr === "string" ? err.stderr.trim() : Buffer.from(err.stderr ?? "").toString("utf-8").trim())
        || (err.message ?? "Unknown command error"),
      exitCode: typeof err.status === "number" ? err.status : null
    }
  }
}

function buildSetupSteps(params: {
  installed: boolean
  bridgeReady: boolean
  installAttempted: boolean
  registerAttempted: boolean
}): string[] {
  const steps: string[] = []
  if (!params.installed) {
    steps.push("mcp-chrome-bridge 未安装成功，请手动执行：npm install -g mcp-chrome-bridge")
  } else if (params.installAttempted) {
    steps.push("已自动安装 mcp-chrome-bridge。")
  }

  if (!params.bridgeReady) {
    steps.push("已自动执行 mcp-chrome-bridge register，但未成功，请手动再次执行：mcp-chrome-bridge register")
  } else if (params.registerAttempted) {
    steps.push("已自动执行 mcp-chrome-bridge register。")
  }

  steps.push("在 MCP 连接器里添加或启用 mcp-chrome（URL 填 http://127.0.0.1:12306/mcp）。")
  steps.push(
    `浏览器插件${CHROME_MCP_EXTENSION_ZIP}需要用户手动安装/启用（该项无法自动判断）。`
  )
  steps.push("加载 Chrome 扩展。")
  steps.push("打开 Chrome 并访问 chrome://extensions/。")
  steps.push("启用“开发者模式”。")
  steps.push("点击“加载已解压的扩展程序”，选择 your/dowloaded/extension/folder。")
  steps.push("点击插件图标打开插件，点击连接即可看到 mcp 的配置。")
  steps.push("完成后回到当前会话重试浏览器操作。")
  return steps
}

function buildUserGuidance(steps: string[], ready: boolean): string {
  const intro = ready
    ? "Chrome MCP 环境检查完成。"
    : "当前 Chrome MCP 环境仍不可用。"
  return [
    `${intro} 请按下面步骤处理：`,
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n")
}

export function createChromeSetupTool() {
  return tool(
    async () => {
      const installCheck = runCommand("mcp-chrome-bridge --version", 8000)
      let installAttempted = false
      let installCommand: CommandResult | null = null
      let installed = installCheck.ok

      if (!installed) {
        installAttempted = true
        installCommand = runCommand("npm install -g mcp-chrome-bridge", 180000)
        installed = installCommand.ok
      }

      const registerAttempted = true
      const registerCommand = runCommand("mcp-chrome-bridge register", 30000)
      const bridgeReady = registerCommand.ok

      const setupSteps = buildSetupSteps({
        installed,
        bridgeReady,
        installAttempted,
        registerAttempted
      })
      const userGuidance = buildUserGuidance(setupSteps, bridgeReady)
      return JSON.stringify(
        {
          tool: "chrome_setup",
          purpose: "Prepare Chrome MCP environment before using chrome_* tools.",
          ready: bridgeReady,
          url: CHROME_MCP_URL,
          actionRequired: !bridgeReady,
          install: {
            installed,
            installAttempted,
            versionCheck: installCheck,
            installCommand
          },
          register: {
            registerAttempted,
            registerCommand
          },
          extension: {
            packageName: CHROME_MCP_EXTENSION_ZIP,
            manualRequired: true,
            steps: [
              "加载 Chrome 扩展",
              "打开 Chrome 并访问 chrome://extensions/",
              "启用“开发者模式”",
              "点击“加载已解压的扩展程序”，选择 your/dowloaded/extension/folder",
              "点击插件图标打开插件，点击连接即可看到 mcp 的配置"
            ],
            note: "浏览器扩展安装状态无法自动判断，必须用户手动完成并确认。"
          },
          userGuidance,
          nextSteps: setupSteps
        },
        null,
        2
      )
    },
    {
      name: "chrome_setup",
      description:
        "Check whether the local mcp-chrome bridge is reachable and return setup/troubleshooting steps.",
      schema: chromeSetupSchema
    }
  )
}
