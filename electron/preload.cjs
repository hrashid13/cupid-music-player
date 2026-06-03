const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cupid', {
  version: process.versions.electron,
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  resize: (data) => ipcRenderer.send('window-resize', data),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  getStreamUrl: (title, artist) => ipcRenderer.invoke('get-stream-url', title, artist),
  getAppleMusicToken: () => ipcRenderer.invoke('get-apple-music-token'),
  getLocalTracks: () => ipcRenderer.invoke('get-local-tracks'),
  getAudioPath: (file) => ipcRenderer.invoke('get-audio-path', file),
  savePlaylistOrder: (fileOrder) => ipcRenderer.invoke('save-playlist-order', fileOrder),
});
