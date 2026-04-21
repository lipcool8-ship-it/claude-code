# claude-code

A clean-room, MIT-licensed terminal AI agent harness.

See [DESIGN.md](./DESIGN.md) for the full architecture decision pack.

## Guiding principle

> **Every action must be inspectable, reversible, and policy-bounded.**

## Quick start

```bash
npm install
npm run build
npm start
```

## Development

```bash
npm test          # run unit + integration tests (52 tests)
npm run typecheck # type-check without emitting
npm run build     # compile TypeScript → dist/
```

## Slash commands

Available at the `You:` prompt during a chat session:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/remember <key> <value>` | Store a user-confirmed fact (survives sessions, outranks AI summaries) |
| `/forget <key>` | Clear a stored fact |
| `/status` | Show session ID, model, policy, turn count |
| `/exit` | End the session |

## Docs

- [DESIGN.md](./DESIGN.md) — architecture & design decisions
