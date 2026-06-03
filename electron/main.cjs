require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, shell, protocol, net } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const execFileAsync = promisify(execFile);

// Custom protocol used by the renderer's <audio> — main fetches the actual
// stream so we can attach headers and forward Range requests for seeking.
// Must be registered as privileged before app.whenReady fires.
protocol.registerSchemesAsPrivileged([{
  scheme: 'cupid-audio',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

// ── Apple Music developer token ──────────────────────────
let appleMusicToken = null;
let appleMusicTokenExpiry = 0;

function generateAppleMusicToken() {
  if (appleMusicToken && Date.now() < appleMusicTokenExpiry) {
    return appleMusicToken;
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;

  if (!teamId || !keyId) return null;

  // Find the .p8 key file in project root
  const projectRoot = path.join(__dirname, '..');
  const keyFiles = fs.readdirSync(projectRoot).filter((f) => f.endsWith('.p8'));
  if (keyFiles.length === 0) return null;

  const privateKey = fs.readFileSync(path.join(projectRoot, keyFiles[0]), 'utf8');

  appleMusicToken = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '180d',
    issuer: teamId,
    header: {
      alg: 'ES256',
      kid: keyId,
    },
  });

  // Cache for 179 days
  appleMusicTokenExpiry = Date.now() + 179 * 24 * 60 * 60 * 1000;
  return appleMusicToken;
}

// ── yt-dlp stream URL fetcher ────────────────────────────
const streamCache = new Map();
const pendingRequests = new Map();
const videoIdCache = new Map();
const CACHE_TTL = 25 * 60 * 1000;

let videoIdCacheLoaded = false;
let videoIdCacheFile = null;
let videoIdSaveTimer = null;

function loadVideoIdCache() {
  if (videoIdCacheLoaded) return;
  videoIdCacheLoaded = true;
  try {
    videoIdCacheFile = path.join(app.getPath('userData'), 'video-id-cache.json');
    const raw = fs.readFileSync(videoIdCacheFile, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) videoIdCache.set(k, v);
  } catch {
    // no cache file yet
  }
}

function persistVideoIdCache() {
  if (!videoIdCacheFile) return;
  clearTimeout(videoIdSaveTimer);
  videoIdSaveTimer = setTimeout(() => {
    const obj = Object.fromEntries(videoIdCache);
    fs.promises.writeFile(videoIdCacheFile, JSON.stringify(obj)).catch(() => {});
  }, 500);
}

function getYtDlpPath() {
  try {
    return require('yt-dlp-exec/src/constants').YOUTUBE_DL_PATH || 'yt-dlp';
  } catch {
    return 'yt-dlp';
  }
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

let innertubePromise = null;
function getInnertube() {
  if (innertubePromise) return innertubePromise;
  innertubePromise = (async () => {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    return Innertube.create({
      cache: new UniversalCache(true, path.join(app.getPath('userData'), 'innertube-cache')),
      generate_session_locally: true,
    });
  })().catch((err) => {
    innertubePromise = null;
    throw err;
  });
  return innertubePromise;
}

async function searchYouTubeMusic(title, artist) {
  const yt = await getInnertube();
  const search = await yt.music.search(`${title} ${artist}`, { type: 'song' });

  let top = search.songs?.contents?.find((c) => c?.id);
  if (!top) {
    for (const shelf of search.contents || []) {
      const item = shelf?.contents?.find?.((c) => c?.id);
      if (item) { top = item; break; }
    }
  }
  if (!top?.id) throw new Error('No song result');
  return top.id;
}

async function ytDlpExtract(target) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    target,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '-g',
  ], { timeout: 15000 });
  return stdout.trim();
}

async function ytDlpSearch(title, artist) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    `ytsearch1:"${title}" ${artist}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--print', '%(id)s',
    '-g',
  ], { timeout: 15000 });
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const id = lines.find((l) => YT_ID_RE.test(l));
  const url = lines.find((l) => l.startsWith('http'));
  if (!id || !url) throw new Error('yt-dlp search returned no usable result');
  return { id, url };
}

const decipheredCache = new Map();
const pendingDecipher = new Map();

async function resolveStreamUrl(videoId) {
  const cached = decipheredCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingDecipher.get(videoId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = await ytDlpExtract(`https://www.youtube.com/watch?v=${videoId}`);
      decipheredCache.set(videoId, { url, time: Date.now() });
      return url;
    } finally {
      pendingDecipher.delete(videoId);
    }
  })();

  pendingDecipher.set(videoId, promise);
  return promise;
}

async function getStreamUrl(title, artist) {
  const cacheKey = `${title}::${artist}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingRequests.get(cacheKey);
  if (inflight) return inflight;

  loadVideoIdCache();
  let videoId = videoIdCache.get(cacheKey);

  const promise = (async () => {
    try {
      if (!videoId) {
        try {
          videoId = await searchYouTubeMusic(title, artist);
        } catch (err) {
          console.warn('[youtubei search] fallback to yt-dlp:', err.message);
          const result = await ytDlpSearch(title, artist);
          videoId = result.id;
          decipheredCache.set(videoId, { url: result.url, time: Date.now() });
        }
        videoIdCache.set(cacheKey, videoId);
        persistVideoIdCache();
      }

      resolveStreamUrl(videoId).catch(() => {});

      const url = `cupid-audio://stream?id=${encodeURIComponent(videoId)}`;
      streamCache.set(cacheKey, { url, time: Date.now() });
      return url;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}

const isDev = process.env.NODE_ENV === 'development';

const WIDTH = 415;
const HEIGHT = Math.round(415 * (497 / 306));

function getAudioDir() {
  return isDev
    ? path.join(__dirname, '..', 'audio')
    : path.join(process.resourcesPath, 'audio');
}

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  const ASPECT = WIDTH / HEIGHT;
  win.setAspectRatio(ASPECT);

  let preMaxBounds = null;

  const onMinimize = () => win.minimize();
  const onMaximize = () => {
    if (preMaxBounds) {
      win.setBounds(preMaxBounds);
      preMaxBounds = null;
    } else {
      preMaxBounds = win.getBounds();
      const { workArea } = screen.getPrimaryDisplay();
      let newWidth = workArea.width;
      let newHeight = Math.round(newWidth / ASPECT);
      if (newHeight > workArea.height) {
        newHeight = workArea.height;
        newWidth = Math.round(newHeight * ASPECT);
      }
      const x = workArea.x + Math.round((workArea.width - newWidth) / 2);
      const y = workArea.y + Math.round((workArea.height - newHeight) / 2);
      win.setBounds({ x, y, width: newWidth, height: newHeight });
    }
  };
  const onClose = () => win.close();

  const onResize = (_e, { dx, dy, corner }) => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();

    const isRight = corner.includes('right');
    const isBottom = corner.includes('bottom');

    const effectiveDx = isRight ? dx : -dx;
    const effectiveDy = isBottom ? dy : -dy;

    let delta;
    if (Math.abs(effectiveDx) > Math.abs(effectiveDy)) {
      delta = effectiveDx;
    } else {
      delta = effectiveDy;
    }

    const dw = Math.round(delta);
    const newWidth = bounds.width + dw;
    const newHeight = Math.round(newWidth / ASPECT);
    const dh = newHeight - bounds.height;

    const newBounds = {
      x: isRight ? bounds.x : bounds.x - dw,
      y: isBottom ? bounds.y : bounds.y - dh,
      width: newWidth,
      height: newHeight,
    };

    if (newBounds.width >= 200 && newBounds.height >= 200) {
      win.setBounds(newBounds);
    }
  };

  const onOpenExternal = (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      if (url.includes('accounts.spotify.com/authorize')) {
        const authWin = new BrowserWindow({
          width: 500,
          height: 700,
          parent: win,
          modal: true,
          show: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        authWin.loadURL(url);
        const handleAuthRedirect = (event, callbackUrl) => {
          if (callbackUrl.startsWith('http://127.0.0.1:5173/callback')) {
            event.preventDefault();
            const url = new URL(callbackUrl);
            let target;
            if (isDev) {
              target = `http://127.0.0.1:5173/${url.search}`;
            } else {
              const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
              fileUrl.search = url.search;
              target = fileUrl.href;
            }
            win.loadURL(target);
            authWin.close();
          }
        };
        authWin.webContents.on('will-redirect', handleAuthRedirect);
        authWin.webContents.on('will-navigate', handleAuthRedirect);
        return;
      }
      shell.openExternal(url);
    }
  };

  const onSetTheme = (_e, theme) => {
    const iconPath = path.join(__dirname, '..', 'assets', theme, 'favicon.png');
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(iconPath);
    }
    win.setIcon(iconPath);
  };

  ipcMain.on('window-minimize', onMinimize);
  ipcMain.on('window-maximize', onMaximize);
  ipcMain.on('window-close', onClose);
  ipcMain.on('window-resize', onResize);
  ipcMain.on('open-external', onOpenExternal);
  ipcMain.on('set-theme', onSetTheme);

  win.on('closed', () => {
    ipcMain.removeListener('window-minimize', onMinimize);
    ipcMain.removeListener('window-maximize', onMaximize);
    ipcMain.removeListener('window-close', onClose);
    ipcMain.removeListener('window-resize', onResize);
    ipcMain.removeListener('open-external', onOpenExternal);
    ipcMain.removeListener('set-theme', onSetTheme);
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'accounts.spotify.com') {
        event.preventDefault();
        shell.openExternal(url);
        return;
      }
      if (parsed.pathname === '/callback' && parsed.searchParams.has('code')) {
        if (!isDev) {
          event.preventDefault();
          const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
          fileUrl.search = parsed.search;
          win.loadURL(fileUrl.href);
        }
      }
    } catch {
      // ignore invalid URLs
    }
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isDevToolsShortcut = input.key.toLowerCase() === 'i' && input.shift && (input.meta || input.control);
    if (isDevToolsShortcut || input.key === 'F12') {
      win.webContents.toggleDevTools({ mode: 'detach' });
    }
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ── Global IPC handlers ──────────────────────────────────
ipcMain.handle('get-apple-music-token', () => {
  return generateAppleMusicToken();
});

ipcMain.handle('get-stream-url', async (_e, title, artist) => {
  try {
    return await getStreamUrl(title, artist);
  } catch (err) {
    throw new Error(`Failed to get stream: ${err.message}`);
  }
});

ipcMain.handle('get-local-tracks', async () => {
  try {
    const files = fs.readdirSync(getAudioDir()).filter(f => f.endsWith('.mp3'));
    const tracks = files.map(file => ({
      file,
      title: file.replace(/^\d+ - /, '').replace(/\.mp3$/, ''),
      artist: '',
      album: '',
      art: '',
    }));

    try {
      const orderFile = path.join(app.getPath('userData'), 'playlist-order.json');
      const savedOrder = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
      const trackMap = new Map(tracks.map(t => [t.file, t]));
      const ordered = savedOrder.filter(f => trackMap.has(f)).map(f => trackMap.get(f));
      // append any new files not yet in the saved order
      const inOrder = new Set(savedOrder);
      for (const t of tracks) {
        if (!inOrder.has(t.file)) ordered.push(t);
      }
      return ordered;
    } catch {
      return tracks;
    }
  } catch {
    return [];
  }
});

ipcMain.handle('save-playlist-order', async (_e, fileOrder) => {
  try {
    const orderFile = path.join(app.getPath('userData'), 'playlist-order.json');
    await fs.promises.writeFile(orderFile, JSON.stringify(fileOrder));
  } catch (err) {
    console.error('Failed to save playlist order:', err);
  }
});

ipcMain.handle('get-audio-path', (_e, file) => {
  return pathToFileURL(path.join(getAudioDir(), file)).href;
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'));
  }

  protocol.handle('cupid-audio', async (request) => {
    try {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response('missing id', { status: 400 });

      const streamUrl = await resolveStreamUrl(id);

      const headers = {
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        'User-Agent': 'Mozilla/5.0',
      };
      const range = request.headers.get('Range');
      if (range) headers.Range = range;

      const upstream = await net.fetch(streamUrl, { headers });
      const respHeaders = new Headers(upstream.headers);
      respHeaders.set('Content-Type', 'audio/mp4');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error('[cupid-audio]', err.message);
      return new Response('failed', { status: 502 });
    }
  });

  createWindow();

  getInnertube().catch(() => {});
  execFile(getYtDlpPath(), ['--version'], () => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
