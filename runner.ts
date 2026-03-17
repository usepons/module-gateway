/**
 * Gateway Module — HTTP REST + WebSocket gateway.
 *
 * Single Hono server on one port:
 *   - Built-in REST routes: health, modules, services, chat
 *   - Dynamic route registration via `registerRoutes` RPC (used by LLM and other modules)
 *   - WebSocket transport: subscribe to channels, send/receive messages
 *   - Outbound routing: bus messages → WS clients
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ModuleRunner } from 'jsr:@pons/sdk@^0.3';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.3';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// ─── Types for dynamic route registration ───────────────────

interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler?: string;
  type?: 'json' | 'publish';
  topic?: string;
  middleware?: string[];
}

interface HttpRouteRegistration {
  service: string;
  prefix: string;
  middleware?: string[];
  routes: HttpRouteDefinition[];
}

interface RegisteredRouteGroup {
  service: string;
  prefix: string;
  middleware: string[];
  routes: HttpRouteDefinition[];
}

// ─── WS client message types ────────────────────────────────

type WsClientMessage =
  | { type: 'subscribe'; channelId: string }
  | { type: 'unsubscribe'; channelId: string }
  | { type: 'message'; channelId: string; senderId: string; senderName?: string; content: string; agentId?: string; sessionId?: string; metadata?: Record<string, unknown> }
  | { type: 'interaction:resolve'; id: string; decision: 'approved' | 'denied' | 'answered' | 'skipped'; selectedOptions?: string[]; freeText?: string }
  | { type: 'run:cancel'; channelId: string; sessionId?: string };

// ─── Gateway Module ─────────────────────────────────────────

class GatewayModule extends ModuleRunner {
  readonly manifest: ModuleManifest = {
    id: 'gateway',
    name: 'Gateway',
    version: '0.1.0',
    subscribes: ['outbound:ws'],
    provides: ['http-router'],
  };

  private app!: Hono;
  private server!: Deno.HttpServer;
  private authTokens: string[] = [];
  private authEnabled = false;

  /** Dynamic route groups registered by other modules via RPC */
  private routeGroups = new Map<string, RegisteredRouteGroup>();

  /** channelId → set of subscribed WebSocket clients */
  private wsChannels = new Map<string, Set<WebSocket>>();
  /** All connected WS clients */
  private wsClients = new Set<WebSocket>();

  // ─── Init ──────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    const config = this.config as Record<string, unknown> | null;
    const gw = (config?.gateway ?? {}) as Record<string, unknown>;
    const port = (gw.httpPort as number) ?? 18790;
    const host = (gw.host as string) ?? '127.0.0.1';

    // Auth — enabled by default unless explicitly disabled
    const auth = (gw.auth ?? {}) as Record<string, unknown>;
    this.authEnabled = (auth.enabled as boolean) !== false;
    this.authTokens = (auth.tokens as string[]) ?? [];

    // Security: warn if auth is enabled but no tokens configured
    if (this.authEnabled && this.authTokens.length === 0) {
      this.log('warn', 'Auth is enabled but no tokens configured — all authenticated requests will be rejected. Set gateway.auth.tokens in config.yaml or disable auth with gateway.auth.enabled: false');
    }

    // Hono app
    this.app = new Hono();
    this.app.onError((err, c) => {
      this.log('error', `HTTP ${c.req.method} ${c.req.path} failed`, { error: String(err) });
      return c.json({ error: 'Internal server error' }, 500);
    });
    // Security headers
    this.app.use('*', async (c, next) => {
      await next();
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      c.header('Referrer-Policy', 'no-referrer');
    });

    // CORS — restrict to localhost origins only
    this.app.use('*', cors({
      origin: (origin) => {
        if (!origin) return origin;
        try {
          const url = new URL(origin);
          if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
            return origin;
          }
        } catch { /* invalid origin */ }
        return '';
      },
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    }));

    // Auth middleware for /api/* (skip public routes)
    this.app.use('/api/*', async (c, next) => {
      if (c.req.path === '/api/health' || c.req.path === '/api/auth/status') return next();
      if (!this.authenticate(c)) return c.json({ error: 'Unauthorized' }, 401);
      return next();
    });

    this.registerBuiltinRoutes();

    // Single server — HTTP + WS upgrades
    this.server = Deno.serve({ port, hostname: host }, (req) => {
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return this.handleWsUpgrade(req);
      }
      return this.app.fetch(req);
    });

    this.log('info', `Gateway listening on ${host}:${port}`);
  }

  // ─── Auth ──────────────────────────────────────────────────

  /** Timing-safe token comparison to prevent timing attacks (including length leakage). */
  private tokenMatches(candidate: string): boolean {
    const candidateHash = createHash('sha256').update(candidate).digest();
    for (const storedToken of this.authTokens) {
      const storedHash = createHash('sha256').update(storedToken).digest();
      if (timingSafeEqual(candidateHash, storedHash)) {
        return true;
      }
    }
    return false;
  }

  private authenticate(c: Context): boolean {
    if (!this.authEnabled) return true;
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    return !!token && this.tokenMatches(token);
  }

  private authenticateWs(req: Request): boolean {
    if (!this.authEnabled) return true;
    // Token from Authorization header only (not from URL query string)
    const header = req.headers.get('authorization');
    if (header?.startsWith('Bearer ')) {
      return this.tokenMatches(header.slice(7));
    }
    return false;
  }

  /** Authenticate a WS client from their first message (token sent post-connect). */
  private authenticateWsMessage(token: string): boolean {
    if (!this.authEnabled) return true;
    return this.tokenMatches(token);
  }

  // ─── Built-in REST routes ──────────────────────────────────

  private registerBuiltinRoutes(): void {
    // Public
    this.app.get('/api/auth/status', (c) => {
      return c.json({ authEnabled: this.authEnabled });
    });

    this.app.get('/api/health', (c) => {
      const routes: Array<{ prefix: string; service: string; count: number }> = [];
      for (const [prefix, group] of this.routeGroups) {
        routes.push({ prefix, service: group.service, count: group.routes.length });
      }
      return c.json({ status: 'ok', uptime: performance.now() / 1000, routes });
    });

    // Kernel introspection
    this.app.get('/api/modules', async (c) => {
      return c.json(await this.call('module.list'));
    });

    this.app.get('/api/services', async (c) => {
      return c.json(await this.call('service.discover'));
    });

    this.app.get('/api/commands', async (c) => {
      const commands = await this.call('module.commands') as unknown[];
      return c.json({ commands: commands ?? [] });
    });

    // Chat — direct RPC to LLM module for demo
    this.app.post('/api/chat', async (c) => {
      const { message, provider, model } = await c.req.json<{
        message: string;
        provider?: string;
        model?: string;
      }>();

      if (!message) return c.json({ error: 'message is required' }, 400);

      try {
        const result = await this.request('model-router', 'generateText', {
          prompt: message,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        });
        return c.json(result);
      } catch (err) {
        return this.handleRpcError(c, err, 'model-router', 'generateText');
      }
    });

    // Generic inbound message — publish to bus
    this.app.post('/api/message', async (c) => {
      const body = await c.req.json();
      // Validate required content field
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return c.json({ error: 'content is required and must be a non-empty string' }, 400);
      }
      this.publish('inbound:message', {
        id: randomUUID(),
        channelType: 'http',
        channelId: typeof body.channelId === 'string' ? body.channelId : 'default',
        senderId: typeof body.senderId === 'string' ? body.senderId : 'http-user',
        senderName: typeof body.senderName === 'string' ? body.senderName : 'HTTP User',
        content: body.content,
        timestamp: new Date().toISOString(),
        metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata : {},
      });
      return c.json({ status: 'accepted' }, 202);
    });
  }

  // ─── WebSocket ─────────────────────────────────────────────

  private static readonly MAX_WS_CLIENTS = 1000;
  private static readonly MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
  private static readonly MAX_CHANNEL_ID_LENGTH = 256;
  private wsClientChannels = new Map<WebSocket, Set<string>>();

  private handleWsUpgrade(req: Request): Response {
    // Security: limit concurrent WebSocket connections
    if (this.wsClients.size >= GatewayModule.MAX_WS_CLIENTS) {
      return new Response('Too many connections', { status: 503 });
    }
    // Allow upgrade — auth can happen via Authorization header or first message
    const { socket, response } = Deno.upgradeWebSocket(req);
    // Pre-authenticate if Authorization header is present
    if (this.authenticateWs(req)) {
      socket.addEventListener('open', () => {
        this.wsAuthenticated.add(socket);
      });
    }
    this.onWsConnection(socket);
    return response;
  }

  /** Set of WS clients that have completed authentication */
  private wsAuthenticated = new WeakSet<WebSocket>();

  private onWsConnection(ws: WebSocket): void {
    const clientId = randomUUID();

    ws.onopen = () => {
      // If auth is disabled, mark as authenticated immediately
      if (!this.authEnabled) {
        this.wsAuthenticated.add(ws);
      }
      this.wsClients.add(ws);
      this.log('debug', 'WS client connected', { clientId, total: this.wsClients.size });
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
          this.log('warn', 'WS malformed message — missing type', { clientId });
          return;
        }

        // Handle auth message (must be first message if auth is enabled)
        if (msg.type === 'auth') {
          if (typeof msg.token === 'string' && this.authenticateWsMessage(msg.token)) {
            this.wsAuthenticated.add(ws);
            this.log('debug', 'WS client authenticated', { clientId });
          } else {
            this.log('warn', 'WS auth failed', { clientId });
            ws.close(4001, 'Authentication failed');
          }
          return;
        }

        // Reject unauthenticated messages
        if (!this.wsAuthenticated.has(ws)) {
          this.log('warn', 'WS message before auth — rejecting', { clientId, type: msg.type });
          ws.close(4001, 'Authentication required');
          return;
        }

        // Validate message type against known types
        const VALID_WS_TYPES = new Set(['subscribe', 'unsubscribe', 'message', 'interaction:resolve', 'run:cancel']);
        if (!VALID_WS_TYPES.has(msg.type)) {
          this.log('warn', 'WS unknown message type', { clientId, type: msg.type });
          return;
        }

        this.handleWsMessage(ws, clientId, msg as WsClientMessage);
      } catch (err) {
        this.log('warn', 'WS parse error', { clientId, error: String(err) });
      }
    };

    ws.onclose = () => {
      this.wsClients.delete(ws);
      this.wsClientChannels.delete(ws);
      for (const clients of this.wsChannels.values()) {
        clients.delete(ws);
      }
      this.log('debug', 'WS client disconnected', { clientId, total: this.wsClients.size });
    };

    ws.onerror = (evt) => {
      this.log('warn', 'WS error', { clientId, error: String(evt) });
    };
  }

  private handleWsMessage(ws: WebSocket, clientId: string, msg: WsClientMessage): void {
    switch (msg.type) {
      case 'subscribe': {
        if (typeof msg.channelId !== 'string' || !msg.channelId) return;
        if (msg.channelId.length > GatewayModule.MAX_CHANNEL_ID_LENGTH) return;
        // Security: limit subscriptions per client
        const clientSubs = this.wsClientChannels.get(ws) ?? new Set<string>();
        if (clientSubs.size >= GatewayModule.MAX_SUBSCRIPTIONS_PER_CLIENT) {
          this.log('warn', 'WS subscription limit reached', { clientId, limit: GatewayModule.MAX_SUBSCRIPTIONS_PER_CLIENT });
          return;
        }
        if (!this.wsChannels.has(msg.channelId)) {
          this.wsChannels.set(msg.channelId, new Set());
        }
        this.wsChannels.get(msg.channelId)!.add(ws);
        clientSubs.add(msg.channelId);
        this.wsClientChannels.set(ws, clientSubs);
        this.log('debug', 'WS subscribed', { clientId, channelId: msg.channelId });
        break;
      }

      case 'unsubscribe':
        if (typeof msg.channelId !== 'string' || !msg.channelId) return;
        this.wsChannels.get(msg.channelId)?.delete(ws);
        this.wsClientChannels.get(ws)?.delete(msg.channelId);
        break;

      case 'message':
        // Validate required fields
        if (typeof msg.channelId !== 'string' || !msg.channelId) return;
        if (typeof msg.senderId !== 'string' || !msg.senderId) return;
        if (typeof msg.content !== 'string') return;
        this.publish('inbound:message', {
          id: randomUUID(),
          channelType: 'ws',
          channelId: msg.channelId,
          senderId: msg.senderId,
          senderName: msg.senderName ?? msg.senderId,
          content: msg.content,
          timestamp: new Date().toISOString(),
          metadata: {
            ...(msg.metadata ?? {}),
            ...(msg.agentId ? { agentId: msg.agentId } : {}),
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
          },
        });
        break;

      case 'interaction:resolve':
        this.publish('interaction:resolved', {
          id: msg.id,
          response: {
            decision: msg.decision,
            ...(msg.selectedOptions ? { selectedOptions: msg.selectedOptions } : {}),
            ...(msg.freeText ? { freeText: msg.freeText } : {}),
          },
        });
        break;

      case 'run:cancel':
        this.publish('run:cancel', {
          channelId: msg.channelId,
          sessionId: msg.sessionId,
        });
        break;
    }
  }

  // ─── Outbound: bus → WS clients ───────────────────────────

  protected override async onMessage(topic: string, payload: unknown): Promise<void> {
    if (topic !== 'outbound:ws') return;

    const msg = payload as { channelId?: string; broadcast?: boolean; [key: string]: unknown };
    const data = JSON.stringify(msg);

    if (msg.broadcast) {
      for (const ws of this.wsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    } else if (msg.channelId) {
      const clients = this.wsChannels.get(msg.channelId);
      if (!clients?.size) return;
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    }
  }

  // ─── RPC: http-router service ─────────────────────────────

  protected override async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'registerRoutes':
        return this.handleRegisterRoutes(params as HttpRouteRegistration);
      case 'unregisterRoutes':
        return this.handleUnregisterRoutes(params as { prefix: string });
      case 'listRoutes':
        return this.handleListRoutes();
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private static readonly RESERVED_PREFIXES = ['/api/health', '/api/auth', '/api/modules', '/api/services', '/api/commands', '/api/chat', '/api/message'];

  private handleRegisterRoutes(reg: HttpRouteRegistration): { ok: true; registered: number } {
    const { service, prefix, middleware = [], routes } = reg;
    if (!service || !prefix || !routes?.length) {
      throw new Error('registerRoutes requires service, prefix, and routes');
    }
    // Security: validate prefix format and prevent shadowing built-in routes
    if (!prefix.startsWith('/') || prefix.includes('..') || prefix.includes('//')) {
      throw new Error(`Invalid route prefix format: "${prefix}"`);
    }
    // Block /api itself — all built-in routes live under /api/*
    const normalizedPrefix = prefix.replace(/\/+$/, '');
    if (normalizedPrefix === '/api') {
      throw new Error('Prefix "/api" is reserved');
    }
    // Check each route's full resolved path against reserved routes
    for (const route of routes) {
      const fullPath = normalizedPrefix + (route.path === '/' ? '' : route.path);
      const normalizedFull = fullPath.replace(/\/+$/, '');
      for (const reserved of GatewayModule.RESERVED_PREFIXES) {
        const normalizedReserved = reserved.replace(/\/+$/, '');
        if (
          normalizedFull === normalizedReserved ||
          normalizedFull.startsWith(normalizedReserved + '/') ||
          normalizedReserved.startsWith(normalizedFull + '/')
        ) {
          throw new Error(`Route "${fullPath}" conflicts with reserved route "${reserved}"`);
        }
      }
    }

    this.routeGroups.set(prefix, { service, prefix, middleware, routes });

    let registered = 0;
    for (const route of routes) {
      const fullPath = prefix + (route.path === '/' ? '' : route.path);
      const routeMw = route.middleware ?? middleware;
      const needsAuth = routeMw.includes('auth');
      const handler = this.createRouteHandler(service, route, needsAuth);
      const honoMethod = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
      this.app[honoMethod](fullPath, handler);
      this.log('debug', `Route registered: [${route.method}] ${fullPath} → ${service}:${route.handler}`);
      registered++;
    }

    this.log('info', `Registered ${registered} routes for ${service} at ${prefix}`);
    return { ok: true, registered };
  }

  private handleUnregisterRoutes(params: { prefix: string }): { ok: true } {
    this.routeGroups.delete(params.prefix);
    this.log('info', `Unregistered route group: ${params.prefix}`);
    return { ok: true };
  }

  private handleListRoutes(): { routes: Array<{ prefix: string; service: string; count: number }> } {
    const routes = [];
    for (const [prefix, group] of this.routeGroups) {
      routes.push({ prefix, service: group.service, count: group.routes.length });
    }
    return { routes };
  }

  // ─── Dynamic route handler factory ────────────────────────

  private createRouteHandler(
    service: string,
    route: HttpRouteDefinition,
    needsAuth: boolean,
  ): (c: Context) => Promise<Response> {
    const routeType = route.type ?? 'json';

    return async (c: Context) => {
      if (needsAuth && !this.authenticate(c)) return c.json({ error: 'Unauthorized' }, 401);

      if (routeType === 'publish') {
        const body = await c.req.json().catch(() => ({}));
        // Security: sanitize user input before publishing to internal bus
        // JSON round-trip strips __proto__/constructor keys; envelope identifies source
        const sanitized = JSON.parse(JSON.stringify(body));
        this.publish(route.topic!, {
          _source: 'http',
          _service: service,
          _timestamp: new Date().toISOString(),
          payload: sanitized,
        });
        return c.json({ status: 'accepted' }, 202);
      }

      // json type — RPC to service
      const ctx = await this.buildRequestContext(c);
      try {
        const result = await this.request<Record<string, unknown>>(service, `http:${route.handler}`, ctx);
        const status = (result?.status as number) ?? 200;
        // Security: only allow safe response headers from RPC responses
        const ALLOWED_RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'x-request-id', 'etag', 'last-modified']);
        const headers = (result?.headers as Record<string, string>) ?? {};
        for (const [key, value] of Object.entries(headers)) {
          if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
            c.header(key, value);
          }
        }
        return c.json(result?.body ?? result, status as ContentfulStatusCode);
      } catch (err) {
        return this.handleRpcError(c, err, service, route.handler ?? 'unknown');
      }
    };
  }

  private async buildRequestContext(c: Context): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {};
    if (c.req.param()) Object.assign(params, c.req.param());

    const url = new URL(c.req.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => { query[key] = value; });

    let body: unknown = null;
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try { body = await c.req.json(); } catch { /* empty */ }
    }

    // Security: strip sensitive headers before forwarding to downstream services
    const STRIP_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    });

    return { params, query, body, headers };
  }

  private handleRpcError(c: Context, err: unknown, service: string, method: string): Response {
    const msg = err instanceof Error ? err.message : String(err);
    this.log('error', `RPC error: ${service}.${method}`, { error: msg });
    if (msg.includes('not found') || msg.includes('unavailable')) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    if (msg.includes('timed out')) {
      return c.json({ error: 'Request timed out' }, 504);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }

  // ─── Shutdown ──────────────────────────────────────────────

  protected override async onShutdown(): Promise<void> {
    for (const ws of this.wsClients) {
      ws.close(1001, 'Server shutting down');
    }
    await this.server?.shutdown();
    this.log('info', 'Gateway stopped');
  }
}

new GatewayModule().start();
