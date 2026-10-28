import type {
  RemoteControlAction,
  RemoteControlStartOptions,
  RemoteControlState,
  RemoteControlStatus,
} from 'src/types';

import { existsSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { captureElectronError } from 'src-electron/main/utils';
import {
  EMBEDDED_ICON_SVG,
  EMBEDDED_INDEX_HTML,
  EMBEDDED_MANIFEST,
} from 'src-electron/remote/embedded-assets';
import { log } from 'src/shared/vanilla';
import { dirname, join } from 'upath';
import { WebSocket, WebSocketServer } from 'ws';

const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const DEFAULT_PORT = 8080;

let httpServer: null | Server = null;
let wss: null | WebSocketServer = null;
let serverPort = DEFAULT_PORT;
let serverPin = '1234';
let serverRequirePin = true;
let isRunning = false;
let latestState: null | RemoteControlState = null;
let actionHandler: ((action: RemoteControlAction) => void) | null = null;

const authenticatedClients = new WeakSet<WebSocket>();

export const isValidRemoteControlPort = (port: unknown): port is number =>
  typeof port === 'number' &&
  Number.isInteger(port) &&
  port >= MIN_PORT &&
  port <= MAX_PORT;

export const generateRemoteControlPin = (): string =>
  Math.floor(1000 + Math.random() * 9000).toString();

const getIpPriority = (ip: string): number => {
  if (ip.startsWith('192.168.')) return 1;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 3;
  return 4;
};

export const getRemoteControlUrls = (port: number): string[] => {
  const ipList: string[] = [];
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal || address.family !== 'IPv4') continue;
        // Ignore link-local APIPA addresses (169.254.x.x)
        if (address.address.startsWith('169.254.')) continue;
        ipList.push(address.address);
      }
    }
  } catch (error) {
    captureElectronError(error, {
      contexts: { fn: { name: 'getRemoteControlUrls' } },
    });
  }

  // Sort by priority: 192.168.x.x first, then 10.x.x.x, etc.
  ipList.sort((a, b) => getIpPriority(a) - getIpPriority(b));

  return ipList.map((ip) => `http://${ip}:${port}/`);
};

export const setRemoteControlActionHandler = (
  handler: (action: RemoteControlAction) => void,
) => {
  actionHandler = handler;
};

const getPublicDir = () => {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const publicPath = join(currentDir, 'public');
    if (existsSync(publicPath)) return publicPath;
  } catch {
    // Fall back to process.cwd() resolution
  }
  return join(process.cwd(), 'src-electron/remote/public');
};

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const handleHttpRequest = (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const reqUrl = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );
  const pathname = reqUrl.pathname;

  if (pathname === '/api/status') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        authRequired: serverRequirePin,
        running: isRunning,
      }),
    );
    return;
  }

  const publicDir = getPublicDir();
  let targetFile = pathname === '/' ? '/index.html' : pathname;
  if (!targetFile.includes('.')) {
    targetFile += '.html';
  }

  const filePath = join(publicDir, targetFile);

  if (existsSync(filePath)) {
    try {
      const ext = targetFile.slice(targetFile.lastIndexOf('.'));
      const contentType = MIME_TYPES[ext] || 'text/plain';
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': contentType,
      });
      res.end(content);
      return;
    } catch (readError) {
      captureElectronError(readError, {
        contexts: { fn: { name: 'handleHttpRequest.read' } },
      });
    }
  }

  // Embedded assets fallback for packaged app / standalone builds
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(EMBEDDED_INDEX_HTML);
    return;
  }

  if (pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/manifest+json; charset=utf-8',
    });
    res.end(EMBEDDED_MANIFEST);
    return;
  }

  if (pathname === '/icon.svg') {
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'image/svg+xml',
    });
    res.end(EMBEDDED_ICON_SVG);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
};

const validateAction = (raw: unknown): null | RemoteControlAction => {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const type = candidate.type;

  if (
    type === 'play' ||
    type === 'pause' ||
    type === 'stop' ||
    type === 'next' ||
    type === 'previous' ||
    type === 'refresh_playlist' ||
    type === 'toggle_blackout'
  ) {
    return { type };
  }

  if (type === 'seek') {
    const pos = candidate.position;
    if (typeof pos === 'number' && Number.isFinite(pos) && pos >= 0) {
      return { position: pos, type: 'seek' };
    }
    return null;
  }

  if (type === 'select_item') {
    const uniqueId = candidate.uniqueId;
    if (typeof uniqueId === 'string' && uniqueId.length > 0) {
      return {
        play: candidate.play === true,
        type: 'select_item',
        uniqueId,
      };
    }
    return null;
  }

  return null;
};

const handleWsMessage = (ws: WebSocket, rawData: unknown) => {
  try {
    const text =
      typeof rawData === 'string' ? rawData : rawData?.toString() || '';
    const payload = JSON.parse(text) as Record<string, unknown>;

    if (payload.type === 'auth') {
      const clientPin =
        typeof payload.pin === 'string' ? payload.pin.trim() : '';
      if (!serverRequirePin || clientPin === serverPin) {
        authenticatedClients.add(ws);
        ws.send(JSON.stringify({ type: 'auth_success' }));
        if (latestState) {
          ws.send(JSON.stringify({ data: latestState, type: 'state_change' }));
        }
      } else {
        ws.send(JSON.stringify({ message: 'Invalid PIN', type: 'auth_error' }));
      }
      return;
    }

    if (serverRequirePin && !authenticatedClients.has(ws)) {
      ws.send(
        JSON.stringify({
          message: 'Authentication required',
          type: 'auth_error',
        }),
      );
      return;
    }

    // Command dispatching
    const actionObj =
      payload.type === 'action' && payload.action ? payload.action : payload;
    const validated = validateAction(actionObj);
    if (validated && actionHandler) {
      actionHandler(validated);
    }
  } catch (error) {
    log(
      'Remote control invalid WebSocket message received',
      'remoteControl',
      'warn',
      error,
    );
  }
};

export const broadcastRemoteControlState = (state: RemoteControlState) => {
  latestState = state;
  if (!wss) return;

  const message = JSON.stringify({ data: state, type: 'state_change' });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      if (!serverRequirePin || authenticatedClients.has(client)) {
        try {
          client.send(message);
        } catch (sendError) {
          captureElectronError(sendError, {
            contexts: { fn: { name: 'broadcastRemoteControlState' } },
          });
        }
      }
    }
  }
};

export const getRemoteControlStatus = (): RemoteControlStatus => {
  const clientCount = wss
    ? Array.from(wss.clients).filter(
        (c) =>
          c.readyState === WebSocket.OPEN &&
          (!serverRequirePin || authenticatedClients.has(c)),
      ).length
    : 0;
  return {
    clientCount,
    pin: serverPin,
    port: serverPort,
    requirePin: serverRequirePin,
    running: isRunning,
    urls: isRunning ? getRemoteControlUrls(serverPort) : [],
  };
};

export const stopRemoteControlServer = (): Promise<void> =>
  new Promise((resolve) => {
    if (!httpServer) {
      isRunning = false;
      resolve();
      return;
    }

    if (wss) {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Ignore termination errors during shutdown
        }
      }
      wss.close();
      wss = null;
    }

    httpServer.close(() => {
      httpServer = null;
      isRunning = false;
      log('Remote control server stopped', 'remoteControl', 'log');
      resolve();
    });
  });

export const startRemoteControlServer = (
  options?: RemoteControlStartOptions,
): Promise<RemoteControlStatus> =>
  new Promise((resolve) => {
    if (
      options?.port !== undefined &&
      !isValidRemoteControlPort(options.port)
    ) {
      resolve({
        clientCount: 0,
        error: 'invalid-port',
        pin: serverPin,
        port: typeof options.port === 'number' ? options.port : 0,
        requirePin: serverRequirePin,
        running: false,
        urls: [],
      });
      return;
    }

    const targetPort = options?.port ?? DEFAULT_PORT;
    serverPort = targetPort;
    serverRequirePin = options?.requirePin !== false;
    serverPin =
      options?.pin && options.pin.length >= 4
        ? options.pin
        : serverPin || generateRemoteControlPin();

    if (httpServer) {
      void stopRemoteControlServer().then(() => {
        void startRemoteControlServer(options).then(resolve);
      });
      return;
    }

    const server = createServer((req, res) => {
      try {
        handleHttpRequest(req, res);
      } catch (err) {
        captureElectronError(err, {
          contexts: { fn: { name: 'remoteControlHttp' } },
        });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      log(
        'Remote control server failed to start',
        'remoteControl',
        'error',
        error,
      );
      httpServer = null;
      isRunning = false;
      resolve({
        clientCount: 0,
        error: error.code === 'EADDRINUSE' ? 'port-in-use' : error.message,
        pin: serverPin,
        port: targetPort,
        requirePin: serverRequirePin,
        running: false,
        urls: [],
      });
    });

    server.listen(targetPort, '0.0.0.0', () => {
      httpServer = server;
      isRunning = true;

      wss = new WebSocketServer({ server });

      wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        const reqUrl = new URL(
          req.url || '/',
          `http://${req.headers.host || 'localhost'}`,
        );
        const pinParam = reqUrl.searchParams.get('pin');

        if (!serverRequirePin || (pinParam && pinParam === serverPin)) {
          authenticatedClients.add(ws);
          ws.send(JSON.stringify({ type: 'auth_success' }));
          if (latestState) {
            ws.send(
              JSON.stringify({ data: latestState, type: 'state_change' }),
            );
          }
        } else {
          ws.send(JSON.stringify({ type: 'auth_required' }));
        }

        ws.on('message', (data: unknown) => {
          handleWsMessage(ws, data);
        });

        ws.on('error', (err) => {
          log('Remote control client error', 'remoteControl', 'warn', err);
        });
      });

      log('Remote control server listening', 'remoteControl', 'log', {
        port: targetPort,
      });
      resolve({
        clientCount: 0,
        pin: serverPin,
        port: targetPort,
        requirePin: serverRequirePin,
        running: true,
        urls: getRemoteControlUrls(targetPort),
      });
    });
  });

export const __testables = {
  reset: () => {
    latestState = null;
    actionHandler = null;
    isRunning = false;
  },
  validateAction,
};
