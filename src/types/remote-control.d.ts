export interface RemoteControlAck {
  error?: string;
  id: string;
  seq: number;
  success: boolean;
  type: 'ack';
}

export type RemoteControlAction =
  | { play?: boolean; type: 'select_item'; uniqueId: string }
  | { position: number; type: 'seek' }
  | { type: 'next' }
  | { type: 'pause' }
  | { type: 'play' }
  | { type: 'previous' }
  | { type: 'refresh_playlist' }
  | { type: 'relinquish_control' }
  | { type: 'stop' }
  | { type: 'stop_zoom_share' }
  | { type: 'take_control' }
  | { type: 'toggle_blackout' };

export type RemoteControlScope = 'full' | 'partial';

export interface RemoteControlSession {
  createdAt: number;
  deviceId: string;
  deviceName: string;
  ip: string;
  lastActive: number;
  token: string;
}

export interface RemoteControlStartOptions {
  pairingCode?: string;
  pin?: string;
  port?: number;
  requirePin?: boolean;
  scope?: RemoteControlScope;
}

export interface RemoteControlState {
  activeControllerDeviceId?: string;
  activeControllerName?: string;
  currentPosition: number;
  duration: number;
  isPaused: boolean;
  isPlaying: boolean;
  isStopped: boolean;
  mediaType: RemoteMediaType;
  mediaWindowVisible: boolean;
  playlist: RemotePlaylistItem[];
  scope: RemoteControlScope;
  thumbnailPath?: string;
  thumbnailStreamUrl?: string;
  thumbnailUrl?: string;
  title: string;
  uniqueId?: string;
  zoomConnected?: boolean;
  zoomSharing?: boolean;
}

export interface RemoteControlStatus {
  activeControllerDeviceId?: string;
  activeControllerName?: string;
  clientCount?: number;
  error?: string;
  pairedSessions: Omit<RemoteControlSession, 'token'>[];
  pairingCode: string;
  port: number;
  running: boolean;
  scope: RemoteControlScope;
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
  thumbnailStreamUrl?: string;
  thumbnailUrl?: string;
  title: string;
  uniqueId: string;
}
