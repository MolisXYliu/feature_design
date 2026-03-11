// Git 提交记录跟踪器
// 用于防止重复提交同一操作

interface CommitRecord {
  filePath: string
  operation: string // 'write_file' | 'edit_file'
  commitHash?: string
  timestamp: number
  commitMessage: string
  cardNumber?: string
  operationId: string // 操作ID，用于唯一标识本次操作
}

class GitCommitTracker {
  private static STORAGE_KEY = "git_commit_records"

  // 生成操作记录的唯一键（基于operationId）
  private static getRecordKey(operationId: string): string {
    return operationId
  }

  // 获取所有提交记录
  private static getRecords(): Map<string, CommitRecord> {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY)
      if (!stored) return new Map()

      const recordArray: CommitRecord[] = JSON.parse(stored)
      const recordMap = new Map<string, CommitRecord>()

      recordArray.forEach((record) => {
        const key = this.getRecordKey(record.operationId)
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

  // 检查操作是否已经提交过（基于operationId，不依赖会话）
  static hasCommittedOperation(operationId: string): boolean {
    const records = this.getRecords()
    return records.has(operationId)
  }

  // 检查文件是否有提交记录（用于显示历史，不限制会话）
  static hasCommittedFile(filePath: string, operation: string): boolean {
    const records = this.getRecords()

    return Array.from(records.values()).some(
      (record) =>
        record.filePath === filePath &&
        record.operation === operation
    )
  }

  // 获取文件的最新提交记录（不限制会话）
  static getLatestCommitRecord(filePath: string, operation: string): CommitRecord | null {
    const records = this.getRecords()

    const fileRecords = Array.from(records.values())
      .filter(
        (record) =>
          record.filePath === filePath &&
          record.operation === operation
      )
      .sort((a, b) => b.timestamp - a.timestamp)

    return fileRecords[0] || null
  }

  // 记录文件提交（需要operationId）
  static recordCommit(
    operationId: string,
    filePath: string,
    operation: string,
    commitMessage: string,
    cardNumber?: string,
    commitHash?: string
  ): void {
    const records = this.getRecords()

    const record: CommitRecord = {
      filePath,
      operation,
      commitHash,
      timestamp: Date.now(),
      commitMessage,
      cardNumber,
      operationId
    }

    records.set(operationId, record)
    this.saveRecords(records)

    console.log(`Git commit recorded for operation: ${operationId} - ${filePath} (${operation})`)
  }

  // 获取特定操作的提交记录
  static getOperationCommitRecord(operationId: string): CommitRecord | null {
    const records = this.getRecords()
    return records.get(operationId) || null
  }

  // 获取文件的提交记录（不限制会话）
  static getCommitRecord(filePath: string, operation: string): CommitRecord | null {
    const records = this.getRecords()

    const fileRecords = Array.from(records.values())
      .filter(
        (record) =>
          record.filePath === filePath &&
          record.operation === operation
      )
      .sort((a, b) => b.timestamp - a.timestamp)

    return fileRecords[0] || null
  }

  // 清除所有记录（用于调试）
  static clearAllRecords(): void {
    localStorage.removeItem(this.STORAGE_KEY)
    console.log("Cleared all git commit records")
  }

  // 清除过期记录（超过30天，延长保存时间以支持跨会话检查）
  static cleanupExpiredRecords(): void {
    const records = this.getRecords()
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

    for (const [key, record] of records.entries()) {
      if (record.timestamp < thirtyDaysAgo) {
        records.delete(key)
      }
    }

    this.saveRecords(records)
  }

  // 获取所有提交记录（按时间倒序）
  static getAllCommitRecords(): CommitRecord[] {
    const records = this.getRecords()

    return Array.from(records.values())
      .sort((a, b) => b.timestamp - a.timestamp) // 按时间倒序
  }

  // 删除特定操作的提交记录（用于调试）
  static removeOperationRecord(operationId: string): void {
    const records = this.getRecords()
    records.delete(operationId)
    this.saveRecords(records)
    console.log(`Removed git commit record for operation: ${operationId}`)
  }
}

export { GitCommitTracker, type CommitRecord }
