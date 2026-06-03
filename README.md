# cupid music player

A pixel-art desktop music player built with Electron, Vite, and React.

*NOTE*

I added some personal enhancements to this for my specific usecase of a youtube playlist. All credit to the original creator who made the rest of this repo: https://github.com/cupidbity/cupid-music-player 

Link to my YouTube playlist is here: https://www.youtube.com/playlist?list=PLvT8KF5bMAFquyRMBXoQwf9fq2B959dW_ 

Was able to download MP3 files using:

```bash
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Credits to them can be found here:

yt-dlp: https://github.com/yt-dlp/yt-dlp
ffmpeg: https://ffmpeg.org/download.html 

## Features

- Pixel-art UI with animated record player, spinning vinyl, and needle
- Record swap animation on song change (pink/blue vinyl alternation)
- Interactive progress bar with draggable star indicator
- Marquee scrolling for long track titles
- Pink and blue theme switching with persistent preference
- Spotify integration — browse your playlists and play tracks via yt-dlp
- Apple Music integration — browse your library playlists via MusicKit JS
- Local MP3 playback
- Custom frameless window with drag and resize
- Dynamic dock/taskbar icon that matches the active theme

## Getting Started

```bash
npm install
npm run dev
```

## Adding Local Audio Files

1. Create an `audio/` folder in the project root (if it doesn't exist)
2. Drop your `.mp3` files into the `audio/` folder
3. Make sure your MP3 files have embedded metadata (title, artist, album art) — the player reads these automatically
4. Restart the app

The player uses the [music-metadata](https://github.com/borewit/music-metadata) library to extract track info and album art from your MP3 files. Files without metadata will still play but may show as "Unknown".

### Supported formats

- `.mp3` — recommended, widely supported with ID3 tags

### Adding metadata to your MP3s

If your files are missing metadata, you can add it with tools like:
- [MP3Tag](https://www.mp3tag.de/en/) (Windows)
- [Kid3](https://kid3.kde.org/) (Mac/Linux/Windows)
- iTunes/Music.app — right-click a song > Get Info

## Spotify Setup

Stream any track from your Spotify playlists. Audio is fetched from YouTube via yt-dlp, so **Spotify Premium is not required**.

1. Create a Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add `http://127.0.0.1:5173/callback` as a redirect URI
3. Copy `.env.example` to `.env` and add your Client ID
4. Add yourself under Settings > User Management
5. Click the settings icon in the player > log in

See [SPOTIFY_SETUP.md](SPOTIFY_SETUP.md) for detailed instructions and troubleshooting.

## Apple Music Setup

Browse your Apple Music library playlists. Requires an Apple Developer account. **Apple Music subscription is not required for playback.**

1. Create a MusicKit key at [developer.apple.com/account/resources/authkeys](https://developer.apple.com/account/resources/authkeys/list)
2. Download the `.p8` key file and place it in the project root
3. Add `APPLE_TEAM_ID` and `APPLE_KEY_ID` to your `.env`
4. Click the settings icon > switch to apple > log in

See [APPLE_MUSIC_SETUP.md](APPLE_MUSIC_SETUP.md) for detailed instructions and troubleshooting.

## Build

```bash
npm run package
```

### Install as Desktop App

**macOS:**
```bash
cp -r "out/mac-arm64/Cupid Player.app" /Applications/
```

**Windows:** Run the installer from `out/Cupid Player Setup.exe`. If `npm run package` fails at the NSIS step with "Cannot create symbolic link," enable **Developer Mode** in Settings → System → For developers, then re-run. The unpacked app at `out/win-unpacked/Cupid Player.exe` is fully runnable in the meantime — no installer required.

**Linux:** Run the AppImage from `out/`.

> Note: The macOS build is unsigned. On first launch you may need to right-click > Open, or go to System Settings > Privacy & Security to allow it.

## Tech Stack

- **Electron** — desktop app shell (frameless window, IPC, system tray)
- **Vite** — build tool and dev server
- **React** — UI framework
- **HTML5 Audio** — local MP3 playback
- **yt-dlp** — YouTube audio streaming for Spotify/Apple Music tracks
- **Spotify Web API** — playlist and metadata fetching (OAuth PKCE)
- **Apple MusicKit JS** — library playlist access (JWT auth)
- **CSS** — custom properties for theming, calc-based responsive scaling
- **Node.js** — main process (JWT generation, yt-dlp execution)
- **jsonwebtoken** — Apple Music developer token generation
- **music-metadata** — MP3 ID3 tag extraction (title, artist, album art)
