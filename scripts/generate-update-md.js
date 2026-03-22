#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT_DIR = path.resolve(__dirname, '..')
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json')
const UPDATE_MD_PATH = path.join(ROOT_DIR, 'update.md')
const SECTION_MARKER = '<!-- update-log:sections -->'

function runGit(args) {
  return execFileSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  }).trim()
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getVersionFromPackageJson(content) {
  const parsed = JSON.parse(content)
  if (!parsed.version || typeof parsed.version !== 'string') {
    throw new Error('package.json 缺少有效的 version 字段')
  }

  return parsed.version
}

function extractVersionFromPackageAtCommit(hash) {
  const packageAtCommit = runGit(['show', `${hash}:package.json`])
  return getVersionFromPackageJson(packageAtCommit)
}

function getVersionHistoryNewestFirst() {
  const output = runGit(['log', '--format=%H', '--follow', '-G', '"version"\\s*:', '--', 'package.json'])
  if (!output) {
    return []
  }

  const hashes = output.split('\n').filter(Boolean)
  const uniqueVersions = []
  const seenVersions = new Set()

  for (const hash of hashes) {
    const version = extractVersionFromPackageAtCommit(hash)
    if (seenVersions.has(version)) {
      continue
    }

    seenVersions.add(version)
    uniqueVersions.push({ version, hash })
  }

  return uniqueVersions
}

function getRecordedVersionsNewestFirst(content) {
  const versions = []
  const seen = new Set()
  const regex = /<!--\s*version:([^:]+):start\s*-->/g
  let match = regex.exec(content)
  while (match) {
    const version = String(match[1] || '').trim()
    if (version && !seen.has(version)) {
      versions.push(version)
      seen.add(version)
    }
    match = regex.exec(content)
  }
  return versions
}

function resolveBaselineVersion({ currentVersion, existingUpdateContent, versionHistory }) {
  const recordedVersions = getRecordedVersionsNewestFirst(existingUpdateContent)
  const previousRecordedVersion = recordedVersions.find((version) => version !== currentVersion)
  if (previousRecordedVersion) {
    return previousRecordedVersion
  }

  const currentIndex = versionHistory.findIndex((item) => item.version === currentVersion)
  if (currentIndex >= 0 && versionHistory[currentIndex + 1]) {
    return versionHistory[currentIndex + 1].version
  }

  if (versionHistory[0]) {
    return versionHistory[0].version
  }

  return null
}

function getCommitsFromRange(rangeStartHash) {
  const gitArgs = ['log', '--date=short', '--pretty=format:%h%x09%ad%x09%s']
  if (rangeStartHash) {
    gitArgs.push(`${rangeStartHash}..HEAD`)
  }

  const output = runGit(gitArgs)
  if (!output) {
    return []
  }

  return output.split('\n').filter(Boolean).map((line) => {
    const [shortHash, date, subject] = line.split('\t')
    return { shortHash, date, subject }
  })
}

function shouldSkipSubject(subject) {
  const normalized = subject.trim()
  const skipPatterns = [
    /^merge\b/i,
    /\bupdate\s+version\b/i,
    /\bbump\b.*\bversion\b/i,
    /更新version/i,
    /优化version/i,
    /^update\s+ignore$/i,
    /^优化$/i,
    /^删除没用的代码$/i,
    /^删除没用的文件$/i
  ]

  return skipPatterns.some((pattern) => pattern.test(normalized))
}

function normalizeSubject(subject) {
  return subject
    .replace(/^(feat|fix|chore|refactor|perf|docs|style|test|build|ci)(\([^)]+\))?:\s*/i, '')
    .replace(/^修复[:：]\s*/u, '修复')
    .replace(/^新增[:：]\s*/u, '新增')
    .replace(/^优化[:：]\s*/u, '优化')
    .replace(/broswer_playwright/gi, 'browser_playwright')
    .replace(/^dengl$/i, '登录流程优化')
    .replace(/^登陆$/u, '登录流程优化')
    .replace(/^用户登[陆录]$/u, '登录流程优化')
    .replace(/^新增ip的上报$/i, 'IP 获取与上报链路优化')
    .replace(/^新增ip的获取$/i, 'IP 获取与上报链路优化')
    .replace(/^新增ip$/i, 'IP 获取与上报链路优化')
    .replace(/^优化ip，version的获取$/i, 'IP 获取与上报链路优化')
    .replace(/^优化埋点$/i, '埋点能力增强')
    .replace(/^埋点新增时间戳$/i, '埋点能力增强')
    .replace(/^message埋点$/i, '埋点能力增强')
    .replace(/^更新安装$/i, '安装流程优化')
    .replace(/^更新market$/i, 'Market 安装流程优化')
    .replace(/^update market$/i, 'Market 安装流程优化')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeKey(input) {
  return input.replace(/[\s，,。!！:：;；\-_/()（）'"`]+/g, '').toLowerCase()
}

function classifyTopic(text) {
  const rules = [
    { topic: '沙箱与安全', patterns: [/沙箱|sandbox|uac|elevated|审批|安全|acl|权限/i] },
    { topic: 'Git 工作流', patterns: [/git push|git提交|分支|diff|commit|push/i] },
    {
      topic: 'ChatX 与消息通道',
      patterns: [
        /chatx|stream|channel|机器人|回调|定时任务/i,
        /(^|[^a-z])ws([^a-z]|$)/i,
        /(^|[^a-z])http([^a-z]|$)/i
      ]
    },
    { topic: 'MCP/技能/插件生态', patterns: [/mcp|skill|技能|plugin|market|marketplace|connector/i] },
    { topic: '界面与交互体验', patterns: [/样式|ui|弹窗|侧边栏|看板|badge|render|图标|icon/i] },
    { topic: '环境与稳定性', patterns: [/ip|env|网络|超时|执行|execute/i] }
  ]

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.topic
    }
  }

  return '通用能力与工程改进'
}

function consolidateCommitsToNarrative(commits) {
  const dedupedBySubject = new Map()

  for (const commit of commits) {
    if (!commit.subject || shouldSkipSubject(commit.subject)) {
      continue
    }

    const normalized = normalizeSubject(commit.subject)
    if (!normalized) {
      continue
    }

    const key = normalizeKey(normalized)
    const existing = dedupedBySubject.get(key)
    if (!existing) {
      dedupedBySubject.set(key, { subject: normalized, count: 1 })
      continue
    }
    existing.count += 1
  }

  const topicGroups = new Map()
  for (const item of dedupedBySubject.values()) {
    const topic = classifyTopic(item.subject)
    const list = topicGroups.get(topic) || []
    list.push(item)
    topicGroups.set(topic, list)
  }

  const sortedTopics = Array.from(topicGroups.entries())
    .map(([topic, items]) => ({
      topic,
      items: items.sort((a, b) => b.count - a.count || a.subject.length - b.subject.length)
    }))
    .sort((a, b) => b.items.length - a.items.length)

  const lines = []
  if (sortedTopics.length > 0) {
    const focusTopics = sortedTopics.slice(0, 3).map((item) => item.topic).join('、')
    lines.push(`- 本次版本主要围绕${focusTopics}等方向进行了集中迭代。`)
  }

  for (const group of sortedTopics) {
    const highlights = group.items.slice(0, 3).map((item) => {
      if (item.count > 1) {
        return `${item.subject}（多次迭代）`
      }
      return item.subject
    })

    let sentence = `${group.topic}方面，重点包括${joinFragments(highlights)}`
    if (group.items.length > highlights.length) {
      sentence += `，并同步完善了同主题的${group.items.length - highlights.length}项细节优化`
    }
    lines.push(`- ${sentence}。`)
  }

  return lines
}

function joinFragments(fragments) {
  if (fragments.length === 0) {
    return '多项优化'
  }
  if (fragments.length === 1) {
    return fragments[0]
  }
  if (fragments.length === 2) {
    return `${fragments[0]}，以及${fragments[1]}`
  }
  return `${fragments[0]}、${fragments[1]}，以及${fragments[2]}`
}

function ensureFileTemplate(content) {
  if (content.includes(SECTION_MARKER)) {
    return content
  }

  const header = [
    '# 打包更新记录',
    '',
    '> 该文件会在执行 `npm run dist`（含 dist:win / dist:mac）时自动更新。',
    '',
    SECTION_MARKER,
    ''
  ].join('\n')

  const trimmed = content.trim()
  if (!trimmed) {
    return `${header}\n`
  }

  return `${header}\n${trimmed}\n`
}

function removeVersionSection(content, version) {
  const startMarker = `<!-- version:${version}:start -->`
  const endMarker = `<!-- version:${version}:end -->`
  const sectionRegex = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n*`,
    'g'
  )

  return content.replace(sectionRegex, '')
}

function buildVersionSection({ currentVersion, contentLines }) {
  const startMarker = `<!-- version:${currentVersion}:start -->`
  const endMarker = `<!-- version:${currentVersion}:end -->`
  const lines = contentLines.length ? contentLines : ['- 本版本暂无可整理的变更内容。']

  return [
    startMarker,
    `## v${currentVersion}`,
    '',
    ...lines,
    '',
    endMarker,
    ''
  ].join('\n')
}

function main() {
  const packageJsonRaw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')
  const currentVersion = getVersionFromPackageJson(packageJsonRaw)
  const versionHistory = getVersionHistoryNewestFirst()
  const existing = fs.existsSync(UPDATE_MD_PATH) ? fs.readFileSync(UPDATE_MD_PATH, 'utf8') : ''
  const baselineVersion = resolveBaselineVersion({
    currentVersion,
    existingUpdateContent: existing,
    versionHistory
  })
  const baselineVersionEntry = baselineVersion
    ? versionHistory.find((item) => item.version === baselineVersion)
    : null

  const rawCommits = getCommitsFromRange(baselineVersionEntry ? baselineVersionEntry.hash : null)
  const contentLines = consolidateCommitsToNarrative(rawCommits)
  const section = buildVersionSection({
    currentVersion,
    contentLines
  })

  let content = ensureFileTemplate(existing)
  content = removeVersionSection(content, currentVersion)
  content = content.replace(SECTION_MARKER, `${SECTION_MARKER}\n\n${section}`)
  content = `${content.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`

  fs.writeFileSync(UPDATE_MD_PATH, content, 'utf8')
  const baselineText = baselineVersion ? `（基线版本：v${baselineVersion}）` : ''
  console.log(`update.md 已更新：v${currentVersion}${baselineText}`)
}

main()
