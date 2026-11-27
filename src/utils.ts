import type { Game, GameExecutable } from './types'

// Intl formatters are relatively expensive to construct, and these helpers are
// called from frequently re-rendered templates.
const numberFormatter = new Intl.NumberFormat('en-US')
const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

let detectedPlatform: string | null = null

export function formatNumber(value: number): string {
  return numberFormatter.format(value)
}

export function formatDuration(milliseconds: number, style: 'clock' | 'short' = 'clock'): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (style === 'short') {
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function elapsedFormat(startedAt: string | number | Date, now = Date.now()): string {
  const started = startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime()
  if (!Number.isFinite(started)) return '00:00'
  return formatDuration(Math.max(0, now - started))
}

export function formatRelativeTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const delta = Date.now() - date.getTime()
  if (!Number.isFinite(delta)) return 'Unknown'

  const seconds = Math.round(delta / 1000)
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return shortDateFormatter.format(date)
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return dateTimeFormatter.format(date)
}

export function gameIconUrl(game: Game, size = 128): string | null {
  if (!game.icon) return null
  return `https://cdn.discordapp.com/app-icons/${game.id}/${game.icon}.png?size=${size}`
}

export function initials(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function hashHue(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash % 360
}

export function splitExecutable(name: string): { folders: string[]; filename: string } {
  const parts = name.replace(/\//g, '\\').split('\\').filter(Boolean)
  const filename = parts.pop() || name
  return { folders: parts, filename }
}

export function canonicalExecutableName(name: string): string {
  return name.replace(/\//g, '\\').split('\\').filter(Boolean).join('\\').toLowerCase()
}

export function sessionKeyFor(gameId: string, executableName: string): string {
  return `${gameId}::${canonicalExecutableName(executableName)}`
}

export function executableLabel(name: string): string {
  return splitExecutable(name).filename.replace(/\.[^.]+$/, '')
}

export function currentPlatform(): string {
  if (detectedPlatform) return detectedPlatform
  if (navigator.userAgent.includes('Mac')) detectedPlatform = 'darwin'
  else if (navigator.userAgent.includes('Linux')) detectedPlatform = 'linux'
  else detectedPlatform = 'win32'
  return detectedPlatform
}

export function isUsableExecutable(executable: GameExecutable): boolean {
  if (!executable.name) return false
  const normalized = executable.name.replace(/\//g, '\\')
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('\\')) return false
  const segments = normalized.split('\\').filter(Boolean)
  if (!segments.length) return false
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
  }
  return true
}

export function isExecutableForCurrentPlatform(executable: GameExecutable): boolean {
  return executable.os === currentPlatform()
}

export function availableExecutables(game: Game): GameExecutable[] {
  return game.executables.filter(
    (entry) => isUsableExecutable(entry) && isExecutableForCurrentPlatform(entry),
  )
}

export function preferredExecutable(game: Game): GameExecutable | null {
  const usable = availableExecutables(game)
  return usable.find((entry) => !entry.is_launcher) || usable[0] || null
}

export function normalizePlatform(os: string): string {
  if (os === 'win32') return 'Windows'
  if (os === 'darwin') return 'macOS'
  if (os === 'linux') return 'Linux'
  return os
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
