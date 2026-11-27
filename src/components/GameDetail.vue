<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GameArt from './GameArt.vue'
import Icon from './Icon.vue'
import {
  connectRpc,
  disconnectRpc,
  elapsedFor,
  executableStatus,
  gameInstalled,
  gameSession,
  gameIsRunning,
  openGameFolder,
  pushToast,
  selectedGame,
  startGame,
  state,
  stopGame,
} from '@/store'
import type { GameExecutable } from '@/types'
import {
  availableExecutables,
  canonicalExecutableName,
  classNames,
  currentPlatform,
  elapsedFormat,
  formatDuration,
  normalizePlatform,
  preferredExecutable,
  sessionKeyFor,
  splitExecutable,
} from '@/utils'

const game = selectedGame
const wantsRpc = ref(false)

const usableExecutables = computed(() => (game.value ? availableExecutables(game.value) : []))

const platform = currentPlatform()

const preferred = computed(() => (game.value ? preferredExecutable(game.value) : null))
const platformLabel = computed(() => normalizePlatform(preferred.value?.os || platform))
const platformName = normalizePlatform(platform)

const executableRows = computed(() => {
  const current = game.value
  if (!current) return []
  return usableExecutables.value.map((executable) => {
    const status = executableStatus(current.id, executable)
    const busy = state.busyKey === sessionKeyFor(current.id, executable.name)
    const running = Boolean(status?.running)
    const installedExe = Boolean(status?.installed)
    const { folders, filename } = splitExecutable(executable.name)
    return {
      executable,
      folders,
      filename,
      osBadge: executable.os.replace('win32', 'WIN'),
      running,
      busy,
      isLauncher: executable.is_launcher,
      stateClass: running ? 'running' : installedExe ? 'installed' : 'missing',
      stateLabel: running ? 'Running' : installedExe ? 'Ready' : 'Not created',
      actionClass: running ? 'stop' : 'play',
      actionIcon: busy ? 'refresh' : running ? 'stop' : 'play',
      actionLabel: busy ? 'Working...' : running ? 'Stop' : 'Play',
    }
  })
})

const runningExecutable = computed(
  () => executableRows.value.find((row) => row.running)?.executable || null,
)

const runningSession = computed(() =>
  game.value ? gameSession(game.value.id) : null,
)

const activeExecutable = computed(() => {
  if (!game.value) return null
  if (runningSession.value) {
    const match = usableExecutables.value.find(
      (executable) =>
        canonicalExecutableName(executable.name) ===
        canonicalExecutableName(runningSession.value!.executableName),
    )
    if (match) return match
  }
  return runningExecutable.value
})

const isRunning = computed(() => (game.value ? gameIsRunning(game.value.id) : false))

const installed = computed(() => (game.value ? gameInstalled(game.value.id) : false))

const primaryBusy = computed(() => {
  if (!game.value || !preferred.value) return false
  return state.busyKey === sessionKeyFor(game.value.id, preferred.value.name)
})

const anyBusy = computed(() => Boolean(game.value && state.busyKey.startsWith(`${game.value.id}::`)))

const rpcForThisGame = computed(
  () => state.rpc.connected && state.rpc.appId === game.value?.id,
)

const rpcElsewhere = computed(
  () => state.rpc.connected && state.rpc.appId !== game.value?.id,
)

const primaryLabel = computed(() => {
  if (isRunning.value) return 'Stop session'
  if (primaryBusy.value) return 'Launching...'
  return installed.value ? 'Play again' : 'Install & play'
})

const questHint = computed(() => {
  if (isRunning.value) {
    const elapsed = runningSession.value ? formatDuration(elapsedFor(runningSession.value)) : null
    return elapsed
      ? `Session live for ${elapsed}. Keep Discord open until the quest is credited.`
      : 'Session is live. Keep Discord open until the quest is credited.'
  }
  if (installed.value) return 'Files are ready. Launch the game when Discord is open.'
  return 'Questline will create a tiny runner named after this game executable.'
})

const pathLabel = computed(() => {
  if (!game.value) return ''
  return `${state.settings.gamesDirectory.replace(/[\\/]+$/, '')}/${game.value.id}`
})

async function togglePrimary() {
  if (!game.value) return
  if (isRunning.value) {
    await stopGame(game.value, activeExecutable.value || preferred.value || undefined)
  } else {
    await startGame(game.value, preferred.value || undefined)
  }
}

async function toggleExecutable(executable: GameExecutable) {
  if (!game.value) return
  const status = executableStatus(game.value.id, executable)
  if (status?.running) {
    await stopGame(game.value, executable)
  } else {
    await startGame(game.value, executable)
  }
}

async function copyId() {
  if (!game.value) return
  try {
    await navigator.clipboard.writeText(game.value.id)
    pushToast('info', 'App ID copied', game.value.id)
  } catch {
    pushToast('error', 'Could not copy', 'Clipboard access is unavailable.')
  }
}

async function openFolder() {
  if (game.value) await openGameFolder(game.value.id)
}

async function confirmRpc() {
  if (!game.value) return
  wantsRpc.value = false
  await connectRpc(game.value)
}

async function toggleRpc() {
  if (!game.value) return
  if (rpcForThisGame.value) {
    await disconnectRpc()
  } else {
    wantsRpc.value = true
  }
}

watch(game, () => {
  wantsRpc.value = false
})
</script>

<template>
  <div class="detail">
    <template v-if="!game">
      <div class="detail-empty">
        <div class="detail-orbit">
          <span class="orbit-ring ring-one"></span>
          <span class="orbit-ring ring-two"></span>
          <span class="orbit-core"><Icon name="gamepad" :size="27" /></span>
          <span class="orbit-dot dot-one"></span>
          <span class="orbit-dot dot-two"></span>
        </div>
        <h3>Select a game</h3>
        <p>Choose a title from your library to prepare a runner, launch a session, or inspect its executables.</p>
        <div class="detail-mini-stats">
          <div>
            <strong>{{ state.library.length }}</strong>
            <span>in library</span>
          </div>
          <div>
            <strong>{{ state.sessions.length }}</strong>
            <span>live now</span>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="detail-scroll scroll-area">
        <div class="game-head">
          <GameArt :game="game" :size="66" :radius="18" glow />
          <div class="game-head-copy">
            <div class="game-title-row">
              <h2>{{ game.name }}</h2>
              <span class="verified-badge" title="Discord verified game">
                <Icon name="verified" :size="15" />
              </span>
            </div>
            <div class="game-meta">
              <button type="button" class="id-button" title="Copy app ID" @click="copyId">
                <span class="mono">{{ game.id }}</span>
                <Icon name="copy" :size="11" />
              </button>
              <span class="meta-exe">{{ game.executables.length }} executable{{ game.executables.length === 1 ? '' : 's' }}</span>
            </div>
          </div>
          <span
            :class="classNames('state-pill', isRunning ? 'live' : installed ? 'ready' : 'idle')"
          >
            <span :class="classNames('dot', isRunning && 'pulse')"></span>
            {{ isRunning ? 'Live' : installed ? 'Ready' : 'Not set up' }}
          </span>
        </div>

        <div class="quest-state" :class="{ live: isRunning }">
          <span class="quest-icon">
            <Icon :name="isRunning ? 'activity' : installed ? 'shield' : 'download'" :size="17" />
          </span>
          <div>
            <strong>{{ isRunning ? 'Quest session active' : installed ? 'Runner files ready' : 'No files created yet' }}</strong>
            <p>{{ questHint }}</p>
          </div>
          <span v-if="isRunning && runningSession" class="session-clock mono">
            {{ elapsedFormat(runningSession.startedAt, state.now) }}
          </span>
        </div>

        <div class="primary-actions">
          <button
            :class="classNames('btn btn-lg flex-1', isRunning ? 'btn-danger' : 'btn-primary')"
            type="button"
            :disabled="anyBusy || (!preferred && !isRunning)"
            @click="togglePrimary"
          >
            <Icon
              :name="primaryBusy ? 'refresh' : isRunning ? 'stop' : 'play'"
              :size="16"
              :class="{ spin: primaryBusy }"
            />
            {{ primaryLabel }}
          </button>
          <button
            class="btn btn-secondary btn-lg btn-icon"
            type="button"
            title="Open game folder"
            :disabled="!installed"
            @click="openFolder"
          >
            <Icon name="folder" :size="17" />
          </button>
        </div>

        <div class="quick-meta">
          <span class="pill">
            <Icon name="gamepad" :size="12" />
            {{ platformLabel }}
          </span>
          <span class="pill">
            <Icon name="folder" :size="12" />
            {{ installed ? 'Files ready' : 'Creates on launch' }}
          </span>
          <span class="pill" :class="{ green: state.discordOnline }">
            <span :class="classNames('status-dot', state.discordOnline ? 'online' : 'offline')"></span>
            {{ state.discordOnline ? 'Discord detected' : 'Discord closed' }}
          </span>
        </div>

        <div class="section-head">
          <span>Launch target</span>
          <span class="section-note">{{ executableRows.length }} available</span>
        </div>

        <div class="executable-list scroll-area">
          <div
            v-for="row in executableRows"
            :key="row.executable.name"
            class="executable-row"
            :class="{ 'is-running': row.running }"
          >
            <span :class="classNames('os-badge', row.executable.os)">{{ row.osBadge }}</span>
            <div class="exe-copy">
              <div class="exe-path" :title="row.executable.name">
                <template v-for="(folder, index) in row.folders" :key="`${folder}-${index}`">
                  <span class="path-folder">{{ folder }}</span>
                  <span class="path-sep">›</span>
                </template>
                <span class="path-file">{{ row.filename }}</span>
              </div>
              <div class="exe-meta">
                <span :class="classNames('exe-state', row.stateClass)">
                  <span class="status-dot"></span>
                  {{ row.stateLabel }}
                </span>
                <span v-if="row.isLauncher" class="exe-tag">launcher</span>
              </div>
            </div>
            <button
              :class="classNames('exe-action', row.actionClass)"
              type="button"
              :disabled="row.busy"
              @click="toggleExecutable(row.executable)"
            >
              <Icon :name="row.actionIcon" :size="12" :class="{ spin: row.busy }" />
              {{ row.actionLabel }}
            </button>
          </div>

          <div v-if="!executableRows.length" class="no-executables">
            <Icon name="alert" :size="16" />
            Discord has not registered a launchable executable for this game on {{ platformName }}.
          </div>
        </div>

        <div class="section-head rpc-head">
          <span>Rich Presence</span>
          <span class="experimental-tag">Experimental</span>
        </div>

        <div v-if="wantsRpc" class="rpc-warning">
          <Icon name="alert" :size="17" />
          <div>
            <strong>Use at your own risk</strong>
            <p>
              Rich Presence uses Discord's local RPC socket and a public app ID. It does not count
              toward quests, and it may look suspicious. Questline recommends the normal runner
              flow above.
            </p>
            <div class="rpc-warning-actions">
              <button class="btn btn-sm btn-secondary" type="button" @click="wantsRpc = false">Cancel</button>
              <button class="btn btn-sm btn-danger" type="button" :disabled="state.rpcBusy" @click="confirmRpc">
                {{ state.rpcBusy ? 'Connecting...' : 'Connect anyway' }}
              </button>
            </div>
          </div>
        </div>

        <div v-else class="rpc-row">
          <span class="rpc-icon" :class="{ connected: rpcForThisGame }">
            <Icon name="discord" :size="17" />
          </span>
          <div class="rpc-copy">
            <strong>
              {{ rpcForThisGame ? 'Connected to Discord' : rpcElsewhere ? 'Connected to another game' : 'Test Rich Presence' }}
            </strong>
            <span>
              {{ rpcForThisGame ? 'Discord is showing this game activity.' : 'Optional. Does not count toward quest progress.' }}
            </span>
          </div>
          <button
            class="btn btn-sm"
            :class="rpcForThisGame ? 'btn-success' : 'btn-secondary'"
            type="button"
            :disabled="state.rpcBusy || rpcElsewhere"
            @click="toggleRpc"
          >
            {{ state.rpcBusy ? 'Working...' : rpcForThisGame ? 'Disconnect' : 'Test' }}
          </button>
        </div>

        <div class="detail-foot">
          <Icon name="folder" :size="12" />
          <span class="truncate mono">{{ pathLabel }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  min-height: 540px;
}

.detail-scroll {
  max-height: calc(100vh - 198px);
  padding: 22px;
}

.detail-empty {
  display: flex;
  min-height: 540px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 42px 32px;
  text-align: center;
}

.detail-orbit {
  position: relative;
  display: grid;
  width: 118px;
  height: 118px;
  margin-bottom: 24px;
  place-items: center;
}

.orbit-ring {
  position: absolute;
  border: 1px dashed var(--line-strong);
  border-radius: 99px;
}

.ring-one {
  inset: 0;
  animation: orbit-spin 26s linear infinite;
}

.ring-two {
  inset: 17px;
  border-style: solid;
  opacity: 0.7;
}

.orbit-core {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border: 1px solid rgba(124, 108, 255, 0.26);
  border-radius: 18px;
  color: var(--accent-strong);
  background:
    radial-gradient(circle at 30% 20%, rgba(124, 108, 255, 0.35), transparent 70%),
    var(--panel-raised);
  box-shadow: 0 0 38px rgba(124, 108, 255, 0.18);
}

.orbit-dot {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent);
}

.dot-one {
  top: 8px;
  right: 25px;
}

.dot-two {
  bottom: 16px;
  left: 14px;
  width: 4px;
  height: 4px;
  background: var(--accent-blue);
}

@keyframes orbit-spin {
  to {
    transform: rotate(360deg);
  }
}

.detail-empty h3 {
  margin-bottom: 7px;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.detail-empty p {
  max-width: 290px;
  color: var(--text-muted);
  font-size: 13.5px;
  line-height: 1.6;
}

.detail-mini-stats {
  display: flex;
  gap: 26px;
  padding-top: 22px;
  margin-top: 26px;
  border-top: 1px solid var(--line);
}

.detail-mini-stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-mini-stats strong {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.detail-mini-stats span {
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.game-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.game-head-copy {
  min-width: 0;
  flex: 1;
  padding-top: 2px;
}

.game-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.game-title-row h2 {
  overflow: hidden;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.035em;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.verified-badge {
  display: inline-flex;
  flex: none;
  color: var(--accent-blue);
}

.game-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 8px;
  margin-top: 5px;
  color: var(--text-faint);
  font-size: 12px;
}

.meta-exe {
  white-space: nowrap;
}

.id-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 12px;
}

.id-button:hover {
  color: var(--text);
}

.state-pill {
  display: inline-flex;
  height: 26px;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  margin-top: 3px;
  border: 1px solid var(--line);
  border-radius: 99px;
  color: var(--text-muted);
  background: var(--panel-raised);
  font-size: 11.5px;
  font-weight: 650;
}

.state-pill.live {
  color: var(--green);
  border-color: rgba(61, 220, 151, 0.2);
  background: var(--green-soft);
}

.state-pill.ready {
  color: var(--accent-strong);
  border-color: rgba(124, 108, 255, 0.2);
  background: var(--accent-soft);
}

.quest-state {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  margin-top: 18px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--panel-raised);
}

.quest-state.live {
  border-color: rgba(61, 220, 151, 0.15);
  background:
    linear-gradient(90deg, rgba(61, 220, 151, 0.08), transparent 70%),
    var(--panel-raised);
}

.quest-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.quest-state.live .quest-icon {
  color: var(--green);
  background: var(--green-soft);
}

.quest-state strong {
  display: block;
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 650;
}

.quest-state p {
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.5;
}

.session-clock {
  margin-left: auto;
  color: var(--green);
  font-size: 12.5px;
  font-weight: 600;
}

.primary-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.flex-1 {
  flex: 1;
}

.quick-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  margin-top: 22px;
  border-bottom: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.section-note {
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: none;
}

.executable-list {
  max-height: 228px;
  padding-top: 5px;
}

.executable-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 7px;
  border-bottom: 1px solid var(--line);
}

.executable-row:last-child {
  border-bottom: 0;
}

.executable-row.is-running {
  background: linear-gradient(90deg, rgba(61, 220, 151, 0.045), transparent);
}

.os-badge {
  display: grid;
  width: 36px;
  height: 23px;
  flex: none;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text-faint);
  background: var(--bg-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.os-badge.win32 {
  color: #8bb8ff;
  border-color: rgba(79, 140, 255, 0.18);
  background: var(--blue-soft);
}

.os-badge.darwin {
  color: #d3d6df;
}

.os-badge.linux {
  color: #f5c46a;
  border-color: rgba(245, 184, 95, 0.16);
  background: var(--amber-soft);
}

.exe-copy {
  min-width: 0;
  flex: 1;
}

.exe-path {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
}

.path-folder {
  overflow: hidden;
  max-width: 96px;
  color: var(--text-faint);
  text-overflow: ellipsis;
}

.path-sep {
  color: var(--text-faint);
  opacity: 0.6;
}

.path-file {
  overflow: hidden;
  color: var(--text-soft);
  text-overflow: ellipsis;
}

.exe-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 3px;
}

.exe-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-faint);
  font-size: 11px;
}

.exe-state .status-dot {
  width: 4px;
  height: 4px;
}

.exe-state.running {
  color: var(--green);
}

.exe-state.running .status-dot {
  background: var(--green);
}

.exe-state.installed {
  color: var(--accent-strong);
}

.exe-state.installed .status-dot {
  background: var(--accent);
}

.exe-tag {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.exe-action {
  display: inline-flex;
  height: 29px;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--panel-raised);
  font-size: 11px;
  font-weight: 650;
  transition: 0.15s ease;
}

.exe-action:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
}

.exe-action.play:hover:not(:disabled) {
  color: var(--accent-strong);
  border-color: rgba(124, 108, 255, 0.3);
  background: var(--accent-soft);
}

.exe-action.stop {
  color: var(--red);
  border-color: rgba(255, 99, 116, 0.18);
  background: var(--red-soft);
}

.exe-action:disabled {
  opacity: 0.5;
  cursor: wait;
}

.no-executables {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 13px 7px;
  color: var(--amber);
  font-size: 12px;
  line-height: 1.5;
}

.rpc-head {
  margin-top: 18px;
}

.experimental-tag {
  padding: 3px 7px;
  border: 1px solid rgba(245, 184, 95, 0.18);
  border-radius: 5px;
  color: var(--amber);
  background: var(--amber-soft);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.rpc-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 7px;
}

.rpc-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  color: var(--text-faint);
  background: var(--panel-raised);
}

.rpc-icon.connected {
  color: #8f83ff;
  background: var(--accent-soft);
}

.rpc-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.rpc-copy strong {
  color: var(--text-soft);
  font-size: 12px;
  font-weight: 650;
}

.rpc-copy span {
  color: var(--text-faint);
  font-size: 11.5px;
}

.rpc-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  margin-top: 6px;
  border: 1px solid rgba(245, 184, 95, 0.18);
  border-radius: 12px;
  color: var(--amber);
  background: var(--amber-soft);
}

.rpc-warning strong {
  display: block;
  margin-bottom: 3px;
  font-size: 12px;
  font-weight: 700;
}

.rpc-warning p {
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.55;
}

.rpc-warning-actions {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}

.detail-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 14px;
  margin-top: 14px;
  border-top: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 11px;
}

.detail-foot .mono {
  font-size: 11px;
}
</style>
