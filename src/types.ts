export type Page = 'board' | 'activity' | 'settings'
export type Theme = 'dark' | 'light' | 'system'
export type LogType = 'info' | 'success' | 'warning' | 'error'

export interface GameExecutable {
  name: string
  os: string
  is_launcher: boolean
}

export interface Game {
  id: string
  name: string
  aliases: string[]
  icon: string | null
  executables: GameExecutable[]
}

export interface GameData {
  games: Game[]
  source: string
  updatedAt: string | null
  cached: boolean
}

export interface Settings {
  gamesDirectory: string
  stopGamesOnQuit: boolean
  autoRefresh: boolean
  theme: Theme
}

export interface LogEntry {
  id: string
  type: LogType
  message: string
  timestamp: string
  gameId?: string
}

export interface StoredState {
  settings: Settings
  library: string[]
  logs: LogEntry[]
}

export interface InspectEntry {
  installed: boolean
  running: boolean
  pid: number | null
  startedAt: string | null
  path: string
}

export type InspectMap = Record<string, Record<string, InspectEntry>>

export interface Session {
  key: string
  gameId: string
  gameName: string | null
  executableName: string
  path: string
  pid: number
  startedAt: string
  alreadyRunning?: boolean
}

export interface AppInfo {
  version: string
  platform: string
  userData: string
  runnerPath: string
}

export interface RpcStatus {
  connected: boolean
  appId: string | null
  since: number | null
}

export interface RunnerEvent {
  type: 'started' | 'ended' | 'error'
  session: Session
  message?: string
}

export interface Toast {
  id: number
  type: 'success' | 'error' | 'info' | 'warning'
  title: string
  message?: string
}

interface QuestlineApi {
  getState: () => Promise<StoredState>
  saveState: (state: StoredState) => Promise<StoredState>
  getAppInfo: () => Promise<AppInfo>
  loadGames: () => Promise<GameData>
  refreshGames: () => Promise<GameData>
  inspectGames: (payload: {
    games: Array<{ gameId: string; executables: GameExecutable[] }>
  }) => Promise<InspectMap>
  installGame: (payload: {
    gameId: string
    executableName: string
  }) => Promise<{ installed: boolean; path: string }>
  launchGame: (payload: {
    gameId: string
    gameName: string
    executableName: string
  }) => Promise<Session>
  stopGame: (payload: {
    gameId: string
    executableName: string
  }) => Promise<{ stopped: number }>
  stopAll: () => Promise<{ stopped: number }>
  listRunning: () => Promise<Session[]>
  openPath: (target: string) => Promise<{ opened: string }>
  revealPath: (target: string) => Promise<{ revealed: boolean }>
  pickFolder: () => Promise<string | null>
  getDiscordStatus: () => Promise<{ online: boolean; checkedAt: number }>
  rpcConnect: (payload: { appId: string; name: string }) => Promise<RpcStatus>
  rpcDisconnect: () => Promise<RpcStatus>
  onRunnerEvent: (callback: (event: RunnerEvent) => void) => () => void
}

declare global {
  interface Window {
    questline: QuestlineApi
  }
}
