import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { discordRpc } from './discord-rpc.mjs'
import { loadGameData, refreshGameData } from './game-data.mjs'
import { RunnerService, makeRunnerPath } from './runner-service.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

if (process.env.QUESTLINE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.QUESTLINE_USER_DATA))
}

const DEFAULT_SETTINGS = {
  gamesDirectory: '',
  stopGamesOnQuit: false,
  autoRefresh: true,
  theme: 'dark',
}

let mainWindow = null
let state = null
let statePath = null
let runnerService = null
let cleanupComplete = false
let cleanupStarted = false
let saveQueue = Promise.resolve()
let saveSequence = 0
let discordStatusCache = { online: false, checkedAt: 0 }

const appEntryPath = path.join(projectRoot, 'dist', 'index.html')
const appEntryUrl = pathToFileURL(appEntryPath).href

function currentTheme() {
  return ['dark', 'light', 'system'].includes(state?.settings?.theme)
    ? state.settings.theme
    : 'dark'
}

function applyNativeTheme() {
  if (!state) return
  nativeTheme.themeSource = currentTheme()
  updateTitleBar()
}

function updateTitleBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const dark = nativeTheme.shouldUseDarkColors
  try {
    mainWindow.setTitleBarOverlay({
      color: dark ? '#0a0c12' : '#f5f6fa',
      symbolColor: dark ? '#aeb6c8' : '#3a4050',
      height: 44,
    })
  } catch {
    // Linux/macOS builds do not support the Windows title bar overlay.
  }
}

function resourcesDirectory() {
  return app.isPackaged ? process.resourcesPath : path.join(projectRoot, 'resources')
}

function bundledGamesPath() {
  return path.join(resourcesDirectory(), 'gamelist.json')
}

function gamesCachePath() {
  return path.join(app.getPath('userData'), 'gamelist-cache.json')
}

function runnerTemplatePath() {
  return makeRunnerPath(projectRoot, app.isPackaged)
}

function defaultGamesDirectory() {
  return path.join(app.getPath('userData'), 'games')
}

function publicState() {
  return {
    settings: { ...state.settings },
    library: [...state.library],
    logs: [...state.logs],
  }
}

function sanitiseSettings(input, base = state.settings) {
  const next = { ...base }
  if (!input || typeof input !== 'object') return next

  if (typeof input.gamesDirectory === 'string' && input.gamesDirectory.trim()) {
    if (path.isAbsolute(input.gamesDirectory)) {
      next.gamesDirectory = path.normalize(input.gamesDirectory)
    }
  }
  if (typeof input.stopGamesOnQuit === 'boolean') {
    next.stopGamesOnQuit = input.stopGamesOnQuit
  }
  if (typeof input.autoRefresh === 'boolean') {
    next.autoRefresh = input.autoRefresh
  }
  if (['dark', 'light', 'system'].includes(input.theme)) {
    next.theme = input.theme
  }
  return next
}

function sanitiseLibrary(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((id) => typeof id === 'string' && /^\d{1,25}$/.test(id)))]
}

function sanitiseLogs(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (entry) =>
        entry &&
        typeof entry.message === 'string' &&
        ['info', 'success', 'warning', 'error'].includes(entry.type),
    )
    .slice(0, 300)
    .map((entry) => ({
      id: String(entry.id || `${Date.now()}-${Math.random()}`),
      type: entry.type,
      message: entry.message.slice(0, 2000),
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
      gameId: typeof entry.gameId === 'string' ? entry.gameId : undefined,
    }))
}

async function loadState() {
  statePath = path.join(app.getPath('userData'), 'questline-state.json')
  let parsed = null
  try {
    parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  } catch {
    parsed = null
  }

  const settings = sanitiseSettings(parsed?.settings, DEFAULT_SETTINGS)
  if (!settings.gamesDirectory) settings.gamesDirectory = defaultGamesDirectory()

  state = {
    settings,
    library: sanitiseLibrary(parsed?.library),
    logs: sanitiseLogs(parsed?.logs),
    window: parsed?.window || null,
  }

  try {
    await fsp.mkdir(state.settings.gamesDirectory, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.logs.unshift({
      id: `startup-${Date.now()}`,
      type: 'warning',
      message: `The games folder is unavailable: ${message}`,
      timestamp: new Date().toISOString(),
    })
    state.logs = state.logs.slice(0, 300)
  }

  try {
    await saveStateFile()
  } catch (error) {
    console.error('Could not save the initial state:', error)
  }
}

async function saveStateFile() {
  if (!statePath || !state) return
  const payload = JSON.stringify(
    {
      version: 1,
      settings: state.settings,
      library: state.library,
      logs: state.logs,
      window: state.window,
    },
    null,
    2,
  )

  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    const temporary = `${statePath}.${process.pid}.${++saveSequence}.tmp`
    try {
      await fsp.writeFile(temporary, payload)
      await fsp.rename(temporary, statePath)
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined)
    }
  })
  return saveQueue
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function register(channel, handler) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const data = await handler(payload)
      return { data }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'
      return { error: message }
    }
  })
}

async function createWindow() {
  const saved = state.window
  const width = Number.isFinite(saved?.width) ? Math.max(1000, saved.width) : 1240
  const height = Number.isFinite(saved?.height) ? Math.max(680, saved.height) : 820

  mainWindow = new BrowserWindow({
    width,
    height,
    x: Number.isFinite(saved?.x) ? saved.x : undefined,
    y: Number.isFinite(saved?.y) ? saved.y : undefined,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0c12',
    title: 'Questline',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0c12',
      symbolColor: '#aeb6c8',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  Menu.setApplicationMenu(null)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed = false
    try {
      if (isDev && process.env.VITE_DEV_SERVER_URL) {
        allowed = new URL(url).origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
      } else {
        const target = new URL(url)
        allowed =
          target.protocol === 'file:' && target.pathname === new URL(appEntryUrl).pathname
      }
    } catch {
      allowed = false
    }
    if (!allowed) event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    updateTitleBar()

    if (process.env.QC_SCREENSHOT) {
      const delay = Number(process.env.QC_SCREENSHOT_DELAY || 3000)
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage()
          await fsp.writeFile(process.env.QC_SCREENSHOT, image.toPNG())
          console.log(`Screenshot saved to ${process.env.QC_SCREENSHOT}`)
        } catch (error) {
          console.error('Screenshot failed:', error)
        } finally {
          app.quit()
        }
      }, delay)
    }
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(appEntryPath)
  }

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !process.env.QC_SCREENSHOT) {
    mainWindow.show()
  }

  mainWindow.on('close', () => {
    if (!mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds()
      state.window = bounds
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupRunnerService() {
  runnerService = new RunnerService({
    gamesDirectory: state.settings.gamesDirectory,
    runnerPath: runnerTemplatePath(),
    onEvent: (event) => broadcast('runner:event', event),
  })
}

function setupIpc() {
  register('state:get', async () => publicState())

  register('state:save', async (payload) => {
    const previousDirectory = state.settings.gamesDirectory
    state.settings = sanitiseSettings(payload?.settings)
    state.library = Array.isArray(payload?.library)
      ? sanitiseLibrary(payload.library)
      : state.library
    state.logs = Array.isArray(payload?.logs) ? sanitiseLogs(payload.logs) : state.logs

    if (state.settings.gamesDirectory !== previousDirectory) {
      await fsp.mkdir(state.settings.gamesDirectory, { recursive: true })
      runnerService.setGamesDirectory(state.settings.gamesDirectory)
    }

    applyNativeTheme()
    await saveStateFile()
    return publicState()
  })

  register('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    runnerPath: runnerTemplatePath(),
  }))

  register('games:load', async () =>
    loadGameData({ bundledPath: bundledGamesPath(), cachePath: gamesCachePath() }),
  )

  register('games:refresh', async () =>
    refreshGameData({ cachePath: gamesCachePath() }),
  )

  register('runner:inspect-many', async (payload) => {
    if (!payload || !Array.isArray(payload.games)) throw new Error('Missing game data.')
    return runnerService.inspectMany(payload.games)
  })

  register('runner:install', async (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Missing game data.')
    return runnerService.install({
      gameId: payload.gameId,
      executableName: payload.executableName,
    })
  })

  register('runner:launch', async (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Missing game data.')
    return runnerService.launch({
      gameId: payload.gameId,
      gameName: payload.gameName,
      executableName: payload.executableName,
    })
  })

  register('runner:stop', async (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('Missing game data.')
    return runnerService.stop({
      gameId: payload.gameId,
      executableName: payload.executableName,
    })
  })

  register('runner:stop-all', async () => runnerService.stopAll())
  register('runner:list', async () => runnerService.listRunning())

  register('shell:open-path', async (target) => {
    if (typeof target !== 'string' || !target) throw new Error('No path supplied.')
    const resolved = path.resolve(target)
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
    return { opened: resolved }
  })

  register('shell:reveal-path', async (target) => {
    if (typeof target !== 'string' || !target) throw new Error('No path supplied.')
    shell.showItemInFolder(path.resolve(target))
    return { revealed: true }
  })

  register('shell:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a games folder',
      defaultPath: state.settings.gamesDirectory,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  register('discord:status', async () => {
    if (Date.now() - discordStatusCache.checkedAt < 10_000) {
      return discordStatusCache
    }

    let online = false
    for (const processName of ['Discord.exe', 'DiscordCanary.exe', 'DiscordPTB.exe']) {
      try {
        const { stdout } = await execFileAsync(
          'tasklist.exe',
          ['/FI', `IMAGENAME eq ${processName}`, '/NH'],
          { windowsHide: true, timeout: 5000 },
        )
        if (stdout.toLowerCase().includes(processName.toLowerCase())) {
          online = true
          break
        }
      } catch {
        // tasklist is not available; leave the status offline.
      }
    }

    discordStatusCache = { online, checkedAt: Date.now() }
    return discordStatusCache
  })

  register('rpc:connect', async (payload) => {
    const appId = String(payload?.appId || '')
    if (!/^\d{1,25}$/.test(appId)) throw new Error('The application id is invalid.')
    const name = String(payload?.name || 'Discord game').slice(0, 120)
    await discordRpc.connect(appId)
    await discordRpc.setActivity({ name })
    return discordRpc.status()
  })

  register('rpc:disconnect', async () => {
    await discordRpc.disconnect(true)
    return discordRpc.status()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app
    .whenReady()
    .then(async () => {
      await loadState()
      applyNativeTheme()
      setupRunnerService()
      setupIpc()
      await createWindow()

      nativeTheme.on('updated', updateTitleBar)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error) => {
      console.error('Questline failed to start:', error)
      const message = error instanceof Error ? error.message : String(error)
      try {
        dialog.showErrorBox('Questline could not start', message)
      } catch {
        // The dialog is best-effort during early startup failures.
      }
      app.quit()
    })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (cleanupComplete || !state) return

    // This must run synchronously: Electron does not await async listeners.
    event.preventDefault()
    if (cleanupStarted) return
    cleanupStarted = true

    void (async () => {
      try {
        await saveStateFile()
      } catch {
        // Best effort.
      }

      if (state.settings.stopGamesOnQuit && runnerService) {
        try {
          await runnerService.stopAll()
        } catch {
          // Continue quitting regardless.
        }
        try {
          await discordRpc.disconnect(true)
        } catch {
          // Continue quitting regardless.
        }
      }

      cleanupComplete = true
      app.quit()
    })()
  })
}
