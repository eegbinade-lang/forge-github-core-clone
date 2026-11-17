# forge — a GitHub-compatible forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/eegbinade-lang/forge-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/eegbinade-lang/forge-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible forge built for make.fun's github-core-clone-01
bounty. One Node 22 process, standard library only, no dependencies: an
in-memory store backs four surfaces at once —

- **Git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch with shallow
  support) and receive-pack v0, with a full SHA-1 object store, pack
  read/write with delta resolution, and fast-forward enforcement.
- **REST API v3** — repositories, contents, branches, refs, labels, issues,
  comments and pull requests with squash merges, in GitHub's shapes.
- **GraphQL API v4** — the documents `gh` and github-mcp-server send:
  viewer, repository, issue/pull-request connections with cursor pagination,
  mutations, `node(id:)` and the introspection the clients probe.
- **MCP** — JSON-RPC 2.0 at `/mcp`, speaking both the 2026-07-28
  `server/discover` revision and the legacy `initialize` handshake, with six
  tools acting on the same store as REST.

State is deterministic (a logical clock, stable ids), so a replayed trial
exports byte-identical state.

## Run it

The grader drives the lifecycle in `main.ts`: the process binds an ephemeral
port, registers it with `$MAKEFUN_ENV_URL/register`, serves until
`$MAKEFUN_ENV_URL/done` answers true, and exits 0.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> npm start
```

For local poking, `app.ts` exports `createApp()` returning a plain
`node:http` server for the same surfaces.
