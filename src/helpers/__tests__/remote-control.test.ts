import type * as VueUse from '@vueuse/core';
import type { ZoomMeetingState } from 'src/types';

import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings } from 'src/constants/settings';
import { useCongregationSettingsStore } from 'stores/congregation-settings';
import { useCurrentStateStore } from 'stores/current-state';
import { useZoomStateStore } from 'stores/zoom-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testables,
  broadcastRemoteControlState,
  formatRemoteControlState,
  generateRandomPin,
  handleRemoteControlAction,
  parseRemoteControlPort,
  syncRemoteControl,
} from '../remote-control';

const {
  createTemporaryNotification,
  electronApi,
  postSeek,
  stopSharingMediaInZoom,
  stopZoomSharingAfterMedia,
  toggleMediaWindowVisibility,
  triggerMediaWindowAutoHide,
} = vi.hoisted(() => ({
  createTemporaryNotification: vi.fn(),
  electronApi: {
    onRemoteControlAction: vi.fn(() => vi.fn()),
    sendRemoteControlStateUpdate: vi.fn(),
    startRemoteControl: vi.fn(),
    stopRemoteControl: vi.fn(),
  },
  postSeek: vi.fn(),
  stopSharingMediaInZoom: vi.fn(),
  stopZoomSharingAfterMedia: vi.fn(),
  toggleMediaWindowVisibility: vi.fn(),
  triggerMediaWindowAutoHide: vi.fn(),
}));

vi.mock('boot/i18n', () => ({
  i18n: { global: { locale: { value: 'en' }, t: (key: string) => key } },
}));

vi.mock('src/helpers/notifications', () => ({ createTemporaryNotification }));
vi.mock('src/helpers/mediaPlayback', () => ({ toggleMediaWindowVisibility }));
vi.mock('src/helpers/mediaWindowAutoHide', () => ({
  triggerMediaWindowAutoHide,
}));
vi.mock('src/helpers/zoom', () => ({
  stopSharingMediaInZoom,
  stopZoomSharingAfterMedia,
}));
vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof VueUse>();
  return {
    ...actual,
    useBroadcastChannel: () => ({ post: postSeek }),
  };
});

const configure = (changes: Partial<typeof defaultSettings>) => {
  useCongregationSettingsStore().congregations['cong'] = {
    ...defaultSettings,
    ...changes,
  };
  useCurrentStateStore().currentCongregation = 'cong';
};

beforeEach(() => {
  setActivePinia(createPinia());
  __testables.reset();
  vi.stubGlobal('electronApi', {
    ...globalThis.electronApi,
    ...electronApi,
  });
  electronApi.startRemoteControl.mockReset();
  electronApi.stopRemoteControl.mockReset();
  electronApi.sendRemoteControlStateUpdate.mockReset();
  createTemporaryNotification.mockReset();
  toggleMediaWindowVisibility.mockReset();
  stopSharingMediaInZoom.mockReset();
  postSeek.mockReset();
});

describe('parseRemoteControlPort', () => {
  it('accepts unprivileged ports between 1024 and 65535', () => {
    expect(parseRemoteControlPort('8080')).toBe(8080);
    expect(parseRemoteControlPort(' 9090 ')).toBe(9090);
    expect(parseRemoteControlPort('80')).toBeNull();
    expect(parseRemoteControlPort('70000')).toBeNull();
    expect(parseRemoteControlPort('invalid')).toBeNull();
    expect(parseRemoteControlPort(null)).toBeNull();
  });
});

describe('generateRandomPin', () => {
  it('generates a 4-digit numeric string', () => {
    const pin = generateRandomPin();
    expect(pin).toMatch(/^\d{4}$/);
  });
});

describe('syncRemoteControl', () => {
  it('does nothing while remote control is disabled', async () => {
    configure({ enableRemoteControl: false });
    await syncRemoteControl();
    expect(electronApi.startRemoteControl).not.toHaveBeenCalled();
    expect(electronApi.stopRemoteControl).not.toHaveBeenCalled();
  });

  it('starts the server and updates currentState store', async () => {
    configure({
      enableRemoteControl: true,
      remoteControlPin: '5678',
      remoteControlPort: '8080',
      remoteControlRequirePin: true,
    });
    electronApi.startRemoteControl.mockResolvedValue({
      clientCount: 0,
      pin: '5678',
      port: 8080,
      running: true,
      urls: ['http://192.168.1.50:8080/'],
    });

    await syncRemoteControl();

    expect(electronApi.startRemoteControl).toHaveBeenCalledWith({
      pin: '5678',
      port: 8080,
      requirePin: true,
    });

    const currentState = useCurrentStateStore();
    expect(currentState.remoteControlRunning).toBe(true);
    expect(currentState.remoteControlUrls).toEqual([
      'http://192.168.1.50:8080/',
    ]);
    expect(currentState.remoteControlPin).toBe('5678');

    // Should not restart if configuration is identical
    await syncRemoteControl();
    expect(electronApi.startRemoteControl).toHaveBeenCalledTimes(1);
  });

  it('restarts server on new port or pin and stops when disabled', async () => {
    configure({
      enableRemoteControl: true,
      remoteControlPin: '1111',
      remoteControlPort: '8080',
      remoteControlRequirePin: true,
    });
    electronApi.startRemoteControl.mockResolvedValue({
      clientCount: 0,
      pin: '1111',
      port: 8080,
      running: true,
      urls: [],
    });
    await syncRemoteControl();

    configure({
      enableRemoteControl: true,
      remoteControlPin: '2222',
      remoteControlPort: '9000',
      remoteControlRequirePin: true,
    });
    await syncRemoteControl();
    expect(electronApi.startRemoteControl).toHaveBeenLastCalledWith({
      pin: '2222',
      port: 9000,
      requirePin: true,
    });

    configure({ enableRemoteControl: false });
    await syncRemoteControl();
    expect(electronApi.stopRemoteControl).toHaveBeenCalledTimes(1);
    expect(useCurrentStateStore().remoteControlRunning).toBe(false);
  });

  it('notifies user on start failure', async () => {
    configure({
      enableRemoteControl: true,
      remoteControlPort: '8080',
    });
    electronApi.startRemoteControl.mockResolvedValue({
      clientCount: 0,
      error: 'port-in-use',
      running: false,
      urls: [],
    });

    await syncRemoteControl();

    expect(createTemporaryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'remote-control-port-in-use' }),
    );
  });
});

describe('handleRemoteControlAction', () => {
  it('dispatches shortcutMediaPauseResume on play/pause', () => {
    const dispatchSpy = vi.spyOn(globalThis, 'dispatchEvent');

    handleRemoteControlAction({ type: 'play' });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shortcutMediaPauseResume' }),
    );

    handleRemoteControlAction({ type: 'pause' });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shortcutMediaPauseResume' }),
    );
  });

  it('dispatches remoteControlStop on stop', () => {
    const dispatchSpy = vi.spyOn(globalThis, 'dispatchEvent');

    handleRemoteControlAction({ type: 'stop' });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'remoteControlStop' }),
    );
  });

  it('broadcasts state on refresh_playlist action', () => {
    handleRemoteControlAction({ type: 'refresh_playlist' });
    expect(electronApi.sendRemoteControlStateUpdate).toHaveBeenCalled();
  });

  it('dispatches next and previous actions', () => {
    const dispatchSpy = vi.spyOn(globalThis, 'dispatchEvent');

    handleRemoteControlAction({ type: 'next' });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shortcutMediaNext' }),
    );

    handleRemoteControlAction({ type: 'previous' });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shortcutMediaPrevious' }),
    );
  });

  it('toggles blackout using toggleMediaWindowVisibility', () => {
    handleRemoteControlAction({ type: 'toggle_blackout' });
    expect(toggleMediaWindowVisibility).toHaveBeenCalled();
  });

  it('updates position and broadcasts on seek', () => {
    const currentState = useCurrentStateStore();
    handleRemoteControlAction({ position: 45, type: 'seek' });

    expect(postSeek).toHaveBeenCalledWith(45);
    expect(currentState.mediaPlaying.seekTo).toBe(45);
    expect(currentState.mediaPlaying.currentPosition).toBe(45);
  });

  it('dispatches remoteControlSelectMedia on select_item', () => {
    const dispatchSpy = vi.spyOn(globalThis, 'dispatchEvent');

    handleRemoteControlAction({
      play: true,
      type: 'select_item',
      uniqueId: 'media-123',
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { play: true, uniqueId: 'media-123' },
        type: 'remoteControlSelectMedia',
      }),
    );
  });
});

describe('formatRemoteControlState & broadcastRemoteControlState', () => {
  it('formats idle state correctly', () => {
    const currentState = useCurrentStateStore();
    currentState.mediaWindowVisible = true;
    let state = formatRemoteControlState();
    expect(state.isPlaying).toBe(false);
    expect(state.isPaused).toBe(false);
    expect(state.mediaWindowVisible).toBe(true);
    expect(state.playlist).toEqual([]);

    currentState.mediaWindowVisible = false;
    state = formatRemoteControlState();
    expect(state.mediaWindowVisible).toBe(false);
  });

  it('formats playing state and broadcasts update', () => {
    const currentState = useCurrentStateStore();
    currentState.mediaPlaying.action = 'play';
    currentState.mediaPlaying.url = 'file:///path/to/sample.mp4';
    currentState.mediaPlaying.uniqueId = 'item-1';
    currentState.mediaPlaying.duration = 120;
    currentState.mediaPlaying.currentPosition = 30;
    currentState.mediaWindowVisible = true;

    const state = formatRemoteControlState();
    expect(state.isPlaying).toBe(true);
    expect(state.isPaused).toBe(false);
    expect(state.mediaWindowVisible).toBe(true);
    expect(state.currentPosition).toBe(30);
    expect(state.duration).toBe(120);

    broadcastRemoteControlState();
    expect(electronApi.sendRemoteControlStateUpdate).toHaveBeenCalledWith(
      state,
    );
  });

  it('recognizes active playback when action is empty string but url is active', () => {
    const currentState = useCurrentStateStore();
    currentState.mediaPlaying.action = '';
    currentState.mediaPlaying.url = 'file:///path/to/video.mp4';
    currentState.mediaPlaying.uniqueId = 'item-1';

    const playingState = formatRemoteControlState();
    expect(playingState.isPlaying).toBe(true);
    expect(playingState.isPaused).toBe(false);
    expect(playingState.isStopped).toBe(false);

    currentState.mediaPlaying.action = 'pause';
    const pausedState = formatRemoteControlState();
    expect(pausedState.isPlaying).toBe(false);
    expect(pausedState.isPaused).toBe(true);
    expect(pausedState.isStopped).toBe(false);
  });

  it('formats playlist with sections, folder groups and song numbers', () => {
    const currentState = useCurrentStateStore();
    const mockDateObject = {
      date: '2026-10-28',
      mediaSections: [
        {
          config: { label: 'Treasures From God’s Word', uniqueId: 'treasures' },
          items: [
            {
              duration: 180,
              fileUrl: 'file:///song1.mp3',
              tag: { type: 'song', value: 45 },
              title: 'Song 45',
              uniqueId: 'song-45',
            },
            {
              title: 'Morning Session',
              type: 'divider',
              uniqueId: 'div-1',
            },
            {
              children: [
                {
                  duration: 60,
                  fileUrl: 'file:///img1.jpg',
                  isImage: true,
                  title: 'Part 1 Slide',
                  uniqueId: 'child-1',
                },
              ],
              extractCaption: 'Talk Discussion',
              uniqueId: 'group-1',
            },
          ],
        },
      ],
    };

    Object.defineProperty(currentState, 'selectedDateObject', {
      configurable: true,
      get: () => mockDateObject,
    });

    const state = formatRemoteControlState();
    expect(state.playlist).toHaveLength(3);
    expect(state.playlist[0]).toEqual(
      expect.objectContaining({
        section: 'Treasures From God’s Word',
        sectionId: 'treasures',
        songNumber: 45,
        title: 'Song 45',
        uniqueId: 'song-45',
      }),
    );
    expect(state.playlist[1]).toEqual(
      expect.objectContaining({
        isDivider: true,
        section: 'Treasures From God’s Word',
        sectionId: 'treasures',
        title: 'Morning Session',
        uniqueId: 'div-1',
      }),
    );
    expect(state.playlist[2]).toEqual(
      expect.objectContaining({
        groupId: 'group-1',
        groupTitle: 'Talk Discussion',
        isImage: true,
        section: 'Treasures From God’s Word',
        sectionId: 'treasures',
        thumbnailUrl: '/api/thumbnail?id=child-1',
        title: 'Part 1 Slide',
        uniqueId: 'child-1',
      }),
    );
    expect(state.playlist[2]?.thumbnailPath).toBeDefined();

    // Now-playing state should inherit thumbnail info from playlist item
    currentState.mediaPlaying.uniqueId = 'child-1';
    currentState.mediaPlaying.url = 'file:///img1.jpg';
    currentState.mediaPlaying.action = 'play';
    const playingState = formatRemoteControlState();
    expect(playingState.thumbnailUrl).toBe('/api/thumbnail?id=child-1');
    expect(playingState.thumbnailPath).toBeDefined();
  });

  it('includes Zoom sharing state in formatted remote control state', () => {
    const zoomState = useZoomStateStore();
    zoomState.meeting = {
      found: true,
      sharing: true,
    } as unknown as ZoomMeetingState;

    const state = formatRemoteControlState();
    expect(state.zoomSharing).toBe(true);
    expect(state.zoomConnected).toBe(true);

    zoomState.meeting = {
      found: true,
      sharing: false,
    } as unknown as ZoomMeetingState;
    const notSharingState = formatRemoteControlState();
    expect(notSharingState.zoomSharing).toBe(false);
    expect(notSharingState.zoomConnected).toBe(true);
  });

  it('handles stop_zoom_share action', async () => {
    await handleRemoteControlAction({ type: 'stop_zoom_share' });
    expect(stopSharingMediaInZoom).toHaveBeenCalledTimes(1);
  });

  it('filters out empty ghost items with no files or children and strips HTML from group captions', () => {
    const currentState = useCurrentStateStore();
    const mockDateObject = {
      date: '2026-10-28',
      mediaSections: [
        {
          config: { label: 'Weekend Meeting', uniqueId: 'weekend' },
          items: [
            // Ghost item (no fileUrl, no children, not divider)
            {
              title: '',
              uniqueId: 'ghost-1',
            },
            // Group with HTML in extractCaption
            {
              children: [
                {
                  duration: 90,
                  fileUrl: 'file:///item1.mp4',
                  isVideo: true,
                  title: 'Clean Child',
                  uniqueId: 'child-clean',
                },
              ],
              extractCaption: '<p><b>Discussion &nbsp;Part</b></p>',
              uniqueId: 'group-html',
            },
          ],
        },
      ],
    };

    Object.defineProperty(currentState, 'selectedDateObject', {
      configurable: true,
      get: () => mockDateObject,
    });

    const state = formatRemoteControlState();
    // Ghost item should be filtered out
    expect(state.playlist).toHaveLength(1);
    expect(state.playlist[0]?.groupTitle).toBe('Discussion Part');
  });
});
