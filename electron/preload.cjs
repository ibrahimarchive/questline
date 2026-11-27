const { contextBridge, ipcRenderer } = require('electron')

async function invoke(channel, payload) {
  const response = await ipcRenderer.invoke(channel, payload)
  if (response && typeof response === 'object' && 'error' in response) {
    throw new Error(response.error)
  }
  return response?.data
}

contextBridge.exposeInMainWorld('questline', {
  getState: () => invoke('state:get'),
  saveState: (state) => invoke('state:save', state),
  getAppInfo: () => invoke('app:info'),
  loadGames: () => invoke('games:load'),
  refreshGames: () => invoke('games:refresh'),
  inspectGames: (payload) => invoke('runner:inspect-many', payload),
  installGame: (payload) => invoke('runner:install', payload),
  launchGame: (payload) => invoke('runner:launch', payload),
  stopGame: (payload) => invoke('runner:stop', payload),
  stopAll: () => invoke('runner:stop-all'),
  listRunning: () => invoke('runner:list'),
  openPath: (target) => invoke('shell:open-path', target),
  revealPath: (target) => invoke('shell:reveal-path', target),
  pickFolder: () => invoke('shell:pick-folder'),
  getDiscordStatus: () => invoke('discord:status'),
  rpcConnect: (payload) => invoke('rpc:connect', payload),
  rpcDisconnect: () => invoke('rpc:disconnect'),
  onRunnerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('runner:event', listener)
    return () => ipcRenderer.removeListener('runner:event', listener)
  },
})
