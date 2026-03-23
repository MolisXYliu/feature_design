import { tool } from "langchain"
import { z } from "zod"

const CHROME_MCP_URL = "http://127.0.0.1:12306/mcp"
const CHROME_MCP_EXTENSION_ZIP = "chrome-mcp-server-1.0.0.zip"

const chromeSetupSchema = z.object({
  mode: z
    .enum(["manual"])
    .optional()
    .describe("Guidance mode only. This tool will NOT run any command automatically.")
})

function buildSetupSteps(): string[] {
  return [
    "手动安装 mcp-chrome-bridge：npm install -g mcp-chrome-bridge",
    "手动执行注册：mcp-chrome-bridge register",
    `在 MCP 连接器里添加或启用 mcp-chrome（URL 填 ${CHROME_MCP_URL}）`,
    `浏览器插件 ${CHROME_MCP_EXTENSION_ZIP} 需要用户手动安装/启用（该项无法自动判断）`,
    "打开 Chrome 并访问 chrome://extensions/",
    "启用“开发者模式”",
    "点击“加载已解压的扩展程序”，选择你下载并解压后的扩展目录",
    "点击插件图标打开插件并连接，确认 MCP 桥接成功",
    "完成后回到当前会话重试浏览器操作"
  ]
}

function buildUserGuidance(steps: string[]): string {
  return [
    "chrome_setup 仅提供文本指导，不会主动执行任何命令。",
    "请按下面步骤手动处理：",
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n")
}

export function createChromeSetupTool() {
  return tool(
    async () => {
      const setupSteps = buildSetupSteps()
      const userGuidance = buildUserGuidance(setupSteps)
      return JSON.stringify(
        {
          tool: "chrome_setup",
          purpose: "Provide manual setup guidance for Chrome MCP before using chrome_* tools.",
          mode: "manual_guidance_only",
          ready: false,
          url: CHROME_MCP_URL,
          actionRequired: true,
          autoExecution: false,
          note: "该工具不会执行检测/安装/注册命令，请用户手动完成。",
          manualCommands: ["npm install -g mcp-chrome-bridge", "mcp-chrome-bridge register"],
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
        "Manual guidance only: return setup/troubleshooting checklist for Chrome MCP; never executes commands.",
      schema: chromeSetupSchema
    }
  )
}
