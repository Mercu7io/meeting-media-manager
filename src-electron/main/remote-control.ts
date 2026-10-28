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
  setRemoteControlActionHandler,
  startRemoteControlServer,
  stopRemoteControlServer,
} from 'src-electron/remote/server';

// Forward actions received by the remote server to the renderer process
setRemoteControlActionHandler((action: RemoteControlAction) => {
  if (mainWindowInfo.mainWindow && !mainWindowInfo.mainWindow.isDestroyed()) {
    mainWindowInfo.mainWindow.webContents.send('remote-control:action', action);
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
