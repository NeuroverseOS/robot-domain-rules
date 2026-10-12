#!/usr/bin/env npx tsx
/**
 * Example MCP server: lets any MCP client (an agent harness, a coding agent)
 * ask a rulebook "may I?" and read it back in plain words.
 *
 *   cd examples/mcp && npm install && npm start -- ../../my-site.rules.json
 *
 * Tools:
 *   may_i            { request }  → the decision (ALLOW | LIMIT | PAUSE | BLOCK, reasons, limits, approvalRequests, trace, fingerprint)
 *   explain_rulebook {}           → the rulebook rendered as text, plus its findings
 *
 * The rulebook is a compiled JSON file (`npm run demo -- --json` writes one;
 * the switchboard exports one). It is loaded once, validated, and never
 * changed by this server. The server adds nothing to the decision: the tool
 * result is exactly what evaluateDomainAction returns.
 */

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { evaluateDomainAction, renderDomainRules, validateRulebook, type DomainRequest, type Rulebook } from '@neuroverseos/robot-domain-rules';

const path = process.argv[2];
if (!path) { console.error('usage: server.ts <rulebook.json>'); process.exit(2); }
const rulebook = JSON.parse(readFileSync(path, 'utf8')) as Rulebook;
const problems = validateRulebook(rulebook);
if (problems.length) { console.error(`Refusing to serve ${path}:\n- ${problems.join('\n- ')}`); process.exit(1); }

const server = new McpServer({ name: 'robot-domain-rules', version: '0.4.0' });

server.tool(
  'may_i',
  `Ask the rulebook for ${rulebook.site.name} (fingerprint ${rulebook.fingerprint}) whether a participant may do an action in an area, given the facts. Returns the decision with every rule and authority behind it. A PAUSE for approval carries approvalRequests to get signed.`,
  {
    participant: z.object({ id: z.string(), kind: z.string(), roleId: z.string() }),
    action: z.string(),
    areaId: z.string().describe('The area the participant is in, as the spatial system reports it'),
    facts: z.record(z.unknown()).describe(`Declared facts: ${rulebook.facts.map(f => `${f.id} (${f.type}${f.required ? ', required' : ''})`).join(', ')}; plus approvedBy`),
  },
  async (request) => {
    const decision = evaluateDomainAction(rulebook, request as DomainRequest);
    return { content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }] };
  },
);

server.tool(
  'explain_rulebook',
  `The rulebook for ${rulebook.site.name}, rendered in plain words: authorities, areas, roles, actions, facts, limits, never rules, every rule with who set it, and the rules at odds.`,
  {},
  async () => ({ content: [{ type: 'text', text: renderDomainRules(rulebook) }] }),
);

await server.connect(new StdioServerTransport());
console.error(`robot-domain-rules MCP server: ${rulebook.site.name} (${rulebook.rules.length} rules, ${rulebook.findings.length} findings)`);
