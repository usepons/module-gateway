# @pons/module-gateway

HTTP REST + WebSocket gateway module for the [Pons](https://github.com/usepons) platform.

## Overview

The gateway module provides a single HTTP server that exposes the Pons platform over REST and WebSocket:

- **Built-in REST routes** — health checks, module/service introspection, chat endpoint
- **Dynamic route registration** — other modules register their own HTTP routes via the `registerRoutes` RPC call
- **WebSocket transport** — real-time bidirectional messaging with channel subscriptions
- **Auth middleware** — optional Bearer token authentication for API and WebSocket connections
- **Outbound routing** — forwards bus messages to subscribed WebSocket clients

Built with [Hono](https://hono.dev/) on Deno's native HTTP server.

## Prerequisites

- [Deno](https://deno.com/) v2.0+

## Installation

```bash
deno install
```

## Usage

### As a Pons module (kernel-managed)

The gateway starts automatically when the kernel spawns it. Configure via the workspace config:

```yaml
gateway:
  httpPort: 18790
  host: 0.0.0.0
  auth:
    enabled: true
    tokens:
      - "your-secret-token"
```

### Standalone

```bash
deno run -A runner.ts
```

## API

### Built-in Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check + registered routes |
| GET | `/api/auth/status` | Auth configuration status |
| GET | `/api/modules` | List kernel modules |
| GET | `/api/services` | List registered services |
| GET | `/api/commands` | List available commands |
| POST | `/api/chat` | Direct LLM chat (RPC to model-router) |
| POST | `/api/message` | Publish inbound message to bus |

### WebSocket

Connect to `ws://host:port?token=<token>` and send JSON messages:

- `{ type: "subscribe", channelId }` — subscribe to a channel
- `{ type: "message", channelId, senderId, content }` — send a message
- `{ type: "interaction:resolve", id, decision }` — resolve an interaction request
- `{ type: "run:cancel", channelId }` — cancel active run

### Dynamic Route Registration (RPC)

Other Pons modules register HTTP routes at runtime via the `registerRoutes` RPC:

```typescript
await this.request('http-router', 'registerRoutes', {
  service: 'myService',
  prefix: '/api/my-service',
  middleware: ['auth'],
  routes: [
    { method: 'GET', path: '/', handler: 'list' },
    { method: 'POST', path: '/', handler: 'create' },
  ],
});
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
