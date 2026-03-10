// Git 提交记录跟踪器
// 用于防止重复提交同一文件

interface CommitRecord {
  filePath: string
  operation: string // 'write_file' | 'edit_file'
  commitHash?: string
  timestamp: number
  commitMessage: string
  cardNumber?: string
  sessionId: string // 当前会话ID，用于区分不同的对话会话
}

class GitCommitTracker {
  private static STORAGE_KEY = "git_commit_records"
  private static SESSION_KEY = "git_session_id"

  // 获取当前会话ID，如果不存在则生成新的
  private static getSessionId(): string {
    let sessionId = localStorage.getItem(this.SESSION_KEY)
    if (!sessionId) {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      localStorage.setItem(this.SESSION_KEY, sessionId)
    }
    return sessionId
  }

  // 生成文件记录的唯一键
  private static getRecordKey(filePath: string, operation: string): string {
    return `${filePath}:${operation}`
  }

  // 获取所有提交记录
  private static getRecords(): Map<string, CommitRecord> {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY)
      if (!stored) return new Map()

      const recordArray: CommitRecord[] = JSON.parse(stored)
      const recordMap = new Map<string, CommitRecord>()

      recordArray.forEach((record) => {
        const key = this.getRecordKey(record.filePath, record.operation)
        recordMap.set(key, record)
      })

      return recordMap
    } catch (error) {
      console.error("Failed to load git commit records:", error)
      return new Map()
    }
  }

  // 保存提交记录
  private static saveRecords(records: Map<string, CommitRecord>): void {
    try {
      const recordArray = Array.from(records.values())
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recordArray))
    } catch (error) {
      console.error("Failed to save git commit records:", error)
    }
  }

  // 检查文件是否已经在当前会话中提交过
  static hasCommitted(filePath: string, operation: string): boolean {
    const records = this.getRecords()
    const key = this.getRecordKey(filePath, operation)
    const record = records.get(key)

    if (!record) return false

    // 检查是否是当前会话的提交
    const currentSessionId = this.getSessionId()
    return record.sessionId === currentSessionId
  }

  // 记录文件提交
  static recordCommit(
    filePath: string,
    operation: string,
    commitMessage: string,
    cardNumber?: string,
    commitHash?: string
  ): void {
    const records = this.getRecords()
    const key = this.getRecordKey(filePath, operation)
    const currentSessionId = this.getSessionId()

    const record: CommitRecord = {
      filePath,
      operation,
      commitHash,
      timestamp: Date.now(),
      commitMessage,
      cardNumber,
      sessionId: currentSessionId
    }

    records.set(key, record)
    this.saveRecords(records)

    console.log(`Git commit recorded for: ${filePath} (${operation})`)
  }

  // 获取文件的提交记录
  static getCommitRecord(filePath: string, operation: string): CommitRecord | null {
    const records = this.getRecords()
    const key = this.getRecordKey(filePath, operation)
    return records.get(key) || null
  }

  // 清除当前会话的所有记录
  static clearSessionRecords(): void {
    const records = this.getRecords()
    const currentSessionId = this.getSessionId()

    // 只删除当前会话的记录
    for (const [key, record] of records.entries()) {
      if (record.sessionId === currentSessionId) {
        records.delete(key)
      }
    }

    this.saveRecords(records)
    console.log("Cleared current session git commit records")
  }

  // 清除所有记录（用于调试）
  static clearAllRecords(): void {
    localStorage.removeItem(this.STORAGE_KEY)
    console.log("Cleared all git commit records")
  }

  // 清除过期记录（超过7天）
  static cleanupExpiredRecords(): void {
    const records = this.getRecords()
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

    for (const [key, record] of records.entries()) {
      if (record.timestamp < sevenDaysAgo) {
        records.delete(key)
      }
    }

    this.saveRecords(records)
  }

  // 获取当前会话的所有提交记录
  static getCurrentSessionRecords(): CommitRecord[] {
    const records = this.getRecords()
    const currentSessionId = this.getSessionId()

    return Array.from(records.values())
      .filter((record) => record.sessionId === currentSessionId)
      .sort((a, b) => b.timestamp - a.timestamp) // 按时间倒序
  }

  // 开始新会话（清除当前会话ID，下次访问时会生成新的）
  static startNewSession(): void {
    localStorage.removeItem(this.SESSION_KEY)
    console.log("Started new git commit tracking session")
  }
}

export { GitCommitTracker, type CommitRecord }
