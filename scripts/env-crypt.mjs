#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const HEADER = "CMBENV1"

function isEncrypted(text) {
  return text.startsWith(`${HEADER}:`)
}

function parseKey(value) {
  const raw = value.trim()
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex")
  }

  const b64 = Buffer.from(raw, "base64")
  if (b64.length === 32) {
    return b64
  }

  throw new Error("ENV_ENCRYPTION_KEY must be 32-byte base64 or 64-char hex.")
}

function getKey() {
  const envKey = process.env.ENV_ENCRYPTION_KEY
  if (envKey && envKey.trim()) {
    return parseKey(envKey)
  }

  const keyFile = process.env.ENV_ENCRYPTION_KEY_FILE || join(homedir(), ".cmbdevclaw", "env.key")
  if (existsSync(keyFile)) {
    const fileValue = readFileSync(keyFile, "utf8")
    if (fileValue.trim()) {
      return parseKey(fileValue)
    }
  }

  throw new Error(
    "Missing encryption key. Set ENV_ENCRYPTION_KEY or provide ENV_ENCRYPTION_KEY_FILE/.cmbdevclaw/env.key."
  )
}

function encrypt(plaintext, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${HEADER}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`
}

function decrypt(payload, key) {
  const parts = payload.split(":")
  if (parts.length !== 4 || parts[0] !== HEADER) {
    throw new Error("Invalid encrypted .env format.")
  }

  const iv = Buffer.from(parts[1], "base64")
  const tag = Buffer.from(parts[2], "base64")
  const encrypted = Buffer.from(parts[3], "base64")

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString("utf8")
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on("data", (chunk) => chunks.push(chunk))
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    process.stdin.on("error", reject)
  })
}

async function cleanMode() {
  const input = await readStdin()
  if (!input || isEncrypted(input)) {
    process.stdout.write(input)
    return
  }
  const key = getKey()
  process.stdout.write(encrypt(input, key))
}

async function smudgeMode() {
  const input = await readStdin()
  if (!input || !isEncrypted(input)) {
    process.stdout.write(input)
    return
  }
  const key = getKey()
  process.stdout.write(decrypt(input, key))
}

function transformFile(filePath, mode) {
  const input = readFileSync(filePath, "utf8")

  if (mode === "decrypt") {
    if (!isEncrypted(input)) {
      return
    }
    const key = getKey()
    writeFileSync(filePath, decrypt(input, key), "utf8")
    return
  }

  if (mode === "encrypt") {
    if (isEncrypted(input)) {
      return
    }
    const key = getKey()
    writeFileSync(filePath, encrypt(input, key), "utf8")
    return
  }

  throw new Error(`Unsupported file transform mode: ${mode}`)
}

async function main() {
  const command = process.argv[2]
  const filePath = process.argv[3]

  if (command === "clean") {
    await cleanMode()
    return
  }
  if (command === "smudge") {
    await smudgeMode()
    return
  }
  if (command === "decrypt-file") {
    if (!filePath) throw new Error("Usage: node scripts/env-crypt.mjs decrypt-file <path>")
    transformFile(filePath, "decrypt")
    return
  }
  if (command === "encrypt-file") {
    if (!filePath) throw new Error("Usage: node scripts/env-crypt.mjs encrypt-file <path>")
    transformFile(filePath, "encrypt")
    return
  }

  throw new Error(
    "Usage: node scripts/env-crypt.mjs <clean|smudge|decrypt-file|encrypt-file> [path]"
  )
}

main().catch((error) => {
  process.stderr.write(`[env-crypt] ${error.message}\n`)
  process.exit(1)
})
