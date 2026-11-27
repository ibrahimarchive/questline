import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const POWERSHELL = 'powershell.exe'
const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
]

const PROCESS_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @()
if ($env:QUESTLINE_PATHS) {
  $paths = @($env:QUESTLINE_PATHS | ConvertFrom-Json)
}
if ($paths.Count -eq 0) {
  Write-Output '[]'
  exit 0
}
$result = Get-CimInstance Win32_Process | Where-Object {
  $exe = $_.ExecutablePath
  $exe -and ($paths -contains $exe)
} | ForEach-Object {
  [PSCustomObject]@{
    ProcessId = [int]$_.ProcessId
    Path = [string]$_.ExecutablePath
    StartedAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
}
Write-Output (ConvertTo-Json -InputObject @($result) -Compress)
`

const ROOT_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$root = [string]$env:QUESTLINE_ROOT
if (-not $root) {
  Write-Output '[]'
  exit 0
}
$root = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$result = Get-CimInstance Win32_Process | Where-Object {
  $exe = $_.ExecutablePath
  if (-not $exe) { return $false }
  if (-not $exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $relative = $exe.Substring($root.Length)
  $separator = $relative.IndexOf([System.IO.Path]::DirectorySeparatorChar)
  $separator -gt 0 -and $relative.Substring(0, $separator) -match '^[0-9]{1,25}$'
} | ForEach-Object {
  [PSCustomObject]@{
    ProcessId = [int]$_.ProcessId
    Path = [string]$_.ExecutablePath
    StartedAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
}
Write-Output (ConvertTo-Json -InputObject @($result) -Compress)
`

const KILL_ROOT = `
$ErrorActionPreference = 'SilentlyContinue'
$root = [string]$env:QUESTLINE_ROOT
if (-not $root) {
  Write-Output '0'
  exit 0
}
$root = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$targets = Get-CimInstance Win32_Process | Where-Object {
  $exe = $_.ExecutablePath
  if (-not $exe) { return $false }
  if (-not $exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $relative = $exe.Substring($root.Length)
  $separator = $relative.IndexOf([System.IO.Path]::DirectorySeparatorChar)
  $separator -gt 0 -and $relative.Substring(0, $separator) -match '^[0-9]{1,25}$'
}
$count = 0
foreach ($target in @($targets)) {
  try {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    $count++
  } catch {}
}
Write-Output ([string]$count)
`

const KILL_PATHS = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @()
if ($env:QUESTLINE_PATHS) {
  $paths = @($env:QUESTLINE_PATHS | ConvertFrom-Json)
}
if ($paths.Count -eq 0) {
  Write-Output '0'
  exit 0
}
$targets = Get-CimInstance Win32_Process | Where-Object {
  $exe = $_.ExecutablePath
  $exe -and ($paths -contains $exe)
}
$count = 0
foreach ($target in @($targets)) {
  try {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    $count++
  } catch {}
}
Write-Output ([string]$count)
`

const PROCESS_BY_PID = `
$ErrorActionPreference = 'SilentlyContinue'
$processId = [int]$env:QUESTLINE_PID
if ($processId -le 0) {
  Write-Output '[]'
  exit 0
}
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
if (-not $process -or -not $process.ExecutablePath) {
  Write-Output '[]'
  exit 0
}
$result = [PSCustomObject]@{
  ProcessId = [int]$process.ProcessId
  Path = [string]$process.ExecutablePath
  StartedAt = if ($process.CreationDate) { $process.CreationDate.ToUniversalTime().ToString('o') } else { $null }
}
Write-Output (ConvertTo-Json -InputObject @($result) -Compress)
`

function isValidGameId(gameId) {
  return typeof gameId === 'string' && /^\d{1,25}$/.test(gameId)
}

function splitExecutableName(executableName) {
  if (typeof executableName !== 'string' || !executableName.trim()) {
    throw new Error('The game executable name is empty.')
  }

  const normalized = executableName.replace(/\//g, '\\')
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('\\')) {
    throw new Error('Absolute executable paths are not allowed.')
  }

  const segments = normalized.split('\\').filter(Boolean)
  if (segments.length === 0) {
    throw new Error('The game executable name is invalid.')
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Relative path segments are not allowed.')
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      throw new Error(`The executable path contains an invalid character: ${segment}`)
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`The executable path contains an invalid trailing character: ${segment}`)
    }
  }

  return segments
}

function pathKey(filePath) {
  return path.resolve(filePath).toLowerCase()
}

function canonicalExecutableName(executableName) {
  return String(executableName)
    .replace(/\//g, '\\')
    .split('\\')
    .filter(Boolean)
    .join('\\')
    .toLowerCase()
}

const RUNNER_SIGNATURE = Buffer.from('QuestlineRunnerWindow', 'utf16le')

async function isQuestlineRunner(filePath) {
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const { size } = await handle.stat()
      if (size <= 0 || size > 32 * 1024 * 1024) return false
      const buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, 0)
      return buffer.includes(RUNNER_SIGNATURE)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

async function runPowerShell(script, environment = {}) {
  const { stdout } = await execFileAsync(POWERSHELL, [...POWERSHELL_ARGS, script], {
    env: { ...process.env, ...environment },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  })
  return stdout.trim()
}

function parseProcessList(output) {
  if (!output) return []
  try {
    const parsed = JSON.parse(output)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter((entry) => entry && Number.isInteger(entry.ProcessId) && entry.Path)
      .map((entry) => ({
        pid: entry.ProcessId,
        path: String(entry.Path),
        startedAt: entry.StartedAt || new Date().toISOString(),
      }))
  } catch {
    return []
  }
}

export class RunnerService {
  constructor({ gamesDirectory, runnerPath, onEvent = () => {} }) {
    this.gamesDirectory = path.resolve(gamesDirectory)
    this.runnerPath = runnerPath
    this.onEvent = onEvent
    this.sessions = new Map()
  }

  setGamesDirectory(directory) {
    this.gamesDirectory = path.resolve(directory)
  }

  sessionKey(gameId, executableName) {
    return `${gameId}::${canonicalExecutableName(executableName)}`
  }

  targetFor(gameId, executableName) {
    if (!isValidGameId(gameId)) {
      throw new Error('The game id is invalid.')
    }
    const segments = splitExecutableName(executableName)
    const filename = segments.pop()
    const folder = path.resolve(this.gamesDirectory, gameId, ...segments)
    const target = path.resolve(folder, filename)
    const relative = path.relative(path.resolve(this.gamesDirectory), target)
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('The executable path escapes the games folder.')
    }
    return { target, folder, filename, executableName }
  }

  async ensureRoot() {
    await fs.mkdir(this.gamesDirectory, { recursive: true })
  }

  async inspectMany(games) {
    if (!Array.isArray(games)) throw new Error('Missing game data.')

    const groups = []
    for (const game of games) {
      if (!game || !isValidGameId(String(game.gameId))) continue
      const gameId = String(game.gameId)
      const rows = []
      for (const entry of Array.isArray(game.executables) ? game.executables : []) {
        if (!entry || typeof entry.name !== 'string') continue
        try {
          const { target } = this.targetFor(gameId, entry.name)
          rows.push({ executable: entry.name, os: entry.os, target })
        } catch {
          // A malformed catalog entry should not hide the status of every other game.
        }
      }
      groups.push({ gameId, rows })
    }

    const allPaths = groups.flatMap((group) => group.rows.map((row) => row.target))
    const processes = await this.findProcessesByPaths(allPaths)
    const byPath = new Map(processes.map((entry) => [pathKey(entry.path), entry]))

    const result = {}
    for (const group of groups) {
      const gameResult = {}
      for (const row of group.rows) {
        const process = byPath.get(pathKey(row.target))
        gameResult[row.executable] = {
          installed: existsSync(row.target),
          running: Boolean(process),
          pid: process?.pid ?? null,
          startedAt: process?.startedAt ?? null,
          path: row.target,
        }
      }
      result[group.gameId] = gameResult
    }

    return result
  }

  async install({ gameId, executableName }) {
    const { target, folder } = this.targetFor(gameId, executableName)

    if (!existsSync(this.runnerPath)) {
      throw new Error(
        'The runner executable is missing. Run "npm run runner:build" to create it.',
      )
    }

    await fs.mkdir(folder, { recursive: true })

    // Never replace a real game file. Runners copied by Questline carry a
    // recognizable window-class signature, so upgrades can still overwrite them.
    if (existsSync(target) && !(await isQuestlineRunner(target))) {
      throw new Error(
        `Refusing to replace an existing file that was not created by Questline: ${target}`,
      )
    }

    // Never overwrite a runner that is currently in use. Windows would reject
    // the write anyway, but returning a useful message is friendlier.
    const running = await this.findProcessesByPaths([target])
    if (running.length === 0) {
      await fs.copyFile(this.runnerPath, target)
    }

    return { installed: true, path: target }
  }

  async launch({ gameId, gameName, executableName }) {
    const { target, folder, filename } = this.targetFor(gameId, executableName)
    const displayName =
      typeof gameName === 'string' && gameName.trim() ? gameName.trim() : filename

    const existing = await this.findProcessesByPaths([target])
    if (existing.length > 0) {
      const process = existing[0]
      const session = this.remember({
        gameId,
        gameName: displayName,
        executableName,
        path: target,
        pid: process.pid,
        startedAt: process.startedAt,
      })
      return { ...session, alreadyRunning: true }
    }

    await this.install({ gameId, executableName })

    const child = spawn(target, ['--title', displayName], {
      cwd: folder,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })

    if (!child.pid) {
      throw new Error('The runner process did not start.')
    }

    const session = this.remember({
      gameId,
      gameName: displayName,
      executableName,
      path: target,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    })

    child.once('error', (error) => {
      this.forget(gameId, executableName)
      this.onEvent({ type: 'error', session, message: error.message })
    })

    child.once('exit', () => {
      const removed = this.forget(gameId, executableName)
      if (removed) {
        this.onEvent({ type: 'ended', session: removed })
      }
    })

    child.unref()

    return { ...session, alreadyRunning: false }
  }

  remember(session) {
    const value = {
      ...session,
      key: this.sessionKey(session.gameId, session.executableName),
    }
    this.sessions.set(value.key, value)
    return value
  }

  forget(gameId, executableName) {
    const key = this.sessionKey(gameId, executableName)
    const value = this.sessions.get(key)
    if (value) this.sessions.delete(key)
    return value
  }

  async stop({ gameId, executableName }) {
    const { target } = this.targetFor(gameId, executableName)
    const processes = await this.findProcessesByPaths([target])
    let stopped = 0

    for (const process of processes) {
      if (await this.killPid(process.pid)) stopped++
    }

    const session = this.forget(gameId, executableName)
    if (stopped === 0 && session) {
      // The path query can fail while the process is still alive. Verify the
      // PID still points at the expected runner before using the fallback.
      const current = await this.findProcessById(session.pid)
      if (current && pathKey(current.path) === pathKey(target)) {
        if (await this.killPid(session.pid)) stopped++
      }
    }

    return { stopped }
  }

  async stopAll() {
    await this.ensureRoot()
    let stopped = 0
    let broadStopCompleted = false

    // A drive root would otherwise match nearly every process on the drive.
    if (!this.isFilesystemRoot()) {
      try {
        const output = await runPowerShell(KILL_ROOT, {
          QUESTLINE_ROOT: this.gamesDirectory,
        })
        stopped = Number.parseInt(output, 10) || 0
        broadStopCompleted = true
      } catch {
        // Fall back to the sessions we know about.
      }
    }

    if (!broadStopCompleted) {
      for (const session of [...this.sessions.values()]) {
        const current = await this.findProcessById(session.pid)
        if (
          current &&
          pathKey(current.path) === pathKey(session.path) &&
          (await this.killPid(session.pid))
        ) {
          stopped++
        }
      }
    }

    const live = await this.listRunning().catch(() => null)
    const livePaths = live ? new Set(live.map((entry) => pathKey(entry.path))) : null
    const ended = []
    for (const [key, session] of [...this.sessions.entries()]) {
      if (!livePaths || !livePaths.has(pathKey(session.path))) {
        this.sessions.delete(key)
        ended.push(session)
      }
    }
    for (const session of ended) {
      this.onEvent({ type: 'ended', session })
    }

    return { stopped }
  }

  async listRunning() {
    await this.ensureRoot()
    let processes = []
    try {
      const output = await runPowerShell(ROOT_QUERY, {
        QUESTLINE_ROOT: this.gamesDirectory,
      })
      processes = parseProcessList(output)
    } catch {
      processes = [...this.sessions.values()].map((session) => ({
        pid: session.pid,
        path: session.path,
        startedAt: session.startedAt,
      }))
    }

    const root = path.resolve(this.gamesDirectory)
    const discovered = []

    for (const process of processes) {
      const relative = path.relative(root, process.path)
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        continue
      }
      const segments = relative.split(path.sep)
      if (segments.length < 2) continue
      const gameId = segments[0]
      const executableName = segments.slice(1).join('\\')
      const known = this.sessions.get(this.sessionKey(gameId, executableName))
      discovered.push({
        key: this.sessionKey(gameId, executableName),
        gameId,
        gameName: known?.gameName ?? null,
        executableName,
        path: process.path,
        pid: process.pid,
        startedAt: known?.startedAt ?? process.startedAt,
      })
    }

    return discovered
  }

  async findProcessesByPaths(paths) {
    if (!paths.length) return []
    try {
      const output = await runPowerShell(PROCESS_QUERY, {
        QUESTLINE_PATHS: JSON.stringify(paths),
      })
      return parseProcessList(output)
    } catch {
      return []
    }
  }

  async findProcessById(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null
    try {
      const output = await runPowerShell(PROCESS_BY_PID, {
        QUESTLINE_PID: String(pid),
      })
      return parseProcessList(output)[0] || null
    } catch {
      return null
    }
  }

  isFilesystemRoot() {
    return path.parse(this.gamesDirectory).root.toLowerCase() === this.gamesDirectory.toLowerCase()
  }

  async killPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
      })
      return true
    } catch {
      return false
    }
  }
}

export function makeRunnerPath(rootDirectory, isPackaged) {
  if (isPackaged) {
    return path.join(process.resourcesPath, 'runner.exe')
  }
  return path.join(rootDirectory, 'resources', 'runner.exe')
}
