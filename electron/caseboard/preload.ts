import { contextBridge, ipcRenderer } from 'electron'
import type { CaseboardBridge } from '../../src/caseboard/types'

const bridge: CaseboardBridge = {
  discover: () => ipcRenderer.invoke('caseboard:discover'),
  autoSetup: options => ipcRenderer.invoke('caseboard:auto-setup', options),
  chooseFolder: () => ipcRenderer.invoke('caseboard:choose-folder'),
  closeConnection: options => ipcRenderer.invoke('caseboard:close-connection', options),
  catalog: options => ipcRenderer.invoke('caseboard:catalog', options),
  load: options => ipcRenderer.invoke('caseboard:load', options),
  cancelLoad: () => ipcRenderer.invoke('caseboard:cancel-load'),
  media: options => ipcRenderer.invoke('caseboard:media', options),
  summarize: options => ipcRenderer.invoke('caseboard:summarize', options),
  cancelSummary: () => ipcRenderer.invoke('caseboard:cancel-summary'),
  onSummaryProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<Parameters<CaseboardBridge['onSummaryProgress']>[0]>[0]) => callback(progress)
    ipcRenderer.on('caseboard:summary-progress', listener)
    return () => ipcRenderer.removeListener('caseboard:summary-progress', listener)
  },
  onProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<Parameters<CaseboardBridge['onProgress']>[0]>[0]) => callback(progress)
    ipcRenderer.on('caseboard:progress', listener)
    return () => ipcRenderer.removeListener('caseboard:progress', listener)
  },
  saveFile: options => ipcRenderer.invoke('caseboard:save-file', options),
}

contextBridge.exposeInMainWorld('caseboard', Object.freeze(bridge))
