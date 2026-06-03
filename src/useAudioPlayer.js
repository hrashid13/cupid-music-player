import { useState, useRef, useEffect, useCallback } from 'react';

export default function useAudioPlayer(playMode = 'normal') {
  const audioRef = useRef(new Audio());
  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  const [playlist, setPlaylist] = useState([]);
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolumeState] = useState(() => {
    const saved = localStorage.getItem('cupid-volume');
    return saved !== null ? parseFloat(saved) : 1;
  });
  const [muted, setMuted] = useState(false);

  const audio = audioRef.current;
  audio.volume = muted ? 0 : volume;

  // Load tracks from the audio folder on mount
  useEffect(() => {
    window.cupid.getLocalTracks().then(tracks => setPlaylist(tracks));
  }, []);

  const track = playlist[trackIndex] ?? { file: '', title: 'Loading...', artist: '', art: '' };

  // Load track when index or file changes
  useEffect(() => {
    if (!track.file) return;
    window.cupid.getAudioPath(track.file).then((url) => {
      audio.src = url;
      audio.load();
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      if (isPlayingRef.current) audio.play().catch(() => {});
    });
  }, [trackIndex, track.file]);

  // Audio event listeners
  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => {
      if (playModeRef.current === 'repeat') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      setTrackIndex((prev) => {
        if (playModeRef.current === 'shuffle') {
          let next;
          do { next = Math.floor(Math.random() * playlist.length); } while (next === prev && playlist.length > 1);
          return next;
        }
        return (prev + 1) % playlist.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [playlist.length]);

  const play = useCallback(() => {
    audio.play().catch(() => {});
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    audio.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (playModeRef.current === 'shuffle' && playlist.length > 1) {
        let n;
        do { n = Math.floor(Math.random() * playlist.length); } while (n === prev);
        return n;
      }
      return (prev + 1) % playlist.length;
    });
  }, [playlist.length]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      setTrackIndex((prev) => (prev - 1 + playlist.length) % playlist.length);
    }
  }, [playlist.length]);

  const seek = useCallback((fraction) => {
    if (audio.duration) audio.currentTime = Math.min(fraction, 1) * audio.duration;
  }, []);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    audio.volume = clamped;
    localStorage.setItem('cupid-volume', clamped);
    if (clamped > 0) setMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audio.volume = m ? volume : 0;
      return !m;
    });
  }, [volume]);

  return {
    track,
    playlist,
    setPlaylist,
    trackIndex,
    setTrackIndex,
    isPlaying,
    progress,
    duration,
    currentTime,
    togglePlay,
    play,
    next,
    prev,
    seek,
    volume,
    setVolume,
    muted,
    toggleMute,
  };
}
