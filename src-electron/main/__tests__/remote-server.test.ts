import type { RemoteControlAction, RemoteControlState } from 'src/types';

import { getHttpServer } from 'app/test/vitest/mocks/http';
import { http, passthrough } from 'msw';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'upath';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('src-electron/main/utils', () => ({ captureElectronError: vi.fn() }));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const get = async (port: number, path: string) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { body: await response.text(), response };
};

beforeEach(() => {
  getHttpServer()?.use(
    http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
  );
});

afterEach(async () => {
  const { __testables, stopRemoteControlServer } =
    await import('src-electron/remote/server');
  await stopRemoteControlServer();
  __testables.reset();
});

describe('remote control server', () => {
  it('refuses ports outside the valid unprivileged range', async () => {
    const { isValidRemoteControlPort, startRemoteControlServer } =
      await import('src-electron/remote/server');

    expect(isValidRemoteControlPort(80)).toBe(false);
    expect(isValidRemoteControlPort(8080)).toBe(true);
    expect(isValidRemoteControlPort('8080')).toBe(false);
    expect(isValidRemoteControlPort(70_000)).toBe(false);

    const result = await startRemoteControlServer({ port: 80 });
    expect(result.running).toBe(false);
    expect(result.error).toBe('invalid-port');
  });

  it('serves status API, index.html, and PWA assets over HTTP', async () => {
    const { startRemoteControlServer } =
      await import('src-electron/remote/server');
    const port = await freePort();
    const status = await startRemoteControlServer({
      pin: '9876',
      port,
      requirePin: true,
    });

    expect(status.running).toBe(true);
    expect(status.port).toBe(port);
    expect(status.pin).toBe('9876');

    // Test API status
    const apiStatus = await get(port, '/api/status');
    expect(apiStatus.response.status).toBe(200);
    const json = JSON.parse(apiStatus.body) as {
      authRequired: boolean;
      running: boolean;
    };
    expect(json.running).toBe(true);
    expect(json.authRequired).toBe(true);

    // Test index.html
    const indexRes = await get(port, '/');
    expect(indexRes.response.status).toBe(200);
    expect(indexRes.body).toContain('M³ Remote');
  });

  it('handles client WebSocket authentication and command forwarding', async () => {
    const {
      broadcastRemoteControlState,
      setRemoteControlActionHandler,
      startRemoteControlServer,
    } = await import('src-electron/remote/server');

    const port = await freePort();
    await startRemoteControlServer({
      pin: '5432',
      port,
      requirePin: true,
    });

    const receivedActions: RemoteControlAction[] = [];
    setRemoteControlActionHandler((action) => {
      receivedActions.push(action);
    });

    // Connect with unauthenticated WS first
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Connection timed out')),
        3000,
      );
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', reject);
    });

    // Receive auth_required
    const authRequiredMsg = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      },
    );
    expect(authRequiredMsg.type).toBe('auth_required');

    // Send invalid PIN
    ws.send(JSON.stringify({ pin: '0000', type: 'auth' }));
    const authErrorMsg = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      },
    );
    expect(authErrorMsg.type).toBe('auth_error');

    // Send valid PIN
    ws.send(JSON.stringify({ pin: '5432', type: 'auth' }));
    const authSuccessMsg = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      },
    );
    expect(authSuccessMsg.type).toBe('auth_success');

    // Send command from client
    ws.send(JSON.stringify({ type: 'play' }));
    ws.send(JSON.stringify({ position: 45.2, type: 'seek' }));
    ws.send(JSON.stringify({ type: 'refresh_playlist' }));
    ws.send(JSON.stringify({ type: 'stop_zoom_share' }));
    ws.send(
      JSON.stringify({
        play: true,
        type: 'select_item',
        uniqueId: 'item-123',
      }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(receivedActions).toEqual([
      { type: 'play' },
      { position: 45.2, type: 'seek' },
      { type: 'refresh_playlist' },
      { type: 'stop_zoom_share' },
      { play: true, type: 'select_item', uniqueId: 'item-123' },
    ]);

    // Test broadcasting state change to client
    const testState: RemoteControlState = {
      currentPosition: 12,
      duration: 120,
      isPaused: false,
      isPlaying: true,
      isStopped: false,
      mediaType: 'video',
      mediaWindowVisible: true,
      playlist: [{ title: 'Sample Video', uniqueId: 'item-123' }],
      title: 'Sample Video',
    };

    const statePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    broadcastRemoteControlState(testState);
    const broadcastMsg = await statePromise;
    expect(broadcastMsg.type).toBe('state_change');
    expect(broadcastMsg.data).toEqual(testState);

    ws.close();
  });

  it('streams thumbnail image over /api/thumbnail', async () => {
    const { broadcastRemoteControlState, startRemoteControlServer } =
      await import('src-electron/remote/server');
    const port = await freePort();
    await startRemoteControlServer({
      pin: '1234',
      port,
      requirePin: false,
    });

    const tmpPath = join(tmpdir(), `test-thumb-${Date.now()}.jpg`);
    writeFileSync(tmpPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    try {
      broadcastRemoteControlState({
        currentPosition: 0,
        duration: 10,
        isPaused: false,
        isPlaying: false,
        isStopped: true,
        mediaType: 'image',
        mediaWindowVisible: true,
        playlist: [
          {
            thumbnailPath: tmpPath,
            thumbnailUrl: '/api/thumbnail?id=img-item-1',
            title: 'Image Test',
            uniqueId: 'img-item-1',
          },
        ],
        title: 'Image Test',
        uniqueId: 'img-item-1',
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=img-item-1`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);

      // Media item without on-disk companion image returns SVG fallback
      broadcastRemoteControlState({
        currentPosition: 0,
        duration: 120,
        isPaused: false,
        isPlaying: false,
        isStopped: true,
        mediaType: 'video',
        mediaWindowVisible: true,
        playlist: [
          {
            thumbnailPath: '/path/to/nonexistent-song.mp4',
            thumbnailUrl: '/api/thumbnail?id=vid-item-2',
            title: 'Video Song',
            uniqueId: 'vid-item-2',
          },
        ],
        title: 'Video Song',
        uniqueId: 'vid-item-2',
      });

      const fallbackRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=vid-item-2`,
      );
      expect(fallbackRes.status).toBe(200);
      expect(fallbackRes.headers.get('content-type')).toContain(
        'image/svg+xml',
      );
      const svgText = await fallbackRes.text();
      expect(svgText).toContain('<svg');
      expect(svgText).toContain('VIDEO');

      const notFoundRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=unknown`,
      );
      expect(notFoundRes.status).toBe(404);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});
