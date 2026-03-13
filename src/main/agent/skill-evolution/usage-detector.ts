export interface SkillMetadataLite {
  name?: string
  path?: string
}

const DEFAULT_ALWAYS_ON_SKILLS = new Set(["scheduler-assistant", "skill-creator"])

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
}

function isLikelySkillDocRead(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    lower === "skill.md" ||
    lower.endsWith("/skill.md") ||
    lower.includes("/.cmbcoworkagent/sk") ||
    lower.includes("/enabled-skills")
  )
}

function pathMatchesLoadedSkill(readPath: string, loadedPath: string): boolean {
  return (
    loadedPath === readPath ||
    loadedPath.endsWith(readPath) ||
    readPath.endsWith(loadedPath)
  )
}

export class SkillUsageDetector {
  private readonly activeSkillNames = new Set<string>()
  private readonly loadedSkillPaths = new Set<string>()
  private readonly readPaths: string[] = []
  private sawLikelySkillDocRead = false
  private usedLoadedSkill = false

  private hasNonDefaultSkillsLoaded(): boolean {
    return Array.from(this.activeSkillNames).some((name) => !DEFAULT_ALWAYS_ON_SKILLS.has(name))
  }

  private recomputeUsage(): void {
    if (this.usedLoadedSkill || !this.hasNonDefaultSkillsLoaded()) return
    if (this.sawLikelySkillDocRead) {
      this.usedLoadedSkill = true
      return
    }
    this.usedLoadedSkill = this.readPaths.some((readPath) =>
      Array.from(this.loadedSkillPaths).some((loaded) => pathMatchesLoadedSkill(readPath, loaded))
    )
  }

  onSkillsMetadata(skills: SkillMetadataLite[]): void {
    for (const skill of skills) {
      if (typeof skill.name === "string" && skill.name.trim()) {
        this.activeSkillNames.add(skill.name.trim())
      }
      if (typeof skill.path === "string" && skill.path.trim()) {
        this.loadedSkillPaths.add(normalizePath(skill.path.trim()))
      }
    }
    this.recomputeUsage()
  }

  onReadFilePath(rawPath: string): void {
    const normalized = normalizePath(rawPath.trim())
    if (!normalized) return
    this.readPaths.push(normalized)
    if (isLikelySkillDocRead(normalized)) this.sawLikelySkillDocRead = true
    this.recomputeUsage()
  }

  getActiveSkillNames(): string[] {
    return Array.from(this.activeSkillNames)
  }

  wasSkillUsed(): boolean {
    return this.usedLoadedSkill
  }
}

/**
 * The popup should display the same count that crossed the threshold.
 */
export function getAutoProposeToolCallCount(turnToolCallCount: number): number {
  return turnToolCallCount
}

