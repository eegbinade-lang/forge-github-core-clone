// The forge's data store: repositories with their git refs, issues, pull
// requests, labels and comments, all in memory. One bearer token names one
// viewer; a repository's owner login is adopted from the first owner-named
// path that touches it (the token itself carries no login), and any other
// owner name for the same repository is a 404, exactly as the suite drives
// it.

import { GitStore } from './gitstore.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name (refs/heads/main) -> object sha
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // issues and pulls share one sequence, as on GitHub
  createdAt: string;
  updatedAt: string;
}

export class Store {
  readonly git = new GitStore();
  private repos = new Map<string, Repo>(); // key: name (single tenant)
  private nextRepoId = 1;
  private nextObjectId = 1; // issues, pulls, labels, comments share id space per kind below
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private clockTick = 0;
  /** The viewer's login, learned from the first owner-named request. */
  viewerLogin: string | null = null;

  /** Deterministic ISO timestamp from the logical clock. */
  now(): string {
    this.clockTick += 1;
    return new Date(1_700_000_000_000 + this.clockTick * 1000).toISOString();
  }

  learnViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /** The token's login, materializing a stable default when nothing named it yet. */
  viewerName(): string {
    if (this.viewerLogin === null) this.viewerLogin = 'forge';
    return this.viewerLogin;
  }

  createRepo(name: string, isPrivate: boolean, description: string | null, defaultBranch: string): Repo | null {
    if (this.repos.has(name)) return null;
    const stamp = this.now();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewerLogin,
      isPrivate,
      description,
      defaultBranch,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository by owner + name. Adopts the owner on first touch;
   * a different owner than the adopted one does not resolve.
   */
  repoFor(owner: string, name: string): Repo | null {
    this.learnViewer(owner);
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) repo.owner = owner;
    return repo.owner === owner ? repo : null;
  }

  /** Resolve by name alone (the token holder's own view). */
  repoByName(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  ownerOf(repo: Repo): string {
    return repo.owner ?? this.viewerLogin ?? 'viewer';
  }

  // ---- refs --------------------------------------------------------------------

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setBranch(repo: Repo, branch: string, sha: string): void {
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = this.now();
  }

  refGet(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  refSet(repo: Repo, ref: string, sha: string): void {
    repo.refs.set(ref, sha);
    repo.updatedAt = this.now();
  }

  refDelete(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.updatedAt = this.now();
  }

  /** Resolve a branch name, a full ref or a raw sha to a commit sha. */
  resolveCommit(repo: Repo, ref: string): string | null {
    const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
    if (direct !== undefined) return this.git.peelToCommit(direct);
    if (this.git.has(ref)) return this.git.peelToCommit(ref);
    return null;
  }

  /** Commit a flat file map onto a branch; returns the new commit sha. */
  commitFiles(repo: Repo, branch: string, files: ReadonlyMap<string, string>, message: string): string {
    const tree = this.git.buildTree(files);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const sha = this.git.putCommit(tree, parent === undefined ? [] : [parent], message);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = this.now();
    return sha;
  }

  /** The flat file map at a ref (branch name, full ref or sha); empty when unborn. */
  filesAt(repo: Repo, ref: string | null): Map<string, string> {
    const tip = ref === null ? null : this.resolveCommit(repo, ref);
    if (tip === null) return new Map();
    const commit = this.git.readCommit(tip);
    if (commit === null) return new Map();
    return this.git.flattenTree(commit.tree);
  }

  treeAt(repo: Repo, ref: string | null): string | null {
    const tip = ref === null ? null : this.resolveCommit(repo, ref);
    if (tip === null) return null;
    return this.git.readCommit(tip)?.tree ?? null;
  }

  // ---- issues, pulls, labels ---------------------------------------------------

  addLabel(repo: Repo, name: string, color: string, description: string | null): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.nextLabelId++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  addIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const stamp = this.now();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: Issue, body: string): Comment {
    const stamp = this.now();
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: stamp, updatedAt: stamp };
    issue.comments.push(comment);
    issue.updatedAt = stamp;
    return comment;
  }

  addPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const stamp = this.now();
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  allocateObjectId(): number {
    return this.nextObjectId++;
  }
}
