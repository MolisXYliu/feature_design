import { createWriteStream, mkdirSync, unlinkSync, createReadStream, existsSync } from "fs"
import { createHash } from "crypto"
import { createGunzip } from "zlib"
import { pipeline } from "stream/promises"
import { join } from "path"
import http from "http"
import https from "https"
import { getOpenworkDir } from "../storage"

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  speed: string
}

function getUpdatesDir(): string {
  const dir = join(getOpenworkDir(), "updates")
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Download a file via POST ?file=xxx, with progress reporting and SHA256 verification.
 */
function downloadFile(
  baseUrl: string,
  fileName: string,
  destPath: string,
  expectedSize: number,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/download`)
    url.searchParams.set("file", fileName)
    const urlStr = url.toString()
    const client = urlStr.startsWith("https") ? https : http

    const req = client.request(urlStr, { method: "POST", timeout: 300000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading file`))
        res.resume()
        return
      }

      const total = parseInt(res.headers["content-length"] || "0", 10) || expectedSize
      let transferred = 0
      let lastTime = Date.now()
      let lastTransferred = 0

      const file = createWriteStream(destPath)

      res.on("data", (chunk: Buffer) => {
        transferred += chunk.length
        const now = Date.now()
        if (now - lastTime >= 1000) {
          const elapsed = (now - lastTime) / 1000
          const bytesPerSec = (transferred - lastTransferred) / elapsed
          const speedMB = (bytesPerSec / 1024 / 1024).toFixed(1)
          onProgress?.({
            percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
            transferred,
            total,
            speed: `${speedMB} MB/s`
          })
          lastTime = now
          lastTransferred = transferred
        }
      })

      res.pipe(file)

      file.on("finish", () => {
        onProgress?.({ percent: 100, transferred: total, total, speed: "0 MB/s" })
        file.close(() => resolve())
      })

      file.on("error", (err) => {
        try { unlinkSync(destPath) } catch { /* ignore */ }
        reject(err)
      })
    })

    req.on("error", reject)

    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Download timeout"))
    })

    req.end()
  })
}

/**
 * Calculate SHA256 hash of a file.
 */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

/**
 * Download an update file, verify its SHA256, and decompress if it's a .gz file.
 *
 * @param baseUrl - ECS server base URL
 * @param fileName - File name on server (e.g. "cmbdevclaw-0.1.11-asar.gz")
 * @param expectedSha256 - Expected SHA256 hash of the compressed file
 * @param expectedSize - Expected size in bytes
 * @param onProgress - Optional progress callback
 * @returns Path to the final downloaded (and decompressed) file
 */
export async function downloadUpdate(
  baseUrl: string,
  fileName: string,
  expectedSha256: string,
  expectedSize: number,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const updatesDir = getUpdatesDir()
  const isGz = fileName.endsWith(".gz")
  const downloadPath = join(updatesDir, fileName)
  const finalPath = isGz ? join(updatesDir, "app.asar") : downloadPath

  // Clean up any previous download
  try { unlinkSync(downloadPath) } catch { /* file may not exist */ }
  if (isGz) { try { unlinkSync(finalPath) } catch { /* file may not exist */ } }

  console.log(`[Updater] Downloading ${baseUrl}/download?file=${fileName}`)
  await downloadFile(baseUrl, fileName, downloadPath, expectedSize, onProgress)

  console.log("[Updater] Verifying SHA256...")
  const actualHash = await sha256File(downloadPath)
  if (actualHash !== expectedSha256) {
    try { unlinkSync(downloadPath) } catch { /* ignore */ }
    throw new Error(`文件校验失败\n期望: ${expectedSha256}\n实际: ${actualHash}`)
  }
  console.log("[Updater] SHA256 verified OK")

  if (isGz) {
    console.log("[Updater] Decompressing...")
    await pipeline(createReadStream(downloadPath), createGunzip(), createWriteStream(finalPath))
    try { unlinkSync(downloadPath) } catch { /* ignore */ }
    console.log("[Updater] Decompressed to", finalPath)
  }

  return finalPath
}

/**
 * Get the path to the updates directory.
 */
export { getUpdatesDir }
