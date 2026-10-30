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

const get = async (
  port: number,
  path: string,
  headers?: Record<string, string>,
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { body: await response.text(), response };
};

const connectAndReceiveAuthRequired = async (
  port: number,
): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const firstMsg = await new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
  });
  expect(firstMsg.type).toBe('auth_required');
  return ws;
};

beforeEach(() => {
  getHttpServer()?.use(
    http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
  );
});

afterEach(async () => {
  const { stopRemoteControlServer } =
    await import('src-electron/remote/server');
  await stopRemoteControlServer();
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

  it('serves status API, index.html, and CSP security headers over HTTP', async () => {
    const { startRemoteControlServer } =
      await import('src-electron/remote/server');
    const port = await freePort();
    const status = await startRemoteControlServer({
      port,
      scope: 'partial',
    });

    expect(status.running).toBe(true);
    expect(status.port).toBe(port);
    expect(status.pairingCode).toMatch(/^\d{6}$/);

    // Test API status
    const apiStatus = await get(port, '/api/status');
    expect(apiStatus.response.status).toBe(200);
    expect(apiStatus.response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(apiStatus.response.headers.get('x-content-type-options')).toBe(
      'nosniff',
    );
    expect(apiStatus.response.headers.get('x-frame-options')).toBe('DENY');

    const json = JSON.parse(apiStatus.body) as {
      pairingRequired: boolean;
      running: boolean;
      scope: string;
    };
    expect(json.running).toBe(true);
    expect(json.pairingRequired).toBe(true);
    expect(json.scope).toBe('partial');

    // Test index.html
    const indexRes = await get(port, '/');
    expect(indexRes.response.status).toBe(200);
    expect(indexRes.body).toContain('M³ Remote');
  });

  it('rejects HTTP requests with untrusted external Origin headers', async () => {
    const { startRemoteControlServer } =
      await import('src-electron/remote/server');
    const port = await freePort();
    await startRemoteControlServer({ port });

    const evilRes = await get(port, '/api/status', {
      origin: 'http://malicious-site.example.com',
    });
    expect(evilRes.response.status).toBe(403);
  });

  it('handles pairing, token issuance, command acks, and single controller lock', async () => {
    const {
      broadcastRemoteControlState,
      revokeAllSessions,
      setRemoteControlActionHandler,
      startRemoteControlServer,
    } = await import('src-electron/remote/server');

    const port = await freePort();
    const status = await startRemoteControlServer({
      port,
      scope: 'full',
    });
    const pairingCode = status.pairingCode;

    const receivedActions: RemoteControlAction[] = [];
    setRemoteControlActionHandler((action) => {
      receivedActions.push(action);
    });

    // 1. Connect client 1
    const ws1 = await connectAndReceiveAuthRequired(port);

    // Wrong code gives auth_error
    ws1.send(
      JSON.stringify({ code: '000000', deviceName: 'Phone 1', type: 'pair' }),
    );
    const authErrorMsg = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws1.once('message', (d) => resolve(JSON.parse(d.toString())));
      },
    );
    expect(authErrorMsg.type).toBe('auth_error');

    // Valid pairing code returns auth_success and token
    ws1.send(
      JSON.stringify({
        code: pairingCode,
        deviceName: 'Phone 1',
        type: 'pair',
      }),
    );
    const authSuccessMsg = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws1.once('message', (d) => resolve(JSON.parse(d.toString())));
      },
    );
    expect(authSuccessMsg.type).toBe('auth_success');
    expect(typeof authSuccessMsg.token).toBe('string');
    const token1 = authSuccessMsg.token as string;

    // Send command with sequence number and expect ACK
    ws1.send(
      JSON.stringify({
        action: { type: 'play' },
        id: 'cmd-1',
        seq: 1,
        type: 'action',
      }),
    );
    const ack1 = await new Promise<Record<string, unknown>>((resolve) => {
      ws1.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(ack1.type).toBe('ack');
    expect(ack1.success).toBe(true);
    expect(ack1.id).toBe('cmd-1');
    expect(receivedActions).toEqual([{ type: 'play' }]);

    // 2. Connect client 2 and consume auth_required
    const ws2 = await connectAndReceiveAuthRequired(port);

    // Authenticate client 2 using the same token
    ws2.send(JSON.stringify({ token: token1, type: 'auth' }));
    const authSuccess2 = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws2.once('message', (d) => resolve(JSON.parse(d.toString())));
      },
    );
    expect(authSuccess2.type).toBe('auth_success');

    // Test broadcasting state change to clients
    const testState: RemoteControlState = {
      currentPosition: 10,
      duration: 100,
      isPaused: false,
      isPlaying: true,
      isStopped: false,
      mediaType: 'video',
      mediaWindowVisible: true,
      playlist: [{ title: 'Track 1', uniqueId: 'track-1' }],
      scope: 'full',
      title: 'Track 1',
    };

    const statePromise = new Promise<Record<string, unknown>>((resolve) => {
      ws1.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    broadcastRemoteControlState(testState);
    const stateMsg = await statePromise;
    expect(stateMsg.type).toBe('state_change');

    // Revoke all sessions disconnects clients
    revokeAllSessions();
    ws1.close();
    ws2.close();
  });

  it('enforces transport-only scope restriction', async () => {
    const { setRemoteControlActionHandler, startRemoteControlServer } =
      await import('src-electron/remote/server');

    const port = await freePort();
    const status = await startRemoteControlServer({
      port,
      scope: 'partial',
    });

    const receivedActions: RemoteControlAction[] = [];
    setRemoteControlActionHandler((a) => receivedActions.push(a));

    const ws = await connectAndReceiveAuthRequired(port);

    ws.send(
      JSON.stringify({
        code: status.pairingCode,
        deviceName: 'Tablet',
        type: 'pair',
      }),
    );
    const pairResult = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(pairResult.type).toBe('auth_success');

    // Transport action allowed
    ws.send(
      JSON.stringify({
        action: { type: 'pause' },
        id: 'c-1',
        seq: 1,
        type: 'action',
      }),
    );
    const ack1 = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(ack1.success).toBe(true);

    // Playlist playback (select_item) is allowed in partial mode
    ws.send(
      JSON.stringify({
        action: { play: true, type: 'select_item', uniqueId: 'item-abc' },
        id: 'c-select',
        seq: 2,
        type: 'action',
      }),
    );
    const ackSelect = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(ackSelect.success).toBe(true);
    expect(receivedActions).toEqual([
      { type: 'pause' },
      { play: true, type: 'select_item', uniqueId: 'item-abc' },
    ]);

    // Prohibited action in partial mode (toggle_blackout)
    ws.send(
      JSON.stringify({
        action: { type: 'toggle_blackout' },
        id: 'c-2',
        seq: 3,
        type: 'action',
      }),
    );
    const ack2 = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(ack2.success).toBe(false);
    expect(ack2.error).toContain('transport-only');

    // Switch scope to 'full' dynamically on the running server
    const stateChangePromise = new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      },
    );
    const updatedStatus = await startRemoteControlServer({
      port,
      scope: 'full',
    });
    expect(updatedStatus.scope).toBe('full');

    const stateChange = await stateChangePromise;
    expect(stateChange.type).toBe('state_change');
    expect((stateChange.data as Record<string, unknown>).scope).toBe('full');

    // After switching to full, toggle_blackout is permitted
    ws.send(
      JSON.stringify({
        action: { type: 'toggle_blackout' },
        id: 'c-3',
        seq: 4,
        type: 'action',
      }),
    );
    const ack3 = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(ack3.success).toBe(true);

    ws.close();
  });

  it('requires token auth and confines thumbnail streaming to opaque IDs', async () => {
    const { broadcastRemoteControlState, startRemoteControlServer } =
      await import('src-electron/remote/server');
    const port = await freePort();
    const status = await startRemoteControlServer({ port });

    // Pair to get token
    const ws = await connectAndReceiveAuthRequired(port);
    ws.send(
      JSON.stringify({
        code: status.pairingCode,
        deviceName: 'Test Phone',
        type: 'pair',
      }),
    );
    const pairMsg = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    const token = pairMsg.token as string;
    expect(typeof token).toBe('string');

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
        scope: 'full',
        title: 'Image Test',
        uniqueId: 'img-item-1',
      });

      // Request without token -> 401 Unauthorized
      const unauthRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=img-item-1`,
      );
      expect(unauthRes.status).toBe(401);

      // Request with valid token -> 200 OK
      const authRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=img-item-1&token=${token}`,
      );
      expect(authRes.status).toBe(200);
      expect(authRes.headers.get('content-type')).toBe('image/jpeg');

      // Request with unknown id -> 404
      const notFoundRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=unknown&token=${token}`,
      );
      expect(notFoundRes.status).toBe(404);

      // Thumbnail with remote streamUrl fallback -> 302 Redirect
      broadcastRemoteControlState({
        currentPosition: 0,
        duration: 10,
        isPaused: false,
        isPlaying: false,
        isStopped: true,
        mediaType: 'video',
        mediaWindowVisible: true,
        playlist: [
          {
            thumbnailStreamUrl: 'https://assets.jw.org/sample.jpg',
            thumbnailUrl: '/api/thumbnail?id=video-item-1',
            title: 'Video Test',
            uniqueId: 'video-item-1',
          },
        ],
        scope: 'full',
        title: 'Video Test',
        uniqueId: 'video-item-1',
      });

      const redirectRes = await fetch(
        `http://127.0.0.1:${port}/api/thumbnail?id=video-item-1&token=${token}`,
        { redirect: 'manual' },
      );
      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.get('location')).toBe(
        'https://assets.jw.org/sample.jpg',
      );
    } finally {
      rmSync(tmpPath, { force: true });
      ws.close();
    }
  });

  it('notifies status handler when device connects, logs out, and regenerates PIN', async () => {
    const {
      getRemoteControlStatus,
      regeneratePairingCode,
      revokeActiveController,
      setRemoteControlStatusHandler,
      startRemoteControlServer,
    } = await import('src-electron/remote/server');

    const port = await freePort();
    await startRemoteControlServer({ port });

    interface StatusUpdate {
      activeControllerName?: string;
      clientCount?: number;
      pairingCode?: string;
    }
    const statusUpdates: StatusUpdate[] = [];

    setRemoteControlStatusHandler((status) => {
      statusUpdates.push({
        activeControllerName: status.activeControllerName,
        clientCount: status.clientCount,
        pairingCode: status.pairingCode,
      });
    });

    // 1. Regenerate PIN code
    const initialCode = getRemoteControlStatus().pairingCode;
    const newCode = regeneratePairingCode();
    expect(newCode).toMatch(/^\d{6}$/);
    expect(statusUpdates.length).toBeGreaterThan(0);
    expect(statusUpdates.at(-1)?.pairingCode).toBe(newCode);
    expect(initialCode).toBeDefined();

    // 2. Connect client and pair
    const ws = await connectAndReceiveAuthRequired(port);
    ws.send(
      JSON.stringify({
        code: newCode,
        deviceName: 'Auditorium iPad',
        type: 'pair',
      }),
    );
    const pairResult = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(pairResult.type).toBe('auth_success');

    // Status handler should receive active controller name and clientCount = 1
    const latestAfterPair = statusUpdates.at(-1);
    expect(latestAfterPair?.activeControllerName).toBe('Auditorium iPad');
    expect(latestAfterPair?.clientCount).toBe(1);

    // 3. Logout from mobile device
    ws.send(JSON.stringify({ type: 'logout' }));
    const logoutReply = await new Promise<Record<string, unknown>>(
      (resolve) => {
        ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      },
    );
    expect(logoutReply.type).toBe('auth_required');

    // Status handler should receive cleared active controller name and clientCount = 0
    const latestAfterLogout = statusUpdates.at(-1);
    expect(latestAfterLogout?.activeControllerName).toBe('');
    expect(latestAfterLogout?.clientCount).toBe(0);

    // 4. Test revokeActiveController from desktop
    const ws2 = await connectAndReceiveAuthRequired(port);
    ws2.send(
      JSON.stringify({
        code: newCode,
        deviceName: 'Phone Controller',
        type: 'pair',
      }),
    );
    await new Promise<Record<string, unknown>>((resolve) => {
      ws2.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(statusUpdates.at(-1)?.activeControllerName).toBe('Phone Controller');

    revokeActiveController();
    const revokedMsg = await new Promise<Record<string, unknown>>((resolve) => {
      ws2.once('message', (d) => resolve(JSON.parse(d.toString())));
    });
    expect(revokedMsg.type).toBe('auth_error');
    expect(revokedMsg.message).toContain('revoked');
    expect(statusUpdates.at(-1)?.activeControllerName).toBe('');

    setRemoteControlStatusHandler(null);
    ws.close();
    ws2.close();
  });
});
