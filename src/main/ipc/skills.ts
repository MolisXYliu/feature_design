import { IpcMain } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { getSkillsDir } from "../storage"
import type { SkillMetadata } from "../types"

function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      result[key] = value
    }
  }
  return result
}

async function loadSkills(dirPath: string): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []

  if (!existsSync(dirPath)) return skills

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = path.join(dirPath, entry.name, "SKILL.md")
      if (!existsSync(skillMdPath)) continue

      try {
        const content = await fs.readFile(skillMdPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(content)

        skills.push({
          name: frontmatter.name || entry.name,
          description: frontmatter.description || "",
          path: skillMdPath,
          source: "project",
          license: frontmatter.license || null,
          compatibility: frontmatter.compatibility || null,
          allowedTools: frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/\s+/)
            : undefined
        })
      } catch (e) {
        console.warn(`[Skills] Failed to parse skill at ${skillMdPath}:`, e)
      }
    }
  } catch (e) {
    console.warn(`[Skills] Failed to read skills directory ${dirPath}:`, e)
  }

  return skills
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  console.log("[Skills] Registering skills handlers...")

  ipcMain.handle("skills:list", async (): Promise<SkillMetadata[]> => {
    const skillsDir = getSkillsDir()
    return loadSkills(skillsDir)
  })

  ipcMain.handle("skills:read", async (_event, skillPath: string) => {
    try {
      const skillsDir = path.resolve(getSkillsDir())
      const resolvedPath = path.resolve(skillPath)
      const relativePath = path.relative(skillsDir, resolvedPath)

      // Only allow reading files under the configured skills directory.
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { success: false, error: "Access denied: skill path outside skills directory" }
      }

      const content = await fs.readFile(resolvedPath, "utf-8")
      return { success: true, content }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
    }
  })
}
