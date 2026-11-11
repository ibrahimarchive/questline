import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const DATA_SOURCES = {
  DISCORD: 'Discord API',
  BUNDLED: 'Bundled snapshot',
  CACHE: 'Cached snapshot',
}

const DISCORD_URL = 'https://discord.com/api/applications/detectable'

function normalizeGameList(input) {
  if (!Array.isArray(input)) return []

  return input
    .filter(
      (game) =>
        game &&
        game.id &&
        typeof game.name === 'string' &&
        Array.isArray(game.executables) &&
        game.executables.length > 0,
    )
    .map((game) => ({
      id: String(game.id),
      name: game.name.trim(),
      aliases: Array.isArray(game.aliases)
        ? game.aliases.filter((alias) => typeof alias === 'string' && alias.trim())
        : [],
      icon:
        typeof game.icon_hash === 'string'
          ? game.icon_hash
          : typeof game.icon === 'string'
            ? game.icon
            : null,
      executables: game.executables
        .filter((executable) => executable && executable.name && executable.os)
        .map((executable) => ({
          name: String(executable.name),
          os: String(executable.os),
          is_launcher: Boolean(executable.is_launcher),
        })),
    }))
    .filter((game) => game.executables.length > 0)
}

function isValidGameList(input) {
  if (!Array.isArray(input) || input.length <= 1000) return false

  const ids = new Set()
  for (const game of input) {
    if (!game || typeof game !== 'object') return false
    if (typeof game.name !== 'string' || !game.name.trim()) return false
    if (!Array.isArray(game.executables)) return false
    if (typeof game.id !== 'string' && typeof game.id !== 'number') return false
    const id = String(game.id)
    if (!/^\d{1,25}$/.test(id) || ids.has(id)) return false
    ids.add(id)
  }

  return true
}

async function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'Questline/1.0 (+https://github.com/ibrahimarchive/questline)',
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function loadGameData({ bundledPath, cachePath }) {
  const cached = await readJson(cachePath)
  if (cached && isValidGameList(cached.games)) {
    return {
      games: cached.games,
      source: cached.source || DATA_SOURCES.CACHE,
      updatedAt: cached.updatedAt || null,
      cached: true,
    }
  }

  const bundled = await readJson(bundledPath)
  if (!isValidGameList(bundled)) {
    throw new Error('The bundled game list is missing or invalid.')
  }

  let updatedAt = null
  try {
    updatedAt = (await fs.stat(bundledPath)).mtime.toISOString()
  } catch {
    // Not fatal; the list is still usable.
  }

  return {
    games: normalizeGameList(bundled),
    source: DATA_SOURCES.BUNDLED,
    updatedAt,
    cached: false,
  }
}

export async function refreshGameData({ cachePath }) {
  try {
    const raw = await fetchJson(DISCORD_URL)
    if (!isValidGameList(raw)) {
      throw new Error('The response did not look like a Discord game list.')
    }

    const games = normalizeGameList(raw)
    const payload = {
      version: 2,
      source: DATA_SOURCES.DISCORD,
      updatedAt: new Date().toISOString(),
      games,
    }

    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(payload))
      await fs.rename(temporary, cachePath)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }

    return {
      games,
      source: payload.source,
      updatedAt: payload.updatedAt,
      cached: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not refresh the game list. ${message}`)
  }
}
