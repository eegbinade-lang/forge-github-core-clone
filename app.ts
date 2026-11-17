// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP on
// one in-memory store. main.ts owns the entry <-> env lifecycle; this file
// is the surface the suite drives.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleRest, sendReply, type Reply } from './lib/rest.ts';
import { handleGitHttp } from './lib/git-http.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `F${requestSeq.toString(16).toUpperCase().padStart(7, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void serve(store, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': nextRequestId() });
      else res.end();
    });
  });
}

async function serve(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}`;
  const apiHeaders = { 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo, read:org' };

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
    return;
  }

  const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!isApi && gitMatch === null) {
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    return;
  }
  if (!authorized(req)) {
    if (gitMatch !== null) {
      res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId, 'www-authenticate': 'Bearer' });
      res.end(`${JSON.stringify({ message: 'Bad credentials' })}\n`);
      return;
    }
    sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders);
    return;
  }

  if (gitMatch !== null) {
    const body = await readBody(req);
    await handleGitHttp(store, req, res, {
      owner: decodeURIComponent(gitMatch[1]!),
      repo: decodeURIComponent(gitMatch[2]!),
      tail: gitMatch[3] ?? '',
      query: url.searchParams,
      body,
      requestId,
    });
    return;
  }

  // GraphQL and MCP parse their own bodies (batches, JSON-RPC errors).
  if (path === '/mcp' || path === '/api/graphql') {
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    if (path === '/mcp') {
      const reply = handleMcp(store, method, raw, base);
      sendReply(res, reply, { 'x-github-request-id': requestId });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
      return;
    }
    const reply = handleGraphql(store, raw, base);
    sendReply(res, reply, { 'x-github-request-id': requestId });
    return;
  }

  // JSON surfaces: read and parse the body once; malformed JSON is a 400.
  let body: Record<string, unknown> | null = null;
  let raw = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (Array.isArray(parsed)) body = { items: parsed };
        else if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
        else body = { value: parsed };
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
        return;
      }
    }
  }

  const segments = path
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const reply: Reply = handleRest({ store, base, query: url.searchParams, body }, method, segments);
  sendReply(res, reply, apiHeaders);
}
