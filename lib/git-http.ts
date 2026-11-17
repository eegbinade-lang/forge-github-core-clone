// Git smart HTTP, implemented from the protocol up: pkt-lines, packfiles
// (read with delta resolution, written as full objects), protocol v2
// ls-refs and fetch, v0 upload-pack, and v0 receive-pack with
// report-status in side-band-64k frames. No git binary exists in the pod;
// this is the whole server.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitStore, ObjectType } from './gitstore.ts';
import type { Repo, Store } from './store.ts';

export interface GitRequest {
  owner: string;
  repo: string;
  tail: string;
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
}

const ZERO = '0'.repeat(40);
const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---- pkt-lines ---------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet { kind: 'data' | 'flush' | 'delim'; payload: Buffer }

function parsePackets(buf: Buffer, offset = 0): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const lenText = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); at += 4; break; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); at += 4; continue; }
    if (len === 2) { at += 4; continue; } // response-end
    if (len < 4 || at + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { packets, rest: at };
}

// ---- packs -------------------------------------------------------------------

function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  // inflateSync tolerates trailing bytes but never reports how many it
  // read; a truncated stream always throws, so the shortest prefix that
  // inflates is the stream's exact length. Binary-search for it.
  const max = buf.length - offset;
  const attempt = (len: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, offset + len));
    } catch {
      return null;
    }
  };
  let lo = 1;
  let hi = max;
  let best: Buffer | null = null;
  let bestLen = max;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = attempt(mid);
    if (out !== null) { best = out; bestLen = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (best === null) throw new Error('corrupt zlib stream in pack');
  return { data: best, consumed: bestLen };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) copyOffset |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) copySize |= delta[at++]! << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op > 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry { type: ObjectType; data: Buffer }

/** Parse a pack into the store; returns the number of objects stored. */
export function unpackPack(git: GitStore, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  let at = 12;
  const pending: { baseOfs?: number; baseRef?: string; delta: Buffer; offset: number }[] = [];
  const byOffset = new Map<number, PackEntry>();
  let stored = 0;
  const storeEntry = (entry: PackEntry, offset: number): void => {
    git.put(entry.type, entry.data);
    byOffset.set(offset, entry);
    stored += 1;
  };
  for (let i = 0; i < count; i++) {
    const entryOffset = at;
    let byte = pack[at++]!;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      let b = pack[at++]!;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[at++]!;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const { data, consumed } = inflateAt(pack, at);
      at += consumed;
      pending.push({ baseOfs: entryOffset - baseOffset, delta: data, offset: entryOffset });
    } else if (typeId === 7) {
      const baseRef = pack.toString('hex', at, at + 20);
      at += 20;
      const { data, consumed } = inflateAt(pack, at);
      at += consumed;
      pending.push({ baseRef, delta: data, offset: entryOffset });
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const { data, consumed } = inflateAt(pack, at);
      at += consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      storeEntry({ type, data }, entryOffset);
    }
  }
  // Resolve deltas, possibly in chains.
  let guard = 0;
  while (pending.length > 0 && guard++ < 10000) {
    const item = pending.shift()!;
    let base: PackEntry | null = null;
    if (item.baseOfs !== undefined) base = byOffset.get(item.baseOfs) ?? null;
    else if (item.baseRef !== undefined) {
      const found = git.get(item.baseRef);
      base = found === null ? null : { type: found.type, data: found.data };
    }
    if (base === null) {
      pending.push(item);
      continue;
    }
    const data = applyDelta(base.data, item.delta);
    storeEntry({ type: base.type, data }, item.offset);
  }
  if (pending.length > 0) throw new Error('unresolvable delta in pack');
  return stored;
}

/** Build a pack of full (non-delta) objects. */
export function buildPack(git: GitStore, oids: Iterable<string>): Buffer {
  const unique = [...new Set(oids)].filter((oid) => git.has(oid));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(unique.length, 8);
  parts.push(head);
  for (const oid of unique) {
    const obj = git.get(oid)!;
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (TYPE_IDS[obj.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---- closures ------------------------------------------------------------------

function treeClosure(git: GitStore, treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  into.add(treeSha);
  for (const entry of git.readTree(treeSha)) {
    if (entry.mode === '40000') treeClosure(git, entry.sha, into);
    else into.add(entry.sha);
  }
}

function commitClosure(git: GitStore, tip: string, into: Set<string>, crossParents: boolean): void {
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (into.has(current)) continue;
    const obj = git.get(current);
    if (obj === null) continue;
    if (obj.type === 'tag') {
      into.add(current);
      const target = git.tagTarget(current);
      if (target !== null) queue.push(target);
      continue;
    }
    if (obj.type !== 'commit') { into.add(current); continue; }
    into.add(current);
    const commit = git.readCommit(current);
    if (commit === null) continue;
    treeClosure(git, commit.tree, into);
    if (crossParents) queue.push(...commit.parents);
  }
}

export function fullClosure(git: GitStore, roots: Iterable<string>): Set<string> {
  const into = new Set<string>();
  for (const root of roots) commitClosure(git, root, into, true);
  return into;
}

/** A shallow client's held set: the boundary commits with their trees, no parents. */
function shallowClosure(git: GitStore, roots: Iterable<string>): Set<string> {
  const into = new Set<string>();
  for (const root of roots) commitClosure(git, root, into, false);
  return into;
}

// ---- the handler -----------------------------------------------------------------

export async function handleGitHttp(store: Store, req: IncomingMessage, res: ServerResponse, gr: GitRequest): Promise<void> {
  const repo = store.repoFor(gr.owner, gr.repo);
  const send = (status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': gr.requestId });
    res.end(body);
  };
  const send404 = (): void => {
    send(404, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message: 'Not Found' })}\n`));
  };
  if (repo === null) { send404(); return; }

  const service = gr.query.get('service');
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const method = req.method ?? 'GET';

  if (method === 'GET' && gr.tail === '/info/refs') {
    if (service === 'git-upload-pack') {
      if (isV2) {
        const body = Buffer.concat([
          pktLine('version 2\n'),
          pktLine('agent=forge/1.0\n'),
          pktLine('ls-refs=unborn\n'),
          pktLine('fetch=shallow\n'),
          pktLine('object-format=sha1\n'),
          FLUSH,
        ]);
        send(200, 'application/x-git-upload-pack-advertisement', body);
      } else {
        send(200, 'application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, 'upload'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      send(200, 'application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, 'receive'));
      return;
    }
    send404();
    return;
  }

  if (method === 'POST' && gr.tail === '/git-upload-pack') {
    if (isV2) { handleV2(store, repo, gr.body, send); return; }
    handleV0Fetch(store, repo, gr.body, send);
    return;
  }
  if (method === 'POST' && gr.tail === '/git-receive-pack') {
    handleReceivePack(store, repo, gr.body, send);
    return;
  }
  send404();
}

type Send = (status: number, contentType: string, body: Buffer) => void;

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function v0Advertisement(store: Store, repo: Repo, kind: 'upload' | 'receive'): Buffer {
  const service = kind === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const caps = kind === 'upload'
    ? `multi_ack_detailed side-band-64k ofs-delta shallow agent=forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`
    : 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const headTip = store.branchTip(repo, repo.defaultBranch) ?? ZERO;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const lines: [string, string][] = [['HEAD', headTip], ...refs];
    for (const [name, oid] of lines) {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const peeled = store.git.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- protocol v2 -------------------------------------------------------------------

interface V2Request { command: string; args: string[] }

function parseV2Request(body: Buffer): V2Request | null {
  const { packets } = parsePackets(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { inArgs = true; continue; }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  return command === '' ? null : { command, args };
}

function handleV2(store: Store, repo: Repo, body: Buffer, send: Send): void {
  const request = parseV2Request(body);
  if (request === null) {
    send(400, 'application/x-git-upload-pack-result', pktLine('ERR invalid request\n'));
    return;
  }
  if (request.command === 'ls-refs') {
    send(200, 'application/x-git-upload-pack-result', lsRefsReply(store, repo, request.args));
    return;
  }
  if (request.command === 'fetch') {
    send(200, 'application/x-git-upload-pack-result', fetchReply(store, repo, request.args));
    return;
  }
  send(400, 'application/x-git-upload-pack-result', pktLine('ERR unknown command\n'));
}

function lsRefsReply(store: Store, repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = store.branchTip(repo, repo.defaultBranch);
  if (prefixes.length === 0) {
    if (headTip !== null) {
      parts.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (wantUnborn) {
      parts.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ZERO} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = store.git.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

function fetchReply(store: Store, repo: Repo, args: string[]): Buffer {
  const git = store.git;
  const { wants, haves, shallow, deepen } = parseFetchArgs(args);
  const held = new Set([...haves, ...shallow]);
  // A have the client holds shallowly brings only its own tree closure,
  // not its history: deepening must be able to deliver its parents.
  const deepHaves = haves.filter((h) => !shallow.includes(h));
  const excluded = new Set<string>([...fullClosure(git, deepHaves), ...shallowClosure(git, shallow)]);

  // Decide which commits to include.
  const included = new Set<string>();
  const boundary: string[] = [];
  if (deepen !== null) {
    let frontier = [...wants];
    const seen = new Set<string>();
    for (let gen = 0; gen < deepen; gen++) {
      const next: string[] = [];
      for (const sha of frontier) {
        if (seen.has(sha)) continue;
        seen.add(sha);
        const commit = git.readCommit(sha);
        if (commit === null) continue;
        if (!held.has(sha)) included.add(sha);
        if (gen === deepen - 1) {
          if (commit.parents.some((p) => !seen.has(p) && !held.has(p))) boundary.push(sha);
        } else {
          next.push(...commit.parents);
        }
      }
      frontier = next;
    }
  } else {
    const queue = [...wants];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha) || held.has(sha)) continue;
      seen.add(sha);
      const obj = git.get(sha);
      if (obj === null) continue;
      if (obj.type === 'tag') {
        included.add(sha);
        const target = git.tagTarget(sha);
        if (target !== null) queue.push(target);
        continue;
      }
      if (obj.type !== 'commit') continue;
      included.add(sha);
      const commit = git.readCommit(sha);
      if (commit !== null) queue.push(...commit.parents);
    }
  }

  const objects = new Set<string>();
  for (const sha of included) commitClosure(git, sha, objects, false);
  for (const oid of excluded) objects.delete(oid);

  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = haves.find((have) => wants.some((want) => have === want || git.isAncestor(have, want)));
    parts.push(pktLine(common === undefined ? 'NAK\n' : `ACK ${common}\n`));
    parts.push(DELIM);
  }
  if (deepen !== null || shallow.length > 0) {
    const shallowLines: string[] = [];
    for (const sha of boundary) if (!shallow.includes(sha)) shallowLines.push(`shallow ${sha}`);
    for (const sha of shallow) {
      const commit = git.readCommit(sha);
      if (commit !== null && commit.parents.every((p) => included.has(p) || held.has(p)) && !boundary.includes(sha)) {
        shallowLines.push(`unshallow ${sha}`);
      }
    }
    if (shallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
      parts.push(DELIM);
    }
  }
  const wantedRefs: string[] = [];
  for (const [name, oid] of sortedRefs(repo)) {
    if (wants.includes(oid)) wantedRefs.push(`${oid} ${name}`);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(`${line}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(git, objects);
  for (let at = 0; at < pack.length; at += 65515) {
    const chunk = Buffer.concat([Buffer.from([1]), pack.subarray(at, at + 65515)]);
    parts.push(pktLine(chunk));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- v0 fetch ------------------------------------------------------------------------

function handleV0Fetch(store: Store, repo: Repo, body: Buffer, send: Send): void {
  const { packets } = parsePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
  }
  const args: string[] = [
    ...wants.map((w) => `want ${w}`),
    ...haves.map((h) => `have ${h}`),
    ...(deepen !== null ? [`deepen ${deepen}`] : []),
    'done',
  ];
  // Reuse the v2 computation, then reframe: shallow lines + NAK + sideband pack.
  const v2 = fetchReply(store, repo, args);
  const { packets: sections } = parsePackets(v2);
  const shallowLines: Buffer[] = [];
  const packChunks: Buffer[] = [];
  let section = '';
  for (const packet of sections) {
    if (packet.kind === 'delim') { section = ''; continue; }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (text === 'shallow-info\n') { section = 'shallow'; continue; }
    if (text === 'packfile\n') { section = 'pack'; continue; }
    if (text === 'acknowledgments\n' || text === 'wanted-refs\n') { section = 'skip'; continue; }
    if (section === 'shallow') shallowLines.push(pktLine(packet.payload));
    else if (section === 'pack') packChunks.push(pktLine(packet.payload));
  }
  const reframed = Buffer.concat([...shallowLines, pktLine('NAK\n'), ...packChunks, FLUSH]);
  send(200, 'application/x-git-upload-pack-result', reframed);
}

// ---- receive-pack ----------------------------------------------------------------------

interface PushCommand { oldOid: string; newOid: string; ref: string }

function handleReceivePack(store: Store, repo: Repo, body: Buffer, send: Send): void {
  const git = store.git;
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  const pack = body.subarray(rest);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      unpackPack(git, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = store.refGet(repo, command.ref);
    if (command.newOid === ZERO) {
      if (current === null) reportLines.push(`ng ${command.ref} reference not found`);
      else {
        store.refDelete(repo, command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!git.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} new object not found`);
      continue;
    }
    if (command.oldOid === ZERO) {
      if (current !== null) { reportLines.push(`ng ${command.ref} reference already exists`); continue; }
      store.refSet(repo, command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} old value is not current`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const oldCommit = git.peelToCommit(command.oldOid);
      const newCommit = git.peelToCommit(command.newOid);
      if (oldCommit === null || newCommit === null || !git.isAncestor(oldCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    store.refSet(repo, command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const reportText = `${reportLines.join('\n')}\n`;
  const parts: Buffer[] = [];
  if (capabilities.split(' ').includes('side-band-64k')) {
    const data = Buffer.from(reportText, 'utf8');
    for (let at = 0; at < data.length; at += 65515) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(at, at + 65515)])));
    }
  } else {
    for (const line of reportLines) parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  send(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
