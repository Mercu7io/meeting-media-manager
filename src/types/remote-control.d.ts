export type RemoteControlAction =
  | { play?: boolean; type: 'select_item'; uniqueId: string }
  | { position: number; type: 'seek' }
  | { type: 'next' }
  | { type: 'pause' }
  | { type: 'play' }
  | { type: 'previous' }
  | { type: 'refresh_playlist' }
  | { type: 'stop' }
  | { type: 'stop_zoom_share' }
  | { type: 'toggle_blackout' };

export interface RemoteControlStartOptions {
  pin?: string;
  port?: number;
  requirePin?: boolean;
}

export interface RemoteControlState {
  currentPosition: number;
  duration: number;
  isPaused: boolean;
  isPlaying: boolean;
  isStopped: boolean;
  mediaType: RemoteMediaType;
  mediaWindowVisible: boolean;
  playlist: RemotePlaylistItem[];
  thumbnailPath?: string;
  thumbnailUrl?: string;
  title: string;
  uniqueId?: string;
  zoomConnected?: boolean;
  zoomSharing?: boolean;
}

export interface RemoteControlStatus {
  clientCount?: number;
  error?: string;
  pin: string;
  port: number;
  requirePin: boolean;
  running: boolean;
  urls: string[];
}

export type RemoteMediaType = 'audio' | 'image' | 'none' | 'video' | 'website';

export interface RemotePlaylistItem {
  duration?: number;
  groupId?: string;
  groupTitle?: string;
  isAudio?: boolean;
  isDivider?: boolean;
  isImage?: boolean;
  isVideo?: boolean;
  section?: string;
  sectionId?: string;
  songNumber?: number | string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  title: string;
  uniqueId: string;
}
