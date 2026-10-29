import type {
  RemoteControlAction,
  RemoteControlState,
  RemoteMediaType,
  RemotePlaylistItem,
} from 'src/types';

import { useBroadcastChannel } from '@vueuse/core';
import { i18n } from 'boot/i18n';
import { errorCatcher } from 'src/helpers/error-catcher';
import { toggleMediaWindowVisibility } from 'src/helpers/mediaPlayback';
import { triggerMediaWindowAutoHide } from 'src/helpers/mediaWindowAutoHide';
import { createTemporaryNotification } from 'src/helpers/notifications';
import {
  stopSharingMediaInZoom,
  stopZoomSharingAfterMedia,
} from 'src/helpers/zoom';
import { log } from 'src/shared/vanilla';
import { isAudio, isImage, isVideo } from 'src/utils/media';
import { useCurrentStateStore } from 'stores/current-state';
import { useZoomStateStore } from 'stores/zoom-state';

const t = (key: string) => (i18n.global.t as (key: string) => string)(key);

export const parseRemoteControlPort = (
  value: null | string | undefined,
): null | number => {
  const port = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return null;
  return port;
};

export const generateRandomPin = (): string =>
  String(Math.floor(1000 + Math.random() * 9000));

let runningPort: null | number = null;
let runningPin: null | string = null;
let runningRequirePin = true;
let syncInProgress: null | Promise<void> = null;
let removeActionListener: (() => void) | null = null;

const notifyStartFailed = (error: string | undefined) => {
  createTemporaryNotification({
    group: 'remote-control',
    icon: 'mmm-error',
    message: t(
      error === 'port-in-use'
        ? 'remote-control-port-in-use'
        : 'remote-control-start-failed',
    ),
    type: 'negative',
  });
};

const resolveItemTitle = (
  rawTitle?: string,
  extractCaption?: string,
  fileUrl?: string,
): string => {
  let t = rawTitle?.trim();
  if (!t && extractCaption) {
    t = extractCaption
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!t && fileUrl) {
    const clean = fileUrl.split('?')[0] || '';
    const fname = clean.split('/').pop()?.split('\\').pop() || '';
    t = decodeURIComponent(fname).replace(/\.[^.]+$/, '');
  }
  return t || 'Untitled';
};

const resolveThumbnail = (
  rawThumbUrl?: string,
  rawFileUrl?: string,
  isImg?: boolean,
  uniqueId?: string,
  rawThumbStreamUrl?: string,
): { thumbnailPath?: string; thumbnailUrl?: string } => {
  if (
    rawThumbUrl &&
    (/^https?:\/\//i.test(rawThumbUrl) || rawThumbUrl.startsWith('data:image/'))
  ) {
    return {
      thumbnailUrl: rawThumbUrl,
    };
  }

  if (rawThumbStreamUrl && /^https?:\/\//i.test(rawThumbStreamUrl)) {
    return {
      thumbnailUrl: rawThumbStreamUrl,
    };
  }

  const target = rawThumbUrl || rawFileUrl;
  if (!target) return {};

  const cleanTarget = target.split('?')[0] || '';
  if (!cleanTarget) return {};

  let localPath = cleanTarget;
  try {
    const fileUrlToPath = globalThis.electronApi?.fileUrlToPath;
    if (fileUrlToPath && cleanTarget.startsWith('file://')) {
      localPath = fileUrlToPath(cleanTarget);
    } else if (cleanTarget.startsWith('file://')) {
      localPath = decodeURIComponent(new URL(cleanTarget).pathname);
      if (/^\/[a-zA-Z]:/.test(localPath)) {
        localPath = localPath.slice(1);
      }
    }
  } catch {
    localPath = cleanTarget.replace(/^file:\/\/\/?/, '');
  }

  const endpointUrl = uniqueId
    ? `/api/thumbnail?id=${encodeURIComponent(uniqueId)}`
    : undefined;

  return {
    thumbnailPath: localPath || undefined,
    thumbnailUrl: endpointUrl,
  };
};

export const formatRemoteControlState = (): RemoteControlState => {
  const currentState = useCurrentStateStore();
  const mediaPlaying = currentState.mediaPlaying;
  const mediaWindowVisible = currentState.mediaWindowVisible;
  const zoomState = useZoomStateStore();
  const zoomSharing = !!zoomState.meeting?.sharing;
  const zoomConnected = !!zoomState.meeting?.found;

  // Build playlist items from currently selected date's media sections
  const playlist: RemotePlaylistItem[] = [];
  const sections = currentState.selectedDateObject?.mediaSections ?? [];

  for (const section of sections) {
    let sectionName = section.config?.label;
    if (!sectionName) {
      if (
        section.config?.uniqueId === 'imported-media' ||
        section.config?.uniqueId?.startsWith('custom-')
      ) {
        sectionName = i18n.global.t('imported-media');
      } else if (
        section.config?.uniqueId &&
        i18n.global.te(section.config.uniqueId)
      ) {
        sectionName = i18n.global.t(section.config.uniqueId);
      } else {
        sectionName =
          section.config?.documentTitle ||
          section.config?.uniqueId ||
          'General';
      }
    }
    const sectionId = section.config?.uniqueId || undefined;

    for (const item of section.items ?? []) {
      if (item.hidden) continue;

      if (item.type === 'divider') {
        playlist.push({
          isDivider: true,
          section: sectionName,
          sectionId,
          title: item.title || '',
          uniqueId:
            item.uniqueId ||
            `divider-${sectionId || 'sec'}-${item.title || 'div'}`,
        });
        continue;
      }

      // Skip invalid / ghost items that have no fileUrl, no children, and are not dividers
      if (!item.fileUrl && !item.children?.length) {
        continue;
      }

      if (item.children?.length) {
        const rawGroupTitle = item.extractCaption || item.title || '';
        const cleanGroupTitle =
          rawGroupTitle
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || undefined;
        const groupId =
          item.uniqueId ||
          `group-${sectionId || 'sec'}-${cleanGroupTitle || 'grp'}`;
        const groupSongNumber =
          item.tag?.type === 'song' ? item.tag.value : undefined;

        for (const child of item.children) {
          if (child.hidden) continue;
          if (!child.fileUrl && !child.children?.length) continue;
          const image = !!child.isImage || isImage(child.fileUrl);
          const video = !image && !!child.fileUrl && isVideo(child.fileUrl);
          const audio =
            !image && !video && !!child.fileUrl && isAudio(child.fileUrl);

          const childSongNumber =
            child.tag?.type === 'song' ? child.tag.value : groupSongNumber;
          const childUniqueId = child.uniqueId || child.fileUrl || '';
          const thumb = resolveThumbnail(
            child.thumbnailUrl,
            child.fileUrl,
            image,
            childUniqueId,
            child.thumbnailStreamUrl,
          );

          const childTitle = resolveItemTitle(
            child.title,
            child.extractCaption,
            child.fileUrl,
          );

          playlist.push({
            duration: child.duration || 0,
            groupId,
            groupTitle: cleanGroupTitle,
            isAudio: audio,
            isImage: image,
            isVideo: video,
            section: sectionName,
            sectionId,
            songNumber: childSongNumber,
            thumbnailPath: thumb.thumbnailPath,
            thumbnailUrl: thumb.thumbnailUrl,
            title: childTitle,
            uniqueId: childUniqueId,
          });
        }
      } else {
        const image = !!item.isImage || isImage(item.fileUrl);
        const video = !image && !!item.fileUrl && isVideo(item.fileUrl);
        const audio =
          !image && !video && !!item.fileUrl && isAudio(item.fileUrl);

        const songNumber =
          item.tag?.type === 'song' ? item.tag.value : undefined;
        const itemUniqueId = item.uniqueId || item.fileUrl || '';
        const thumb = resolveThumbnail(
          item.thumbnailUrl,
          item.fileUrl,
          image,
          itemUniqueId,
          item.thumbnailStreamUrl,
        );

        const itemTitle = resolveItemTitle(
          item.title,
          item.extractCaption,
          item.fileUrl,
        );

        playlist.push({
          duration: item.duration || 0,
          isAudio: audio,
          isImage: image,
          isVideo: video,
          section: sectionName,
          sectionId,
          songNumber,
          thumbnailPath: thumb.thumbnailPath,
          thumbnailUrl: thumb.thumbnailUrl,
          title: itemTitle,
          uniqueId: itemUniqueId,
        });
      }
    }
  }

  const hasMedia = !!mediaPlaying.url;
  const isPaused = hasMedia && mediaPlaying.action === 'pause';
  const isPlaying = (hasMedia && !isPaused) || mediaPlaying.action === 'play';
  const isStopped = !hasMedia && !isPlaying && !isPaused;

  let title = '';
  let mediaType: RemoteMediaType = 'none';
  let uniqueId = mediaPlaying.uniqueId || '';
  let thumbnailUrl: string | undefined;
  let thumbnailPath: string | undefined;

  const matched = playlist.find(
    (p) =>
      !p.isDivider &&
      (p.uniqueId === uniqueId ||
        (mediaPlaying.url && p.uniqueId === mediaPlaying.url)),
  );

  if (matched) {
    title = matched.title;
    if (matched.isImage) mediaType = 'image';
    else if (matched.isVideo) mediaType = 'video';
    else if (matched.isAudio) mediaType = 'audio';
    thumbnailUrl = matched.thumbnailUrl;
    thumbnailPath = matched.thumbnailPath;
    if (!uniqueId) uniqueId = matched.uniqueId;
  } else if (mediaPlaying.url) {
    title = mediaPlaying.url.split('/').pop() || '';
    const image = isImage(mediaPlaying.url);
    if (image) mediaType = 'image';
    else if (isVideo(mediaPlaying.url)) mediaType = 'video';
    else if (isAudio(mediaPlaying.url)) mediaType = 'audio';
    const thumb = resolveThumbnail(
      undefined,
      mediaPlaying.url,
      image,
      uniqueId || mediaPlaying.url,
    );
    thumbnailUrl = thumb.thumbnailUrl;
    thumbnailPath = thumb.thumbnailPath;
  }

  return {
    currentPosition: mediaPlaying.currentPosition || 0,
    duration: mediaPlaying.duration || (matched?.duration ?? 0),
    isPaused,
    isPlaying,
    isStopped,
    mediaType,
    mediaWindowVisible,
    playlist,
    thumbnailPath,
    thumbnailUrl,
    title,
    uniqueId,
    zoomConnected,
    zoomSharing,
  };
};

export const broadcastRemoteControlState = () => {
  try {
    const state = formatRemoteControlState();
    globalThis.electronApi.sendRemoteControlStateUpdate(state);
  } catch (error) {
    errorCatcher(error, {
      contexts: { fn: { name: 'broadcastRemoteControlState' } },
    });
  }
};

export const handleRemoteControlAction = (action: RemoteControlAction) => {
  try {
    const currentState = useCurrentStateStore();
    const { post: postSeekTo } = useBroadcastChannel<number, number>({
      name: 'seek-to',
    });

    switch (action.type) {
      case 'next': {
        globalThis.dispatchEvent(
          new CustomEvent<{ scrollToSelectedMedia: boolean }>(
            'shortcutMediaNext',
            {
              detail: { scrollToSelectedMedia: true },
            },
          ),
        );
        break;
      }
      case 'pause': {
        if (
          currentState.mediaPlaying.url &&
          currentState.mediaPlaying.action !== 'pause'
        ) {
          currentState.mediaPlaying.action = 'pause';
        } else {
          globalThis.dispatchEvent(
            new CustomEvent<undefined>('shortcutMediaPauseResume'),
          );
        }
        break;
      }
      case 'play': {
        if (currentState.mediaPlaying.action === 'pause') {
          currentState.mediaPlaying.action = 'play';
        } else if (currentState.mediaPlaying.url) {
          currentState.mediaPlaying.action = 'play';
        } else {
          globalThis.dispatchEvent(
            new CustomEvent<undefined>('shortcutMediaPauseResume'),
          );
        }
        break;
      }
      case 'previous': {
        globalThis.dispatchEvent(
          new CustomEvent<{ scrollToSelectedMedia: boolean }>(
            'shortcutMediaPrevious',
            {
              detail: { scrollToSelectedMedia: true },
            },
          ),
        );
        break;
      }
      case 'refresh_playlist': {
        broadcastRemoteControlState();
        break;
      }
      case 'seek': {
        if (typeof action.position === 'number') {
          postSeekTo(action.position);
          currentState.mediaPlaying.seekTo = action.position;
          currentState.mediaPlaying.currentPosition = action.position;
        }
        break;
      }
      case 'select_item': {
        if (action.uniqueId) {
          globalThis.dispatchEvent(
            new CustomEvent<{ play?: boolean; uniqueId: string }>(
              'remoteControlSelectMedia',
              {
                detail: { play: action.play, uniqueId: action.uniqueId },
              },
            ),
          );
        }
        break;
      }
      case 'stop': {
        stopZoomSharingAfterMedia();
        triggerMediaWindowAutoHide(false);
        globalThis.dispatchEvent(
          new CustomEvent<undefined>('remoteControlStop'),
        );
        if (currentState.mediaPlaying.url || currentState.mediaPlaying.action) {
          currentState.mediaPlaying = {
            action: '',
            currentPosition: 0,
            currentPositionUpdatedAt: 0,
            duration: 0,
            pan: { x: 0, y: 0 },
            playbackConfirmedToken: 0,
            playbackRate: 1,
            playToken: 0,
            seekTo: 0,
            shouldLoop: false,
            slideshowAudioUrl: '',
            subtitlesUrl: '',
            uniqueId: '',
            url: '',
            zoom: 1,
          };
          toggleMediaWindowVisibility(false);
        }
        break;
      }
      case 'stop_zoom_share': {
        const zoomState = useZoomStateStore();
        zoomState.setMeeting({
          ...(zoomState.meeting ?? { found: true }),
          sharing: false,
        });
        broadcastRemoteControlState();
        stopSharingMediaInZoom().catch((error: unknown) => {
          errorCatcher(error, {
            contexts: { fn: { name: 'stopSharingMediaInZoom' } },
          });
        });
        break;
      }
      case 'toggle_blackout': {
        toggleMediaWindowVisibility();
        break;
      }
    }

    // Push updated state back with quick and settled broadcasts
    setTimeout(() => {
      broadcastRemoteControlState();
    }, 50);
    setTimeout(() => {
      broadcastRemoteControlState();
    }, 200);
  } catch (error) {
    errorCatcher(error, {
      contexts: { fn: { action, name: 'handleRemoteControlAction' } },
    });
  }
};

const applySettings = async () => {
  const currentState = useCurrentStateStore();
  const settings = currentState.currentSettings;
  const wantedPort = settings?.enableRemoteControl
    ? parseRemoteControlPort(settings.remoteControlPort)
    : null;

  if (wantedPort === null) {
    if (runningPort !== null) {
      await globalThis.electronApi.stopRemoteControl();
      runningPort = null;
      runningPin = null;
      currentState.setRemoteControlStatus({
        clientCount: 0,
        running: false,
        urls: [],
      });
      log('Remote control server stopped', 'remoteControl', 'info');
    }
    return;
  }

  const requirePin = settings?.remoteControlRequirePin ?? true;
  const pin = requirePin ? settings?.remoteControlPin || '1234' : undefined;

  if (
    runningPort === wantedPort &&
    runningRequirePin === requirePin &&
    runningPin === (pin ?? null)
  ) {
    return;
  }

  const status = await globalThis.electronApi.startRemoteControl({
    pin,
    port: wantedPort,
    requirePin,
  });

  if (!status.running) {
    runningPort = null;
    runningPin = null;
    currentState.setRemoteControlStatus({
      clientCount: 0,
      running: false,
      urls: [],
    });
    notifyStartFailed(status.error);
    return;
  }

  runningPort = wantedPort;
  runningPin = pin ?? null;
  runningRequirePin = requirePin;
  currentState.setRemoteControlStatus({
    clientCount: status.clientCount,
    pin: status.pin,
    running: true,
    urls: status.urls,
  });
  log('Remote control server started', 'remoteControl', 'info', status.urls);
  broadcastRemoteControlState();
};

export const syncRemoteControl = async () => {
  if (syncInProgress) await syncInProgress;
  syncInProgress = applySettings().catch((error) => {
    errorCatcher(error, { contexts: { fn: { name: 'syncRemoteControl' } } });
  });
  try {
    await syncInProgress;
  } finally {
    syncInProgress = null;
  }
};

export const initRemoteControl = (): (() => void) => {
  if (removeActionListener) {
    removeActionListener();
    removeActionListener = null;
  }

  removeActionListener = globalThis.electronApi.onRemoteControlAction(
    (action) => {
      handleRemoteControlAction(action);
    },
  );

  return () => {
    if (removeActionListener) {
      removeActionListener();
      removeActionListener = null;
    }
  };
};

export const __testables = {
  reset: () => {
    runningPort = null;
    runningPin = null;
    runningRequirePin = true;
    syncInProgress = null;
    if (removeActionListener) {
      removeActionListener();
      removeActionListener = null;
    }
  },
};
