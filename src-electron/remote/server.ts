import type {
  RemoteControlAction,
  RemoteControlScope,
  RemoteControlSession,
  RemoteControlStartOptions,
  RemoteControlState,
  RemoteControlStatus,
} from 'src/types';

import {
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
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
const MAX_CLIENTS = 8;
const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KB
const MAX_COMMANDS_PER_SECOND = 15;
const DEDUPLICATION_WINDOW_MS = 5000;
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

let httpServer: null | Server = null;
let wss: null | WebSocketServer = null;
let serverPort = DEFAULT_PORT;
let serverScope: RemoteControlScope = 'partial';
let currentPairingCode = '';
let isRunning = false;
let latestState: null | RemoteControlState = null;
let actionHandler: ((action: RemoteControlAction) => void) | null = null;

const pairedSessions = new Map<string, RemoteControlSession>(); // token -> session
const socketSessions = new Map<WebSocket, RemoteControlSession>(); // ws -> session
const recentCommandTimestamps = new Map<string, number>(); // commandId -> timestamp

let activeControllerDeviceId: null | string = null;
let activeControllerName: null | string = null;

interface LockoutEntry {
  count: number;
  lockedUntil: number;
}
const failedAttempts = new Map<string, LockoutEntry>(); // ip -> entry

export const isValidRemoteControlPort = (port: unknown): port is number =>
  typeof port === 'number' &&
  Number.isInteger(port) &&
  port >= MIN_PORT &&
  port <= MAX_PORT;

export const generatePairingCode = (): string =>
  randomInt(100000, 1000000).toString();

export const generateSessionToken = (): string =>
  randomBytes(32).toString('hex');

const safeCompare = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const getClientIp = (req: IncomingMessage): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  }
  return req.socket.remoteAddress || '';
};

const isIpLockedOut = (ip: string): boolean => {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil > 0) failedAttempts.delete(ip);
  return false;
};

const recordFailedAttempt = (ip: string): boolean => {
  const now = Date.now();
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= LOCKOUT_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    failedAttempts.set(ip, entry);
    return true;
  }
  failedAttempts.set(ip, entry);
  return false;
};

const clearFailedAttempts = (ip: string) => {
  failedAttempts.delete(ip);
};

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
        if (address.address.startsWith('169.254.')) continue;
        ipList.push(address.address);
      }
    }
  } catch (error) {
    captureElectronError(error, {
      contexts: { fn: { name: 'getRemoteControlUrls' } },
    });
  }

  ipList.sort((a, b) => getIpPriority(a) - getIpPriority(b));
  return ipList.map((ip) => `http://${ip}:${port}/`);
};

const isTrustedOrigin = (
  originHeader: string | undefined,
  hostHeader: string | undefined,
): boolean => {
  if (!originHeader) return true;
  try {
    const originUrl = new URL(originHeader);
    if (
      hostHeader &&
      originUrl.host.toLowerCase() === hostHeader.toLowerCase()
    ) {
      return true;
    }
    const allowedIps = new Set(['127.0.0.1', 'localhost']);
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (!a.internal && a.family === 'IPv4') allowedIps.add(a.address);
      }
    }
    return allowedIps.has(originUrl.hostname);
  } catch {
    return false;
  }
};

export const setRemoteControlActionHandler = (
  handler: (action: RemoteControlAction) => void,
) => {
  actionHandler = handler;
};

let statusHandler: ((status: RemoteControlStatus) => void) | null = null;

export const setRemoteControlStatusHandler = (
  handler: ((status: RemoteControlStatus) => void) | null,
) => {
  statusHandler = handler;
};

const notifyStatusChange = () => {
  if (statusHandler) {
    statusHandler(getRemoteControlStatus());
  }
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

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws:; manifest-src 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

interface ThumbnailRegistryEntry {
  localPath?: string;
  streamUrl?: string;
}

const thumbnailRegistry = new Map<string, ThumbnailRegistryEntry>();

const handleHttpRequest = (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!isTrustedOrigin(origin, host)) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/api/status') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        activeControllerName: activeControllerName || null,
        clientCount: socketSessions.size,
        pairingRequired: true,
        running: isRunning,
        scope: serverScope,
      }),
    );
    return;
  }

  // Opaque thumbnail endpoint: strictly by ID and authenticated via session token
  if (pathname === '/api/thumbnail') {
    const token = reqUrl.searchParams.get('token') || '';
    const hasValidToken = Array.from(pairedSessions.keys()).some((t) =>
      safeCompare(t, token),
    );
    if (!hasValidToken) {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    const id = reqUrl.searchParams.get('id');
    const entry = id ? thumbnailRegistry.get(id) : undefined;
    if (!entry) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Thumbnail Not Found');
      return;
    }

    const localPath = entry.localPath;
    let targetImagePath: null | string = null;

    if (localPath) {
      let cleanPath = localPath.split('?')[0] || '';
      if (cleanPath.startsWith('file://')) {
        try {
          cleanPath = fileURLToPath(cleanPath);
        } catch {
          cleanPath = decodeURIComponent(
            cleanPath.replace(/^file:\/\/\/?/, ''),
          );
        }
      }

      // Path confinement: ensure local file exists
      if (
        /\.(jpe?g|png|webp|gif|svg)$/i.test(cleanPath) &&
        existsSync(cleanPath)
      ) {
        targetImagePath = cleanPath;
      } else {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
          const alt = cleanPath.replace(/\.[^.]+$/, ext);
          if (existsSync(alt)) {
            targetImagePath = alt;
            break;
          }
        }
      }
    }

    if (targetImagePath) {
      try {
        const ext = targetImagePath
          .slice(targetImagePath.lastIndexOf('.'))
          .toLowerCase();
        const contentType = MIME_TYPES[ext] || 'image/jpeg';
        const stat = statSync(targetImagePath);

        res.writeHead(200, {
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': stat.size,
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
        });

        const stream = createReadStream(targetImagePath);
        stream.on('error', (err) => {
          captureElectronError(err, {
            contexts: { fn: { name: 'handleHttpRequest.thumbnailStream' } },
          });
          if (!res.headersSent) {
            res.writeHead(500, {
              ...SECURITY_HEADERS,
              'Content-Type': 'text/plain',
            });
          }
          res.end();
        });
        stream.pipe(res);
        return;
      } catch (err) {
        captureElectronError(err, {
          contexts: { fn: { name: 'handleHttpRequest.thumbnail' } },
        });
        res.writeHead(500, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/plain',
        });
        res.end('Error reading thumbnail');
        return;
      }
    }

    // If local image does not exist, but we have an upstream streamUrl, redirect to it
    if (entry.streamUrl) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: entry.streamUrl,
      });
      res.end();
      return;
    }

    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Thumbnail Not Available');
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
        ...SECURITY_HEADERS,
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

  // Fallback to embedded assets
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(EMBEDDED_INDEX_HTML);
    return;
  }

  if (pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/manifest+json; charset=utf-8',
    });
    res.end(EMBEDDED_MANIFEST);
    return;
  }

  if (pathname === '/icon.svg') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'image/svg+xml; charset=utf-8',
    });
    res.end(EMBEDDED_ICON_SVG);
    return;
  }

  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
  res.end('Not Found');
};

const sendStateToSocket = (ws: WebSocket, state: RemoteControlState) => {
  const session = socketSessions.get(ws);
  const isController =
    session &&
    activeControllerDeviceId &&
    session.deviceId === activeControllerDeviceId;

  const payload = {
    ...state,
    activeControllerDeviceId: activeControllerDeviceId || undefined,
    activeControllerName: activeControllerName || undefined,
    controllerMode: isController ? 'controller' : 'viewer',
    scope: serverScope,
  };

  try {
    ws.send(JSON.stringify({ data: payload, type: 'state_change' }));
  } catch {
    // Ignore send errors on broken pipes
  }
};

const broadcastStateToAll = () => {
  if (!wss || !latestState) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && socketSessions.has(client)) {
      sendStateToSocket(client, latestState);
    }
  }
};

const handleWsMessage = (ws: WebSocket, rawData: unknown, clientIp: string) => {
  try {
    const text =
      typeof rawData === 'string' ? rawData : rawData?.toString() || '';
    const payload = JSON.parse(text) as Record<string, unknown>;

    // 1. One-time code pairing
    if (payload.type === 'pair') {
      if (isIpLockedOut(clientIp)) {
        ws.send(
          JSON.stringify({
            message: 'Too many failed attempts. Locked out for 5 minutes.',
            type: 'auth_error',
          }),
        );
        return;
      }

      const inputCode =
        typeof payload.code === 'string' ? payload.code.trim() : '';
      if (!currentPairingCode || !safeCompare(inputCode, currentPairingCode)) {
        const locked = recordFailedAttempt(clientIp);
        const msg = locked
          ? 'Too many failed attempts. Locked out for 5 minutes.'
          : 'Invalid pairing code.';
        ws.send(JSON.stringify({ message: msg, type: 'auth_error' }));
        return;
      }

      clearFailedAttempts(clientIp);
      const token = generateSessionToken();
      const deviceId = randomUUID();
      const deviceName =
        typeof payload.deviceName === 'string' && payload.deviceName.trim()
          ? payload.deviceName.trim().slice(0, 50)
          : 'Mobile Device';

      const session: RemoteControlSession = {
        createdAt: Date.now(),
        deviceId,
        deviceName,
        ip: clientIp,
        lastActive: Date.now(),
        token,
      };
      pairedSessions.set(token, session);
      socketSessions.set(ws, session);

      // If no active controller, assign this new device
      if (!activeControllerDeviceId) {
        activeControllerDeviceId = deviceId;
        activeControllerName = deviceName;
      }

      ws.send(
        JSON.stringify({
          activeControllerName,
          deviceId,
          token,
          type: 'auth_success',
        }),
      );

      if (latestState) {
        sendStateToSocket(ws, latestState);
      }
      broadcastStateToAll();
      notifyStatusChange();
      return;
    }

    // 2. Token authentication
    if (payload.type === 'auth') {
      const token =
        typeof payload.token === 'string' ? payload.token.trim() : '';
      let matchedSession: RemoteControlSession | undefined;
      for (const [sToken, s] of pairedSessions.entries()) {
        if (safeCompare(sToken, token)) {
          matchedSession = s;
          break;
        }
      }

      if (matchedSession) {
        matchedSession.lastActive = Date.now();
        socketSessions.set(ws, matchedSession);

        if (!activeControllerDeviceId) {
          activeControllerDeviceId = matchedSession.deviceId;
          activeControllerName = matchedSession.deviceName;
        }

        ws.send(
          JSON.stringify({
            activeControllerName,
            deviceId: matchedSession.deviceId,
            type: 'auth_success',
          }),
        );

        if (latestState) {
          sendStateToSocket(ws, latestState);
        }
        broadcastStateToAll();
        notifyStatusChange();
      } else {
        ws.send(
          JSON.stringify({
            message: 'Session revoked or expired. Please re-pair.',
            type: 'auth_error',
          }),
        );
      }
      return;
    }

    const currentSession = socketSessions.get(ws);
    if (!currentSession) {
      ws.send(
        JSON.stringify({
          message: 'Authentication required',
          type: 'auth_error',
        }),
      );
      return;
    }
    currentSession.lastActive = Date.now();

    // 3. Controller handoff
    if (payload.type === 'take_control') {
      activeControllerDeviceId = currentSession.deviceId;
      activeControllerName = currentSession.deviceName;
      broadcastStateToAll();
      notifyStatusChange();
      ws.send(
        JSON.stringify({
          id: payload.id,
          seq: payload.seq,
          success: true,
          type: 'ack',
        }),
      );
      return;
    }

    if (payload.type === 'relinquish_control') {
      if (activeControllerDeviceId === currentSession.deviceId) {
        activeControllerDeviceId = null;
        activeControllerName = null;
        broadcastStateToAll();
        notifyStatusChange();
      }
      ws.send(
        JSON.stringify({
          id: payload.id,
          seq: payload.seq,
          success: true,
          type: 'ack',
        }),
      );
      return;
    }

    // 4. Logout / Unpair from client
    if (payload.type === 'logout') {
      pairedSessions.delete(currentSession.token);
      socketSessions.delete(ws);
      if (activeControllerDeviceId === currentSession.deviceId) {
        const remaining = Array.from(socketSessions.values());
        if (remaining.length > 0) {
          const nextSession = remaining[0];
          activeControllerDeviceId = nextSession?.deviceId ?? null;
          activeControllerName = nextSession?.deviceName ?? null;
        } else {
          activeControllerDeviceId = null;
          activeControllerName = null;
        }
      }
      try {
        ws.send(
          JSON.stringify({
            message: 'Logged out successfully',
            type: 'auth_required',
          }),
        );
      } catch {
        // Ignore send errors on broken pipes
      }
      broadcastStateToAll();
      notifyStatusChange();
      return;
    }

    // 4. Action commands with Acks and Deduplication
    if (payload.type === 'action') {
      const actionCandidate = payload.action;
      const cmdId = typeof payload.id === 'string' ? payload.id : '';
      const seq = typeof payload.seq === 'number' ? payload.seq : 0;

      // Idempotency: return success ACK if recently executed
      const now = Date.now();
      if (cmdId && recentCommandTimestamps.has(cmdId)) {
        ws.send(JSON.stringify({ id: cmdId, seq, success: true, type: 'ack' }));
        return;
      }

      // Single-controller lock verification
      if (
        activeControllerDeviceId &&
        activeControllerDeviceId !== currentSession.deviceId
      ) {
        ws.send(
          JSON.stringify({
            error: `Controlled by ${activeControllerName || 'another device'}`,
            id: cmdId,
            seq,
            success: false,
            type: 'ack',
          }),
        );
        return;
      }

      const action = validateRemoteControlAction(actionCandidate);
      if (!action) {
        ws.send(
          JSON.stringify({
            error: 'Invalid action payload',
            id: cmdId,
            seq,
            success: false,
            type: 'ack',
          }),
        );
        return;
      }

      // Scope restriction
      if (serverScope === 'partial') {
        const allowedTypes = [
          'play',
          'pause',
          'stop',
          'seek',
          'next',
          'previous',
          'select_item',
          'refresh_playlist',
        ];
        if (!allowedTypes.includes(action.type)) {
          ws.send(
            JSON.stringify({
              error: 'Action not permitted under transport-only mode',
              id: cmdId,
              seq,
              success: false,
              type: 'ack',
            }),
          );
          return;
        }
      }

      if (cmdId) {
        recentCommandTimestamps.set(cmdId, now);
        // Clean up old entries
        for (const [id, ts] of recentCommandTimestamps.entries()) {
          if (now - ts > DEDUPLICATION_WINDOW_MS) {
            recentCommandTimestamps.delete(id);
          }
        }
      }

      if (actionHandler) {
        actionHandler(action);
      }

      ws.send(JSON.stringify({ id: cmdId, seq, success: true, type: 'ack' }));
    }
  } catch (error) {
    captureElectronError(error, {
      contexts: { fn: { name: 'handleWsMessage' } },
    });
  }
};

const validateRemoteControlAction = (
  action: unknown,
): null | RemoteControlAction => {
  if (!action || typeof action !== 'object') return null;
  const candidate = action as Record<string, unknown>;

  if (candidate.type === 'seek') {
    const pos = candidate.position;
    if (typeof pos === 'number' && Number.isFinite(pos) && pos >= 0) {
      return { position: pos, type: 'seek' };
    }
    return null;
  }

  if (candidate.type === 'select_item') {
    const uniqueId = candidate.uniqueId;
    if (typeof uniqueId === 'string' && uniqueId.trim().length > 0) {
      return {
        play: candidate.play === true,
        type: 'select_item',
        uniqueId: uniqueId.trim(),
      };
    }
    return null;
  }

  type SimpleActionType =
    | 'next'
    | 'pause'
    | 'play'
    | 'previous'
    | 'refresh_playlist'
    | 'relinquish_control'
    | 'stop'
    | 'stop_zoom_share'
    | 'take_control'
    | 'toggle_blackout';

  const validTypes: SimpleActionType[] = [
    'next',
    'pause',
    'play',
    'previous',
    'refresh_playlist',
    'relinquish_control',
    'stop',
    'stop_zoom_share',
    'take_control',
    'toggle_blackout',
  ];

  if (validTypes.includes(candidate.type as SimpleActionType)) {
    return { type: candidate.type as SimpleActionType };
  }

  return null;
};

export const startRemoteControlServer = (
  options?: RemoteControlStartOptions,
): Promise<RemoteControlStatus> => {
  const port = options?.port ?? serverPort;
  if (!isValidRemoteControlPort(port)) {
    return Promise.resolve({
      error: 'invalid-port',
      pairedSessions: [],
      pairingCode: currentPairingCode,
      port,
      running: false,
      scope: serverScope,
      urls: [],
    });
  }

  const previousScope = serverScope;
  serverPort = port;
  serverScope = options?.scope ?? serverScope;
  if (!currentPairingCode) {
    currentPairingCode = generatePairingCode();
  }

  if (httpServer && isRunning && serverPort === port) {
    if (serverScope !== previousScope) {
      broadcastStateToAll();
      notifyStatusChange();
    }
    return Promise.resolve(getRemoteControlStatus());
  }

  return new Promise((resolve) => {
    stopRemoteControlServer().then(() => {
      httpServer = createServer((req, res) => {
        try {
          handleHttpRequest(req, res);
        } catch (error) {
          captureElectronError(error, {
            contexts: { fn: { name: 'handleHttpRequest' } },
          });
          if (!res.headersSent) {
            res.writeHead(500, {
              ...SECURITY_HEADERS,
              'Content-Type': 'text/plain',
            });
            res.end('Internal Server Error');
          }
        }
      });

      wss = new WebSocketServer({
        maxPayload: MAX_PAYLOAD_BYTES,
        noServer: true,
      });

      httpServer.on('upgrade', (req, socket, head) => {
        const host = req.headers.host;
        const origin = req.headers.origin;
        if (!isTrustedOrigin(origin, host)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        if (wss && wss.clients.size >= MAX_CLIENTS) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }

        const clientIp = getClientIp(req);
        if (isIpLockedOut(clientIp)) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }

        wss?.handleUpgrade(req, socket, head, (ws) => {
          wss?.emit('connection', ws, req);
        });
      });

      wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        const clientIp = getClientIp(req);
        let messageCount = 0;
        const rateLimitTimer = setInterval(() => {
          messageCount = 0;
        }, 1000);

        ws.on('message', (rawData) => {
          messageCount++;
          if (messageCount > MAX_COMMANDS_PER_SECOND) {
            ws.send(
              JSON.stringify({
                message: 'Rate limit exceeded',
                type: 'auth_error',
              }),
            );
            return;
          }
          handleWsMessage(ws, rawData, clientIp);
        });

        ws.on('close', () => {
          clearInterval(rateLimitTimer);
          const session = socketSessions.get(ws);
          socketSessions.delete(ws);
          if (
            session &&
            activeControllerDeviceId &&
            session.deviceId === activeControllerDeviceId
          ) {
            const remaining = Array.from(socketSessions.values());
            if (remaining.length > 0) {
              const nextSession = remaining[0];
              activeControllerDeviceId = nextSession?.deviceId ?? null;
              activeControllerName = nextSession?.deviceName ?? null;
            } else {
              activeControllerDeviceId = null;
              activeControllerName = null;
            }
            broadcastStateToAll();
          }
          notifyStatusChange();
        });

        ws.on('error', (err) => {
          captureElectronError(err, {
            contexts: { fn: { name: 'wss.clientError' } },
          });
        });

        // Prompt client for pairing or token
        ws.send(JSON.stringify({ type: 'auth_required' }));
      });

      httpServer.once('error', (err: NodeJS.ErrnoException) => {
        isRunning = false;
        httpServer = null;
        wss = null;
        log(
          `Remote control server error: ${err.message}`,
          'remoteControl',
          'error',
        );
        resolve({
          error: err.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed',
          pairedSessions: [],
          pairingCode: currentPairingCode,
          port: serverPort,
          running: false,
          scope: serverScope,
          urls: [],
        });
      });

      httpServer.listen(serverPort, '0.0.0.0', () => {
        isRunning = true;
        log(
          `Remote control server listening on port ${serverPort}`,
          'remoteControl',
          'info',
        );
        resolve(getRemoteControlStatus());
      });
    });
  });
};

export const broadcastRemoteControlState = (state: RemoteControlState) => {
  latestState = state;

  if (state.uniqueId && (state.thumbnailPath || state.thumbnailStreamUrl)) {
    thumbnailRegistry.set(state.uniqueId, {
      localPath: state.thumbnailPath,
      streamUrl: state.thumbnailStreamUrl,
    });
  }
  for (const item of state.playlist ?? []) {
    if (item.uniqueId && (item.thumbnailPath || item.thumbnailStreamUrl)) {
      thumbnailRegistry.set(item.uniqueId, {
        localPath: item.thumbnailPath,
        streamUrl: item.thumbnailStreamUrl,
      });
    }
  }

  broadcastStateToAll();
};

export const getRemoteControlStatus = (): RemoteControlStatus => {
  const sessions = Array.from(pairedSessions.values()).map((s) => ({
    createdAt: s.createdAt,
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    ip: s.ip,
    lastActive: s.lastActive,
  }));

  return {
    activeControllerDeviceId: activeControllerDeviceId || '',
    activeControllerName: activeControllerName || '',
    clientCount: socketSessions.size,
    pairedSessions: sessions,
    pairingCode: currentPairingCode,
    port: serverPort,
    running: isRunning,
    scope: serverScope,
    urls: isRunning ? getRemoteControlUrls(serverPort) : [],
  };
};

export const revokeActiveController = (): void => {
  if (activeControllerDeviceId) {
    revokeSession(activeControllerDeviceId);
  }
};

export const regeneratePairingCode = (customCode?: string): string => {
  if (customCode && /^\d{4,8}$/.test(customCode.trim())) {
    currentPairingCode = customCode.trim();
  } else {
    currentPairingCode = generatePairingCode();
  }
  notifyStatusChange();
  return currentPairingCode;
};

export const revokeSession = (deviceId: string): void => {
  for (const [token, session] of pairedSessions.entries()) {
    if (session.deviceId === deviceId) {
      pairedSessions.delete(token);
      break;
    }
  }

  for (const [ws, session] of socketSessions.entries()) {
    if (session.deviceId === deviceId) {
      try {
        ws.send(
          JSON.stringify({
            message: 'Session has been revoked.',
            type: 'auth_error',
          }),
        );
        ws.close();
      } catch {
        // Ignore
      }
      socketSessions.delete(ws);
    }
  }

  if (activeControllerDeviceId === deviceId) {
    const remaining = Array.from(socketSessions.values());
    if (remaining.length > 0) {
      const nextSession = remaining[0];
      activeControllerDeviceId = nextSession?.deviceId ?? null;
      activeControllerName = nextSession?.deviceName ?? null;
    } else {
      activeControllerDeviceId = null;
      activeControllerName = null;
    }
    broadcastStateToAll();
  }
  notifyStatusChange();
};

export const revokeAllSessions = (): void => {
  for (const ws of socketSessions.keys()) {
    try {
      ws.send(
        JSON.stringify({
          message: 'All sessions have been revoked.',
          type: 'auth_error',
        }),
      );
      ws.close();
    } catch {
      // Ignore
    }
  }
  pairedSessions.clear();
  socketSessions.clear();
  activeControllerDeviceId = null;
  activeControllerName = null;
  currentPairingCode = generatePairingCode();
  broadcastStateToAll();
  notifyStatusChange();
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
          // Ignore
        }
      }
      wss.close();
      wss = null;
    }

    httpServer.close(() => {
      httpServer = null;
      isRunning = false;
      pairedSessions.clear();
      socketSessions.clear();
      activeControllerDeviceId = null;
      activeControllerName = null;
      thumbnailRegistry.clear();
      log('Remote control server stopped', 'remoteControl', 'info');
      resolve();
    });
  });

export const _testExports = {
  clearFailedAttempts,
  isIpLockedOut,
  isTrustedOrigin,
  pairedSessions,
  recordFailedAttempt,
  safeCompare,
  setRemoteControlStatusHandler,
  socketSessions,
  thumbnailRegistry,
};
