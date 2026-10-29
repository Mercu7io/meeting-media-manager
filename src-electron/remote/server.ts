import type {
  RemoteControlAction,
  RemoteControlStartOptions,
  RemoteControlState,
  RemoteControlStatus,
} from 'src/types';

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
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
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
};

const thumbnailRegistry = new Map<string, string>();

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

  if (pathname === '/api/thumbnail') {
    const id = reqUrl.searchParams.get('id');
    const pathParam = reqUrl.searchParams.get('path');
    let localPath =
      (id ? thumbnailRegistry.get(id) : undefined) || pathParam || undefined;
    if (!localPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Thumbnail Not Found');
      return;
    }

    localPath = localPath.split('?')[0] || '';

    if (localPath.startsWith('file://')) {
      try {
        localPath = fileURLToPath(localPath);
      } catch {
        localPath = decodeURIComponent(localPath.replace(/^file:\/\/\/?/, ''));
      }
    }

    let targetImagePath: null | string = null;
    if (/\.(jpe?g|png|webp|gif|svg)$/i.test(localPath)) {
      if (existsSync(localPath)) {
        targetImagePath = localPath;
      }
    } else {
      const jpg = localPath.replace(/\.[^.]+$/, '.jpg');
      const jpeg = localPath.replace(/\.[^.]+$/, '.jpeg');
      const png = localPath.replace(/\.[^.]+$/, '.png');
      const webp = localPath.replace(/\.[^.]+$/, '.webp');
      if (existsSync(jpg)) {
        targetImagePath = jpg;
      } else if (existsSync(jpeg)) {
        targetImagePath = jpeg;
      } else if (existsSync(png)) {
        targetImagePath = png;
      } else if (existsSync(webp)) {
        targetImagePath = webp;
      }
    }

    if (!targetImagePath) {
      const isAud = /\.(mp3|m4a|aac|flac|wav)$/i.test(localPath);
      const icon = isAud
        ? '<path fill="#a371f7" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>'
        : '<path fill="#58a6ff" d="M8 5v14l11-7z"/>';
      const label = isAud ? 'AUDIO' : 'VIDEO';
      const badgeColor = isAud ? '#a371f7' : '#58a6ff';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161b22"/>
      <stop offset="100%" stop-color="#0d1117"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" rx="8" fill="url(#g)"/>
  <rect x="1" y="1" width="318" height="178" rx="7" fill="none" stroke="#30363d" stroke-width="1.5"/>
  <g transform="translate(136, 66)">
    <circle cx="24" cy="24" r="28" fill="#21262d" stroke="#30363d" stroke-width="1"/>
    <g transform="translate(12, 12)">${icon}</g>
  </g>
  <rect x="12" y="12" width="56" height="20" rx="4" fill="#21262d" stroke="#30363d"/>
  <text x="40" y="26" fill="${badgeColor}" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" text-anchor="middle" letter-spacing="0.5">${label}</text>
</svg>`;
      const buf = Buffer.from(svg, 'utf8');
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': buf.length,
        'Content-Type': 'image/svg+xml; charset=utf-8',
      });
      res.end(buf);
      return;
    }

    try {
      const ext = targetImagePath
        .slice(targetImagePath.lastIndexOf('.'))
        .toLowerCase();
      const contentType = MIME_TYPES[ext] || 'image/jpeg';
      const stat = statSync(targetImagePath);

      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': stat.size,
        'Content-Type': contentType,
      });

      const stream = createReadStream(targetImagePath);
      stream.on('error', (err) => {
        captureElectronError(err, {
          contexts: { fn: { name: 'handleHttpRequest.thumbnailStream' } },
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end();
      });
      stream.pipe(res);
      return;
    } catch (err) {
      captureElectronError(err, {
        contexts: { fn: { name: 'handleHttpRequest.thumbnail' } },
      });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading thumbnail');
      return;
    }
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
    type === 'stop_zoom_share' ||
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

  if (state.uniqueId && state.thumbnailPath) {
    thumbnailRegistry.set(state.uniqueId, state.thumbnailPath);
  }
  for (const item of state.playlist ?? []) {
    if (item.uniqueId && item.thumbnailPath) {
      thumbnailRegistry.set(item.uniqueId, item.thumbnailPath);
    }
  }

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
      thumbnailRegistry.clear();
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
    thumbnailRegistry.clear();
  },
  thumbnailRegistry,
  validateAction,
};
