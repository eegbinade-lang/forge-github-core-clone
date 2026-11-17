// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP, speaking both the
// 2026-07-28 revision (server/discover, no handshake) and the legacy
// initialize handshake revisions. Tools act on the same store as REST.

import { issueJson, mergePull, pullJson, repoJson, type Reply } from './rest.ts';
import type { Store } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const strProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

// The tool list is a module-level constant so two tools/list answers are
// byte-identical by construction.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: obj(
      {
        name: strProp('The name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: obj(
      {
        owner: strProp('The owner of the repository.'),
        repo: strProp('The name of the repository.'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: obj(
      {
        owner: strProp('The owner of the repository.'),
        repo: strProp('The name of the repository.'),
        title: strProp('The title of the issue.'),
        body: strProp('The body of the issue.'),
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: obj(
      {
        owner: strProp('The owner of the repository.'),
        repo: strProp('The name of the repository.'),
        state: strProp('Filter by state: open, closed or all.'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request from a head branch into a base branch.',
    inputSchema: obj(
      {
        owner: strProp('The owner of the repository.'),
        repo: strProp('The name of the repository.'),
        title: strProp('The title of the pull request.'),
        body: strProp('The body of the pull request.'),
        head: strProp('The name of the branch to merge from.'),
        base: strProp('The name of the branch to merge into.'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: obj(
      {
        owner: strProp('The owner of the repository.'),
        repo: strProp('The name of the repository.'),
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Id = string | number | null;

const rpcResult = (id: Id, result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const rpcError = (status: number, id: Id, code: number, message: string): Reply => ({
  status,
  body: { jsonrpc: '2.0', id, error: { code, message } },
});

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (isRecord(value)) out.structuredContent = value;
  return out;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

type ToolOutcome = { kind: 'result'; value: Record<string, unknown> } | { kind: 'rpc'; code: number; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>, base: string): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { kind: 'rpc', code: -32602, message: `Unknown tool: ${name}` };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return { kind: 'rpc', code: -32602, message: `Missing required argument: ${key}` };
    }
  }
  const owner = argStr(args, 'owner') ?? store.viewerName();
  const repoName = argStr(args, 'repo');
  const repo = repoName === null ? null : store.repoFor(owner, repoName);

  switch (name) {
    case 'create_repo': {
      const repoTitle = argStr(args, 'name')!;
      if (store.repoByName(repoTitle) !== null) return { kind: 'result', value: toolError(`Repository ${repoTitle} already exists`) };
      const created = store.createRepo(
        repoTitle,
        args.private !== false,
        typeof args.description === 'string' ? args.description : null,
        'main',
      );
      if (created === null) return { kind: 'result', value: toolError(`Repository ${repoTitle} already exists`) };
      return { kind: 'result', value: toolResult(repoJson(store, created, base)) };
    }
    case 'get_repo': {
      if (repo === null) return { kind: 'result', value: toolError('Not Found') };
      return { kind: 'result', value: toolResult(repoJson(store, repo, base)) };
    }
    case 'create_issue': {
      if (repo === null) return { kind: 'result', value: toolError('Not Found') };
      const issue = store.addIssue(repo, argStr(args, 'title')!, typeof args.body === 'string' ? args.body : '', []);
      return { kind: 'result', value: toolResult(issueJson(store, repo, issue, base)) };
    }
    case 'list_issues': {
      if (repo === null) return { kind: 'result', value: toolError('Not Found') };
      const state = argStr(args, 'state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return { kind: 'result', value: toolResult(list.map((i) => issueJson(store, repo, i, base))) };
    }
    case 'create_pull_request': {
      if (repo === null) return { kind: 'result', value: toolError('Not Found') };
      const headRaw = argStr(args, 'head')!;
      const baseRaw = argStr(args, 'base')!;
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      if (store.branchTip(repo, head) === null || store.branchTip(repo, baseRef) === null) {
        return { kind: 'result', value: toolError('Validation Failed: head or base branch does not exist') };
      }
      const pull = store.addPull(repo, argStr(args, 'title')!, typeof args.body === 'string' ? args.body : '', head, baseRef);
      return { kind: 'result', value: toolResult(pullJson(store, repo, pull, base)) };
    }
    case 'merge_pull_request': {
      if (repo === null) return { kind: 'result', value: toolError('Not Found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return { kind: 'result', value: toolError('Not Found') };
      const ctx = { store, base, query: new URLSearchParams(), body: { merge_method: 'squash' } };
      const reply = mergePull(ctx, repo, pull);
      if (reply.status !== 200) {
        const message = isRecord(reply.body) && typeof reply.body.message === 'string' ? reply.body.message : 'Pull request is not mergeable';
        return { kind: 'result', value: toolError(message) };
      }
      return { kind: 'result', value: toolResult(pullJson(store, repo, pull, base)) };
    }
    default:
      return { kind: 'rpc', code: -32602, message: `Unknown tool: ${name}` };
  }
}

function dispatch(store: Store, request: Record<string, unknown>, base: string): Reply | null {
  const hasId = 'id' in request;
  const id: Id = hasId ? ((request.id as Id) ?? null) : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  // Notifications carry no id and are answered with silence (HTTP 202).
  if (!hasId) return null;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const out = callTool(store, toolName, args, base);
      if (out.kind === 'rpc') return rpcError(200, id, out.code, out.message);
      return rpcResult(id, out.value);
    }
    default:
      return rpcError(200, id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(store: Store, method: string, raw: Buffer, base: string): Reply {
  if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
    return { status: 405, body: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // Echo the request id when it is visible in the malformed text.
    const match = /"id"\s*:\s*(\d+|"[^"]*")/.exec(raw.toString('utf8'));
    let id: Id = null;
    if (match !== null) {
      try {
        id = JSON.parse(match[1]!) as Id;
      } catch {
        id = null;
      }
    }
    return rpcError(400, id, -32700, 'Parse error');
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        answers.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const reply = dispatch(store, entry, base);
      if (reply !== null) answers.push(reply.body);
    }
    if (answers.length === 0) return { status: 202, body: null };
    return { status: 200, body: answers };
  }
  if (!isRecord(parsed)) return rpcError(400, null, -32600, 'Invalid Request');
  const reply = dispatch(store, parsed, base);
  if (reply === null) return { status: 202, body: null };
  return reply;
}
