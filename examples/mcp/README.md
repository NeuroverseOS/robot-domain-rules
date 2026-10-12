# MCP example: `may_i`

A stdio [MCP](https://modelcontextprotocol.io) server that lets an agent ask a rulebook before it acts. The MCP SDK is a dependency of this example only; the core package stays zero-dependency.

```bash
cd examples/mcp
npm install
npm start -- ../../example-grocery-01.rules.json     # from `npm run demo -- --json` at the repo root, or a switchboard export
```

Client config (Claude Desktop, Claude Code, Cursor, or any MCP client):

```json
{ "mcpServers": { "robot-domain-rules": { "command": "npx", "args": ["tsx", "/path/to/examples/mcp/server.ts", "/path/to/site.rules.json"] } } }
```

Two tools:

- **`may_i`** `{ participant: { id, kind, roleId }, action, areaId, facts }` → the decision, exactly as `evaluateDomainAction` returns it. The agent reads `status`; on `PAUSE` it reads `approvalRequests` and asks a person; on `LIMIT` it reads `limits`.
- **`explain_rulebook`** → the rulebook as text, with the rules at odds.

The server validates the rulebook on start and never changes it. It adds nothing to a decision.
