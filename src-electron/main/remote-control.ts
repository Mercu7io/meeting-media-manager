import type {
  RemoteControlAction,
  RemoteControlStartOptions,
  RemoteControlState,
  RemoteControlStatus,
} from 'src/types';

import { mainWindowInfo } from 'src-electron/main/window/window-main';
import {
  broadcastRemoteControlState,
  getRemoteControlStatus as getServerStatus,
  regeneratePairingCode,
  revokeActiveController,
  revokeAllSessions,
  revokeSession,
  setRemoteControlActionHandler,
  setRemoteControlStatusHandler,
  startRemoteControlServer,
  stopRemoteControlServer,
} from 'src-electron/remote/server';

// Forward actions received by the remote server to the renderer process
setRemoteControlActionHandler((action: RemoteControlAction) => {
  if (mainWindowInfo.mainWindow && !mainWindowInfo.mainWindow.isDestroyed()) {
    mainWindowInfo.mainWindow.webContents.send('remote-control:action', action);
  }
});

// Forward status updates from the remote server to the renderer process
setRemoteControlStatusHandler((status: RemoteControlStatus) => {
  if (mainWindowInfo.mainWindow && !mainWindowInfo.mainWindow.isDestroyed()) {
    mainWindowInfo.mainWindow.webContents.send(
      'remote-control:status-changed',
      status,
    );
  }
});

export const startRemoteControl = (
  options?: RemoteControlStartOptions,
): Promise<RemoteControlStatus> => startRemoteControlServer(options);

export const stopRemoteControl = (): Promise<void> => stopRemoteControlServer();

export const getRemoteControlStatus = (): RemoteControlStatus =>
  getServerStatus();

export const updateRemoteControlState = (state: RemoteControlState): void => {
  broadcastRemoteControlState(state);
};

export const revokeRemoteControlSession = (deviceId: string): void => {
  revokeSession(deviceId);
};

export const revokeActiveRemoteController = (): void => {
  revokeActiveController();
};

export const disconnectAllRemoteControlClients = (): void => {
  revokeAllSessions();
};

export const regenerateRemoteControlPairingCode = (
  customCode?: string,
): RemoteControlStatus => {
  regeneratePairingCode(customCode);
  return getServerStatus();
};
