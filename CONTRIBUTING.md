# Contributing to @pons/module-gateway

Thanks for your interest in contributing!

## Prerequisites

- [Deno](https://deno.com/) v2.0+

## Development Setup

```bash
git clone https://github.com/usepons/module-gateway.git
cd module-gateway
deno install
```

## Running Locally

```bash
# Run the gateway module
deno run -A runner.ts
```

For full integration testing, run the gateway alongside the kernel and other modules (LLM, agent) so that dynamic route registration and WebSocket messaging work end to end.

## Code Style

- Pure Deno — no npm build tools
- Explicit import specifiers: `jsr:@pons/sdk@^0.2`, `npm:hono@^4`
- No bare imports
- Run `deno fmt` before committing
- Run `deno lint` to catch issues

## Submitting Changes

1. Fork the repository
2. Create a branch from `main` (`feat/sse-support`, `fix/ws-reconnect`)
3. Make focused, atomic commits
4. Test locally — verify REST endpoints and WebSocket connections
5. Open a pull request against `main`

## Reporting Issues

Open an issue at [github.com/usepons/module-gateway/issues](https://github.com/usepons/module-gateway/issues).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
