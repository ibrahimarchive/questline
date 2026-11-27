import { computed, reactive, shallowRef } from 'vue'
import type {
  AppInfo,
  Game,
  GameData,
  GameExecutable,
  InspectEntry,
  InspectMap,
  LogEntry,
  LogType,
  Page,
  RpcStatus,
  RunnerEvent,
  Session,
  Settings,
  StoredState,
  Toast,
} from './types'
import {
  availableExecutables,
  executableLabel,
  formatNumber,
  isExecutableForCurrentPlatform,
  isUsableExecutable,
  preferredExecutable,
  sessionKeyFor,
} from './utils'

const SUGGESTION_IDS = [
  '1402418703554842694', // Fortnite
  '700136079562375258', // VALORANT
  '356875221078245376', // Overwatch
  '542075586886107149', // Apex Legends
  '762434991303950386', // Genshin Impact
  '363445589247131668', // ROBLOX
  '1158877933042143272', // Counter-Strike 2
  '356877880938070016', // Rocket League
  '1121201675240210523', // Honkai: Star Rail
  '1402418440685486130', // Among Us
]

const MAX_LOGS = 300
export const SEARCH_RESULT_LIMIT = 24

interface SearchEntry {
  game: Game
  name: string
  aliases: string[]
  executables: string[]
}

interface AppState {
  ready: boolean
  booting: boolean
  bootStep: string
  fatalError: string
  page: Page
  games: Game[]
  source: string
  updatedAt: string | null
  library: string[]
  selectedId: string | null
  inspect: InspectMap
  inspecting: boolean
  sessions: Session[]
  query: string
  results: Game[]
  searchOpen: boolean
  searchBusy: boolean
  logs: LogEntry[]
  settings: Settings
  appInfo: AppInfo | null
  discordOnline: boolean
  discordCheckedAt: number
  refreshing: boolean
  refreshMessage: string
  rpc: RpcStatus
  rpcBusy: boolean
  now: number
  busyKey: string
  toasts: Toast[]
}

const defaultSettings: Settings = {
  gamesDirectory: '',
  stopGamesOnQuit: false,
  autoRefresh: true,
  theme: 'dark',
}

export const state = reactive<AppState>({
  ready: false,
  booting: true,
  bootStep: 'Starting Questline...',
  fatalError: '',
  page: 'board',
  games: [],
  source: '',
  updatedAt: null,
  library: [],
  selectedId: null,
  inspect: {},
  inspecting: false,
  sessions: [],
  query: '',
  results: [],
  searchOpen: false,
  searchBusy: false,
  logs: [],
  settings: { ...defaultSettings },
  appInfo: null,
  discordOnline: false,
  discordCheckedAt: 0,
  refreshing: false,
  refreshMessage: '',
  rpc: { connected: false, appId: null, since: null },
  rpcBusy: false,
  now: Date.now(),
  busyKey: '',
  toasts: [],
})

let gameIndex = shallowRef<Map<string, Game>>(new Map())
let searchIndex: SearchEntry[] = []
let searchTimer: ReturnType<typeof setTimeout> | null = null
let pendingSearchGeneration = 0
let searchGeneration = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let initialized = false
let themeListenerAttached = false
let clockStarted = false
let eventUnsubscribe: (() => void) | null = null
let toastSequence = 0
let inspectGeneration = 0
let lastSessionPoll = 0

export const selectedGame = computed(() => {
  if (!state.selectedId) return null
  return gameIndex.value.get(state.selectedId) || null
})

export const libraryGames = computed(() =>
  state.library.map((id) => gameIndex.value.get(id)).filter((game): game is Game => Boolean(game)),
)

export const suggestedGames = computed(() => {
  const result: Game[] = []
  for (const id of SUGGESTION_IDS) {
    const game = gameIndex.value.get(id)
    if (game) result.push(game)
  }
  return result.slice(0, 6)
})

export const runningCount = computed(() => state.sessions.length)

export function gameIsRunning(gameId: string): boolean {
  if (state.sessions.some((session) => session.gameId === gameId)) return true
  const rows = state.inspect[gameId]
  return Boolean(rows && Object.values(rows).some((entry) => entry.running))
}

export function executableStatus(
  gameId: string,
  executable: GameExecutable,
): InspectEntry | null {
  return state.inspect[gameId]?.[executable.name] || null
}

export function gameInstalled(gameId: string): boolean {
  const rows = state.inspect[gameId]
  return Boolean(rows && Object.values(rows).some((entry) => entry.installed))
}

export function gameSession(gameId: string): Session | null {
  return state.sessions.find((session) => session.gameId === gameId) || null
}

export function elapsedFor(session: Session): number {
  const started = new Date(session.startedAt).getTime()
  if (!Number.isFinite(started)) return 0
  return Math.max(0, state.now - started)
}

export function libraryGameFor(gameId: string): Game | null {
  return gameIndex.value.get(gameId) || null
}

export function setPage(page: Page) {
  state.page = page
}

function applyTheme() {
  const theme = state.settings.theme
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved

  if (!themeListenerAttached) {
    themeListenerAttached = true
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => {
        if (state.settings.theme === 'system') applyTheme()
      })
  }
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function subsequenceScore(query: string, text: string): number {
  let queryIndex = 0
  let gapCount = 0
  let lastMatch = -1

  for (let index = 0; index < text.length && queryIndex < query.length; index++) {
    if (text[index] === query[queryIndex]) {
      if (lastMatch >= 0) gapCount += index - lastMatch - 1
      lastMatch = index
      queryIndex++
    }
  }

  if (queryIndex !== query.length) return -1
  return Math.max(40, 260 - gapCount * 8 - text.length * 0.4)
}

function scoreEntry(entry: SearchEntry, query: string, tokens: string[]): number {
  if (!query) return 0

  let score = 0

  if (entry.name === query) score = 1200
  else if (entry.name.startsWith(query)) score = 920 - Math.min(entry.name.length, 120)
  else {
    const index = entry.name.indexOf(query)
    if (index >= 0) score = 760 - index * 4 - Math.min(entry.name.length, 120)
  }

  for (const alias of entry.aliases) {
    if (alias === query) score = Math.max(score, 1080)
    else if (alias.startsWith(query)) score = Math.max(score, 860 - alias.length)
    else if (alias.includes(query)) score = Math.max(score, 680 - alias.indexOf(query) * 3)
  }

  if (score === 0 && tokens.length > 1) {
    const haystack = `${entry.name} ${entry.aliases.join(' ')}`
    if (tokens.every((token) => haystack.includes(token))) {
      score = 560 - Math.min(entry.name.length, 100)
    }
  }

  if (score === 0 && query.length >= 3) {
    score = Math.max(score, subsequenceScore(query, entry.name))
    if (score < 0) score = 0
  }

  if (score === 0 && entry.executables.some((name) => name.includes(query))) {
    score = 220
  }

  return score
}

function buildSearchIndex(games: Game[]) {
  searchIndex = games.map((game) => ({
    game,
    name: normalizeSearchText(game.name),
    aliases: game.aliases.map(normalizeSearchText).filter(Boolean),
    executables: game.executables.map((entry) => normalizeSearchText(executableLabel(entry.name))),
  }))
}

export function setQuery(value: string, immediate = false) {
  state.query = value
  state.searchOpen = true

  if (searchTimer) clearTimeout(searchTimer)
  const generation = ++searchGeneration
  pendingSearchGeneration = generation
  const run = () => runSearch(value, generation)

  if (immediate) {
    searchTimer = null
    run()
  } else {
    searchTimer = setTimeout(() => {
      searchTimer = null
      run()
    }, 90)
  }
}

export function flushSearch(): boolean {
  if (!searchTimer) return false
  clearTimeout(searchTimer)
  searchTimer = null
  runSearch(state.query, pendingSearchGeneration)
  return true
}

function runSearch(rawQuery: string, generation: number) {
  const query = normalizeSearchText(rawQuery)
  if (!query) {
    state.results = []
    state.searchBusy = false
    return
  }

  state.searchBusy = true
  const tokens = query.split(' ').filter(Boolean)
  const scored: Array<{ game: Game; score: number }> = []

  for (const entry of searchIndex) {
    const score = scoreEntry(entry, query, tokens)
    if (score > 0) scored.push({ game: entry.game, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.game.name.localeCompare(b.game.name)
  })

  if (generation === searchGeneration) {
    state.results = scored.slice(0, SEARCH_RESULT_LIMIT).map((row) => row.game)
    state.searchBusy = false
  }
}

export function openSearch() {
  state.searchOpen = true
}

export function closeSearch() {
  state.searchOpen = false
}

function resetGameData(data: GameData) {
  state.games = data.games
  state.source = data.source
  state.updatedAt = data.updatedAt
  gameIndex.value = new Map(data.games.map((game) => [game.id, game]))
  buildSearchIndex(data.games)
  if (state.selectedId && !gameIndex.value.has(state.selectedId)) {
    state.selectedId = state.library.find((id) => gameIndex.value.has(id)) || null
  }
}

function sanitiseLogs(logs: LogEntry[]): LogEntry[] {
  if (!Array.isArray(logs)) return []
  return logs
    .filter(
      (entry) =>
        entry &&
        typeof entry.message === 'string' &&
        ['info', 'success', 'warning', 'error'].includes(entry.type),
    )
    .slice(0, MAX_LOGS)
}

function applyStoredState(stored: StoredState) {
  if (!stored) return
  if (stored.settings) {
    state.settings = {
      ...defaultSettings,
      ...stored.settings,
      theme: ['dark', 'light', 'system'].includes(stored.settings.theme)
        ? stored.settings.theme
        : 'dark',
    }
  }
  if (Array.isArray(stored.library)) {
    state.library = [...new Set(stored.library.filter((id) => typeof id === 'string'))]
  }
  if (Array.isArray(stored.logs)) {
    state.logs = sanitiseLogs(stored.logs)
  }
}

export async function initialize(force = false) {
  if (initialized && !force) return
  initialized = true
  state.booting = true
  state.fatalError = ''
  state.bootStep = 'Reading your library...'

  startClock()
  attachTheme()
  attachRunnerEvents()

  try {
    const [storedResult, dataResult, appInfoResult] = await Promise.all([
      window.questline.getState(),
      window.questline.loadGames(),
      window.questline.getAppInfo(),
    ])

    state.bootStep = 'Indexing Discord games...'
    applyStoredState(storedResult)
    applyTheme()
    resetGameData(dataResult)

    const firstAvailable = state.library.find((id) => gameIndex.value.has(id)) || null
    if (!firstAvailable) {
      state.selectedId = null
    } else if (!state.selectedId || !gameIndex.value.has(state.selectedId)) {
      state.selectedId = firstAvailable
    }

    state.appInfo = appInfoResult

    if (!state.logs.length) {
      addLog('info', `Questline ready with ${formatNumber(dataResult.games.length)} games.`)
    } else {
      addLog('info', 'Questline started.')
    }

    state.bootStep = 'Checking running sessions...'
    await Promise.all([inspectLibrary(), refreshSessions(), refreshDiscordStatus()])
    state.ready = true
    state.booting = false

    const age = dataResult.updatedAt ? Date.now() - new Date(dataResult.updatedAt).getTime() : Infinity
    if (state.settings.autoRefresh && (!dataResult.cached || age > 12 * 60 * 60 * 1000)) {
      setTimeout(() => void refreshGames(false), 800)
    }
  } catch (error) {
    state.fatalError =
      error instanceof Error ? error.message : 'Questline could not start correctly.'
    state.booting = false
    state.ready = false
    initialized = false
  }
}

function startClock() {
  if (clockStarted) return
  clockStarted = true
  window.setInterval(() => {
    state.now = Date.now()
    if (Date.now() - state.discordCheckedAt > 20_000) {
      void refreshDiscordStatus()
    }
    if (state.sessions.length && Date.now() - lastSessionPoll > 15_000) {
      lastSessionPoll = Date.now()
      void refreshSessions(true)
    }
  }, 1000)
}

function attachTheme() {
  applyTheme()
}

function attachRunnerEvents() {
  if (eventUnsubscribe) return
  eventUnsubscribe = window.questline.onRunnerEvent((event) => {
    void handleRunnerEvent(event)
  })
}

async function handleRunnerEvent(event: RunnerEvent) {
  if (event.type === 'ended') {
    const before = state.sessions.length
    state.sessions = state.sessions.filter((session) => session.key !== event.session.key)
    if (before !== state.sessions.length) {
      addLog('info', `${event.session.gameName || 'Game'} session ended.`, event.session.gameId)
      pushToast('info', 'Session ended', `${event.session.gameName || 'The game'} is no longer running.`)
    }
    await inspectLibrary()
  } else if (event.type === 'error') {
    addLog('error', event.message || 'The runner reported an error.', event.session.gameId)
    pushToast('error', 'Runner error', event.message)
  }
}

async function refreshSessions(silent = false) {
  lastSessionPoll = Date.now()
  try {
    const sessions = await window.questline.listRunning()
    state.sessions = sessions.map((session) => ({
      ...session,
      gameName: session.gameName || gameIndex.value.get(session.gameId)?.name || null,
    }))
  } catch (error) {
    if (!silent) {
      console.error('Could not list running sessions:', error)
    }
  }
}

async function inspectLibrary() {
  const games = libraryGames.value
    .map((game) => ({ game, executables: availableExecutables(game) }))
    .filter((entry) => entry.executables.length > 0)
  if (!games.length) {
    state.inspect = {}
    state.inspecting = false
    return
  }

  const generation = ++inspectGeneration
  state.inspecting = true
  try {
    const result = await window.questline.inspectGames({
      games: games.map(({ game, executables }) => ({ gameId: game.id, executables })),
    })
    if (generation !== inspectGeneration) return
    state.inspect = { ...state.inspect, ...result }
  } catch (error) {
    console.error('Could not inspect game files:', error)
  } finally {
    if (generation === inspectGeneration) state.inspecting = false
  }
}

export function addToLibrary(game: Game) {
  if (!state.library.includes(game.id)) {
    state.library.push(game.id)
    addLog('info', `Added ${game.name} to the library.`, game.id)
  }
  state.selectedId = game.id
  state.searchOpen = false
  state.query = ''
  state.results = []
  schedulePersist()
  void inspectLibrary()
  void refreshSessions(true)
}

export function removeFromLibrary(game: Game) {
  if (gameIsRunning(game.id)) {
    pushToast('warning', 'Game is active', 'Stop the session before removing it from your library.')
    return
  }
  state.library = state.library.filter((id) => id !== game.id)
  if (state.selectedId === game.id) {
    state.selectedId = state.library[0] || null
  }
  if (state.rpc.connected && state.rpc.appId === game.id) {
    void disconnectRpc()
  }
  delete state.inspect[game.id]
  addLog('info', `Removed ${game.name} from the library.`, game.id)
  schedulePersist()
}

export function selectGame(gameId: string) {
  state.selectedId = gameId
}

function addLog(type: LogType, message: string, gameId?: string) {
  state.logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    message,
    timestamp: new Date().toISOString(),
    gameId,
  })
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS
  schedulePersist()
}

export function clearLogs() {
  state.logs = []
  schedulePersist()
}

export function pushToast(
  type: Toast['type'],
  title: string,
  message?: string,
  duration = 4200,
) {
  const id = ++toastSequence
  state.toasts.push({ id, type, title, message })
  window.setTimeout(() => dismissToast(id), duration)
}

export function dismissToast(id: number) {
  state.toasts = state.toasts.filter((toast) => toast.id !== id)
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistNow()
  }, 500)
}

function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }

  const snapshot: StoredState = {
    settings: { ...state.settings },
    library: [...state.library],
    logs: state.logs.map((entry) => ({ ...entry })),
  }

  saveChain = saveChain
    .catch(() => undefined)
    .then(() => window.questline.saveState(snapshot))
    .then(() => undefined)
    .catch((error) => {
      console.error('Could not save state:', error)
    })

  return saveChain
}

export async function startGame(game: Game, executable?: GameExecutable) {
  const target = executable || preferredExecutable(game)
  if (!target || !isUsableExecutable(target) || !isExecutableForCurrentPlatform(target)) {
    pushToast('error', 'No executable', `${game.name} has no usable executable registered.`)
    return
  }

  if (gameIsRunning(game.id)) {
    pushToast('info', 'Already running', `${game.name} already has an active session.`)
    return
  }

  state.busyKey = sessionKeyFor(game.id, target.name)
  const installed = executableStatus(game.id, target)?.installed
  addLog(
    'info',
    installed
      ? `Launching ${game.name} (${executableLabel(target.name)}).`
      : `Preparing ${game.name} (${executableLabel(target.name)}).`,
    game.id,
  )

  try {
    if (!installed) {
      await window.questline.installGame({
        gameId: game.id,
        executableName: target.name,
      })
      addLog('success', `Game files ready for ${game.name}.`, game.id)
    }

    const session = await window.questline.launchGame({
      gameId: game.id,
      gameName: game.name,
      executableName: target.name,
    })

    const existing = state.sessions.filter((row) => row.key !== session.key)
    state.sessions = [...existing, { ...session, gameName: game.name }]
    addLog('success', `${game.name} is now running.`, game.id)
    pushToast(
      'success',
      session.alreadyRunning ? 'Session already active' : 'Game launched',
      `${game.name} is visible to Discord.`,
    )
    await inspectLibrary()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The game could not be started.'
    addLog('error', message, game.id)
    pushToast('error', 'Could not launch game', message)
  } finally {
    state.busyKey = ''
  }
}

interface StopTarget {
  gameId: string
  executableName: string
  key: string
  name: string
}

async function stopTarget(target: StopTarget, kind: 'game' | 'session') {
  state.busyKey = target.key
  try {
    const result = await window.questline.stopGame({
      gameId: target.gameId,
      executableName: target.executableName,
    })
    if (result.stopped > 0) {
      state.sessions = state.sessions.filter((session) => session.key !== target.key)
      addLog('info', `Stopped ${target.name}.`, target.gameId)
      pushToast('success', 'Session stopped', `${target.name} is no longer visible to Discord.`)
    } else {
      await refreshSessions(true)
      const stillRunning = state.sessions.some((session) => session.key === target.key)
      if (stillRunning) {
        addLog('warning', `${target.name} is still running.`, target.gameId)
        pushToast('warning', `Could not stop ${kind}`, `${target.name} is still running.`)
      } else {
        addLog('info', `${target.name} was not running.`, target.gameId)
        pushToast('info', 'Nothing to stop', `${target.name} was not running.`)
      }
    }
    await inspectLibrary()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The session could not be stopped.'
    addLog('error', message, target.gameId)
    pushToast('error', `Could not stop ${kind}`, message)
  } finally {
    state.busyKey = ''
  }
}

export async function stopGame(game: Game, executable?: GameExecutable) {
  const executableTarget = executable || preferredExecutable(game)
  if (!executableTarget) return
  await stopTarget(
    {
      gameId: game.id,
      executableName: executableTarget.name,
      key: sessionKeyFor(game.id, executableTarget.name),
      name: game.name,
    },
    'game',
  )
}

export async function stopSession(session: Session) {
  const game = gameIndex.value.get(session.gameId)
  await stopTarget(
    {
      gameId: session.gameId,
      executableName: session.executableName,
      key: session.key,
      name: game?.name || session.gameName || 'Game',
    },
    'session',
  )
}

export async function stopAllSessions() {
  if (!state.sessions.length) {
    pushToast('info', 'No active sessions', 'There is nothing running right now.')
    return
  }
  state.busyKey = 'all'
  try {
    const result = await window.questline.stopAll()
    await refreshSessions(true)
    const remaining = state.sessions.length

    if (result.stopped > 0) {
      if (remaining > 0) {
        addLog(
          'warning',
          `Stopped ${result.stopped} session${result.stopped === 1 ? '' : 's'}; ${remaining} still running.`,
        )
        pushToast(
          'warning',
          'Some sessions remain',
          `${remaining} session${remaining === 1 ? ' is' : 's are'} still running.`,
        )
      } else {
        addLog('info', `Stopped ${result.stopped} active session${result.stopped === 1 ? '' : 's'}.`)
        pushToast('success', 'All sessions stopped', 'Discord no longer sees any fake games.')
      }
    } else if (remaining > 0) {
      addLog('warning', 'The active sessions could not be stopped.')
      pushToast('warning', 'Could not stop sessions', 'The runners are still active.')
    } else {
      addLog('info', 'No active sessions were found.')
      pushToast('info', 'No sessions found', 'There is nothing running right now.')
    }

    await inspectLibrary()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sessions could not be stopped.'
    addLog('error', message)
    pushToast('error', 'Could not stop sessions', message)
  } finally {
    state.busyKey = ''
  }
}

export async function refreshGames(manual = true) {
  if (state.refreshing) return
  state.refreshing = true
  state.refreshMessage = 'Contacting Discord...'
  if (manual) addLog('info', 'Refreshing the Discord game list...')

  try {
    const data = await window.questline.refreshGames()
    state.refreshMessage = `Synced ${formatNumber(data.games.length)} games.`
    resetGameData(data)
    addLog('success', `Game list synced from ${data.source}: ${formatNumber(data.games.length)} games.`)
    if (manual) {
      pushToast('success', 'Game list updated', `${formatNumber(data.games.length)} detectable games.`)
    }
    await inspectLibrary()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The game list could not be refreshed.'
    state.refreshMessage = 'Refresh failed.'
    addLog('error', message)
    if (manual) pushToast('error', 'Refresh failed', message)
  } finally {
    state.refreshing = false
  }
}

async function refreshDiscordStatus() {
  try {
    const status = await window.questline.getDiscordStatus()
    state.discordOnline = status.online
    state.discordCheckedAt = Date.now()
  } catch {
    state.discordOnline = false
    state.discordCheckedAt = Date.now()
  }
}

export async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  state.settings[key] = value
  if (key === 'theme') applyTheme()
  await persistNow()
}

export async function chooseGamesFolder() {
  if (state.sessions.length) {
    pushToast(
      'info',
      'Sessions are active',
      'Stop active sessions before changing the games folder.',
    )
    return
  }
  try {
    const directory = await window.questline.pickFolder()
    if (!directory) return
    const previous = state.settings.gamesDirectory
    state.settings.gamesDirectory = directory
    await persistNow()
    addLog('info', `Games folder changed to ${directory}.`)
    if (previous) {
      state.inspect = {}
      await inspectLibrary()
    }
    pushToast('success', 'Folder updated', 'New game files will be created in the new location.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The folder could not be changed.'
    pushToast('error', 'Could not change folder', message)
  }
}

export async function openGamesFolder() {
  try {
    await window.questline.openPath(state.settings.gamesDirectory)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The folder could not be opened.'
    pushToast('error', 'Could not open folder', message)
  }
}

export async function openGameFolder(gameId: string) {
  const root = state.settings.gamesDirectory.replace(/[\\/]+$/, '')
  try {
    await window.questline.openPath(`${root}/${gameId}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The folder could not be opened.'
    pushToast('error', 'Game folder unavailable', message)
  }
}

export async function connectRpc(game: Game) {
  if (state.rpc.connected) {
    await disconnectRpc()
    return
  }

  state.rpcBusy = true
  try {
    const status = await window.questline.rpcConnect({ appId: game.id, name: game.name })
    state.rpc = status
    addLog('success', `Rich Presence connected for ${game.name}.`, game.id)
    pushToast('success', 'Rich Presence connected', 'Discord should now show this game.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Discord RPC could not connect.'
    addLog('error', message, game.id)
    pushToast('error', 'Rich Presence failed', message)
  } finally {
    state.rpcBusy = false
  }
}

export async function disconnectRpc() {
  state.rpcBusy = true
  try {
    state.rpc = await window.questline.rpcDisconnect()
    addLog('info', 'Rich Presence disconnected.')
    pushToast('info', 'Rich Presence disconnected')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Discord RPC could not disconnect.'
    pushToast('error', 'Could not disconnect', message)
  } finally {
    state.rpcBusy = false
  }
}
