/**
 * Gateway Module — HTTP REST + WebSocket gateway.
 *
 * Single Hono server on one port:
 *   - Built-in REST routes: health, modules, services, chat
 *   - Dynamic route registration via `registerRoutes` RPC (used by LLM and other modules)
 *   - WebSocket transport: subscribe to channels, send/receive messages
 *   - Outbound routing: bus messages → WS clients
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ModuleRunner } from 'jsr:@pons/sdk@^0.2';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.2';
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
    const host = (gw.host as string) ?? '0.0.0.0';

    // Auth
    const auth = (gw.auth ?? {}) as Record<string, unknown>;
    this.authEnabled = (auth.enabled as boolean) ?? false;
    this.authTokens = (auth.tokens as string[]) ?? [];

    // Hono app
    this.app = new Hono();
    this.app.onError((err, c) => {
      this.log('error', `HTTP ${c.req.method} ${c.req.path} failed`, { error: String(err) });
      return c.json({ error: String(err) }, 500);
    });
    this.app.use('*', cors());

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

  private authenticate(c: Context): boolean {
    if (!this.authEnabled) return true;
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    return !!token && this.authTokens.includes(token);
  }

  private authenticateWs(req: Request): boolean {
    if (!this.authEnabled) return true;
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (token && this.authTokens.includes(token)) return true;
    const header = req.headers.get('authorization');
    if (header?.startsWith('Bearer ')) {
      return this.authTokens.includes(header.slice(7));
    }
    return false;
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
      this.publish('inbound:message', {
        id: randomUUID(),
        channelType: 'http',
        channelId: body.channelId ?? 'default',
        senderId: body.senderId ?? 'http-user',
        senderName: body.senderName ?? 'HTTP User',
        content: body.content,
        timestamp: new Date().toISOString(),
        metadata: body.metadata ?? {},
      });
      return c.json({ status: 'accepted' }, 202);
    });
  }

  // ─── WebSocket ─────────────────────────────────────────────

  private handleWsUpgrade(req: Request): Response {
    if (!this.authenticateWs(req)) {
      return new Response('Unauthorized', { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    this.onWsConnection(socket);
    return response;
  }

  private onWsConnection(ws: WebSocket): void {
    const clientId = randomUUID();

    ws.onopen = () => {
      this.wsClients.add(ws);
      this.log('debug', 'WS client connected', { clientId, total: this.wsClients.size });
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as WsClientMessage;
        this.handleWsMessage(ws, clientId, msg);
      } catch (err) {
        this.log('warn', 'WS parse error', { clientId, error: String(err) });
      }
    };

    ws.onclose = () => {
      this.wsClients.delete(ws);
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
      case 'subscribe':
        if (!this.wsChannels.has(msg.channelId)) {
          this.wsChannels.set(msg.channelId, new Set());
        }
        this.wsChannels.get(msg.channelId)!.add(ws);
        this.log('debug', 'WS subscribed', { clientId, channelId: msg.channelId });
        break;

      case 'unsubscribe':
        this.wsChannels.get(msg.channelId)?.delete(ws);
        break;

      case 'message':
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

  private handleRegisterRoutes(reg: HttpRouteRegistration): { ok: true; registered: number } {
    const { service, prefix, middleware = [], routes } = reg;
    if (!service || !prefix || !routes?.length) {
      throw new Error('registerRoutes requires service, prefix, and routes');
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
        this.publish(route.topic!, body);
        return c.json({ status: 'accepted' }, 202);
      }

      // json type — RPC to service
      const ctx = await this.buildRequestContext(c);
      try {
        const result = await this.request<Record<string, unknown>>(service, `http:${route.handler}`, ctx);
        const status = (result?.status as number) ?? 200;
        const headers = (result?.headers as Record<string, string>) ?? {};
        for (const [key, value] of Object.entries(headers)) {
          c.header(key, value);
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

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => { headers[key] = value; });

    return { params, query, body, headers };
  }

  private handleRpcError(c: Context, err: unknown, service: string, method: string): Response {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('unavailable')) {
      return c.json({ error: `Service unavailable: ${service}` }, 503);
    }
    if (msg.includes('timed out')) {
      return c.json({ error: `Service timeout: ${service}.${method}` }, 504);
    }
    return c.json({ error: msg }, 500);
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
