import * as path from "path";
import * as vscode from "vscode";
import type { API, Commit, GitExtension, Repository } from "./git";

type Direction = "previous" | "next";
type ContextMode = "commit-vs-commit" | "commit-vs-working";
type OpenCommitDiffResult = "opened" | "no-left-side" | "error";

interface DiffContext {
  fileUri: vscode.Uri;
  repoRoot: string;
  repo: Repository;
  mode: ContextMode;
  currentCommitHash?: string;
  commits: Commit[];
  currentIndex: number;
  canPrev: boolean;
  canNext: boolean;
}

interface GitUriDetails {
  fileUri?: vscode.Uri;
  ref?: string;
}

interface CacheEntry {
  ts: number;
  commits: Commit[];
}

const CACHE_TTL_MS = 10_000;
const MAX_LOG_ENTRIES = 200;
const REF_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

class DiffHopController {
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly logCache = new Map<string, CacheEntry>();
  private gitApi: API | undefined;
  private gitUnavailableNotified = false;
  private currentContext: DiffContext | undefined;
  private workingTreeAnchorKey: string | undefined;

  public async initialize(): Promise<void> {
    this.gitApi = await this.tryGetGitApi();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.commands.registerCommand("diffHop.previousCommit", () => this.navigate("previous")),
      vscode.commands.registerCommand("diffHop.nextCommit", () => this.navigate("next"))
    );

    await this.refreshContext();
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      void this.refreshContext();
    }, 120);
  }

  private async refreshContext(): Promise<void> {
    if (!this.gitApi) {
      this.gitApi = await this.tryGetGitApi();
    }

    if (!this.gitApi) {
      this.currentContext = undefined;
      this.workingTreeAnchorKey = undefined;
      await this.updateContextKeys(false, false, false);
      return;
    }

    const context = await this.createContextFromActiveDiff();
    this.currentContext = context;

    if (!context) {
      this.workingTreeAnchorKey = undefined;
      await this.updateContextKeys(false, false, false);
      return;
    }

    const contextKey = this.getContextKey(context.repoRoot, context.fileUri);
    if (context.mode === "commit-vs-working") {
      this.workingTreeAnchorKey = contextKey;
    } else if (this.workingTreeAnchorKey !== contextKey) {
      this.workingTreeAnchorKey = undefined;
    }

    await this.updateContextKeys(true, context.canPrev, context.canNext);
  }

  private async navigate(direction: Direction): Promise<void> {
    if (!this.gitApi) {
      this.gitApi = await this.tryGetGitApi();
    }

    if (!this.gitApi) {
      return;
    }

    await this.refreshContext();
    let context = this.currentContext;

    if (!context) {
      context = await this.createFallbackContextFromActiveFile();
      if (!context) {
        return;
      }
      this.currentContext = context;
      this.workingTreeAnchorKey = this.getContextKey(context.repoRoot, context.fileUri);
    }

    if (direction === "previous" && !context.canPrev) {
      void vscode.window.showInformationMessage("Diff Hop: reached the beginning of history for this file.");
      return;
    }

    if (direction === "next" && !context.canNext) {
      void vscode.window.showInformationMessage("Diff Hop: reached the newest side of history for this file.");
      return;
    }

    const target = this.resolveTargetIndex(context, direction);
    if (target === undefined) {
      if (direction === "previous") {
        void vscode.window.showInformationMessage("Diff Hop: reached the beginning of history for this file.");
      } else {
        void vscode.window.showInformationMessage("Diff Hop: reached the newest side of history for this file.");
      }
      return;
    }

    if (target === -1) {
      await this.openWorkingTreeDiff(context.fileUri);
    } else {
      const targetCommit = context.commits[target];
      if (!targetCommit) {
        return;
      }
      const result = await this.openCommitDiff(context.fileUri, targetCommit);
      if (result === "no-left-side") {
        void vscode.window.showInformationMessage("Diff Hop: reached the beginning of comparable history for this file.");
        return;
      }

      if (result === "error") {
        return;
      }
    }

    await this.refreshContext();
  }

  private resolveTargetIndex(context: DiffContext, direction: Direction): number | undefined {
    if (direction === "previous") {
      if (context.currentIndex === -1) {
        return 0;
      }
      return context.currentIndex + 1 < context.commits.length ? context.currentIndex + 1 : undefined;
    }

    if (context.currentIndex === -1) {
      return undefined;
    }

    if (context.currentIndex > 0) {
      return context.currentIndex - 1;
    }

    return this.isWorkingTreeAnchored(context) ? -1 : undefined;
  }

  private async openCommitDiff(fileUri: vscode.Uri, commit: Commit): Promise<OpenCommitDiffResult> {
    if (!this.gitApi) {
      return "error";
    }

    const right = this.gitApi.toGitUri(fileUri, commit.hash);
    const parent = commit.parents[0];
    const rightRef = this.shortRef(commit.hash);

    if (!parent) {
      return "no-left-side";
    }

    const parentLeft = this.gitApi.toGitUri(fileUri, parent);

    try {
      await vscode.workspace.openTextDocument(parentLeft);
    } catch {
      return "no-left-side";
    }

    try {
      const title = this.formatDiffTitle(fileUri, this.shortRef(parent), rightRef);
      await vscode.commands.executeCommand("vscode.diff", parentLeft, right, title, { preview: false });
      return "opened";
    } catch (error) {
      if (!this.isFileNotFoundError(error)) {
        void vscode.window.showInformationMessage("Diff Hop: unable to open commit diff.");
        return "error";
      }
    }

    return "no-left-side";
  }

  private async openWorkingTreeDiff(fileUri: vscode.Uri): Promise<void> {
    if (!this.gitApi) {
      return;
    }

    const left = this.gitApi.toGitUri(fileUri, "HEAD");
    const title = this.formatDiffTitle(fileUri, "HEAD", "working tree");
    await vscode.commands.executeCommand("vscode.diff", left, fileUri, title, { preview: false });
  }

  private async createContextFromActiveDiff(): Promise<DiffContext | undefined> {
    const pair = this.getActiveDiffPair();
    if (!pair) {
      return undefined;
    }

    const { original, modified } = pair;
    const leftIsGit = original?.scheme === "git";
    const rightIsGit = modified?.scheme === "git";

    if (!leftIsGit && !rightIsGit) {
      return undefined;
    }

    const leftGit = leftIsGit && original ? this.parseGitUri(original) : undefined;
    const rightGit = rightIsGit && modified ? this.parseGitUri(modified) : undefined;
    const fileFromGit = rightGit?.fileUri ?? leftGit?.fileUri;
    const fileFromFile = modified?.scheme === "file" ? modified : original?.scheme === "file" ? original : undefined;
    const fileUri = fileFromFile ?? fileFromGit;
    if (!fileUri || fileUri.scheme !== "file") {
      return undefined;
    }

    const mode: ContextMode =
      (original?.scheme === "file" || modified?.scheme === "file") ? "commit-vs-working" : "commit-vs-commit";
    const currentRef = rightGit?.ref ?? leftGit?.ref;
    if (mode === "commit-vs-commit" && !currentRef) {
      return undefined;
    }

    const repoAndCommits = await this.resolveRepoAndCommits(fileUri);
    if (!repoAndCommits) {
      return undefined;
    }

    const { repo, commits } = repoAndCommits;
    const repoRoot = repo.rootUri.fsPath;
    const currentIndex = this.resolveCurrentIndex(mode, currentRef, commits);
    if (currentIndex === undefined) {
      return undefined;
    }

    const context: DiffContext = {
      fileUri,
      repoRoot,
      repo,
      mode,
      currentCommitHash: currentRef,
      commits,
      currentIndex,
      canPrev: false,
      canNext: false
    };

    context.canPrev = this.computeCanPrev(context);
    context.canNext = this.computeCanNext(context);
    return context;
  }

  private async createFallbackContextFromActiveFile(): Promise<DiffContext | undefined> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || activeUri.scheme !== "file") {
      void vscode.window.showInformationMessage("Diff Hop: open a tracked file first.");
      return undefined;
    }

    const repoAndCommits = await this.resolveRepoAndCommits(activeUri);
    if (!repoAndCommits) {
      void vscode.window.showInformationMessage("Diff Hop: file is not in a Git repository.");
      return undefined;
    }

    const { repo, commits } = repoAndCommits;
    if (commits.length === 0) {
      void vscode.window.showInformationMessage("Diff Hop: no commit history found for this file.");
      return undefined;
    }

    const context: DiffContext = {
      fileUri: activeUri,
      repoRoot: repo.rootUri.fsPath,
      repo,
      mode: "commit-vs-working",
      currentCommitHash: "HEAD",
      commits,
      currentIndex: -1,
      canPrev: true,
      canNext: false
    };

    return context;
  }

  private getActiveDiffPair(): { original: vscode.Uri; modified: vscode.Uri } | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputTextDiff) {
      return {
        original: tab.input.original,
        modified: tab.input.modified
      };
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === "git") {
      return { original: activeUri, modified: activeUri };
    }

    return undefined;
  }

  private async resolveRepoAndCommits(fileUri: vscode.Uri): Promise<{ repo: Repository; commits: Commit[] } | undefined> {
    if (!this.gitApi) {
      return undefined;
    }

    const repo = this.gitApi.getRepository(fileUri);
    if (!repo) {
      return undefined;
    }

    const cacheKey = this.getContextKey(repo.rootUri.fsPath, fileUri);
    const cached = this.logCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return { repo, commits: cached.commits };
    }

    let commits: Commit[] = [];
    try {
      commits = await repo.log({ path: fileUri.fsPath, maxEntries: MAX_LOG_ENTRIES });
    } catch {
      void vscode.window.showInformationMessage("Diff Hop: unable to read git history for this file.");
      return undefined;
    }

    this.logCache.set(cacheKey, { ts: now, commits });
    return { repo, commits };
  }

  private parseGitUri(uri: vscode.Uri): GitUriDetails {
    if (uri.scheme !== "git") {
      return {};
    }

    let pathFromQuery: string | undefined;
    let ref: string | undefined;
    const rawQuery = uri.query;
    const decodedQuery = this.decodeQuery(rawQuery);

    if (decodedQuery) {
      try {
        const parsed = JSON.parse(decodedQuery) as Record<string, unknown>;
        if (typeof parsed.path === "string") {
          pathFromQuery = parsed.path;
        }
        if (typeof parsed.ref === "string") {
          ref = parsed.ref;
        } else if (typeof parsed.sha === "string") {
          ref = parsed.sha;
        }
      } catch {
        const params = new URLSearchParams(decodedQuery);
        const queryPath = params.get("path");
        const queryRef = params.get("ref") ?? params.get("sha");
        if (queryPath) {
          pathFromQuery = queryPath;
        }
        if (queryRef) {
          ref = queryRef;
        }
      }
    }

    const filePath = pathFromQuery ?? uri.fsPath;
    const fileUri = filePath ? vscode.Uri.file(filePath) : undefined;
    return { fileUri, ref };
  }

  private decodeQuery(rawQuery: string): string {
    if (!rawQuery) {
      return "";
    }

    try {
      return decodeURIComponent(rawQuery);
    } catch {
      return rawQuery;
    }
  }

  private resolveCurrentIndex(mode: ContextMode, currentRef: string | undefined, commits: Commit[]): number | undefined {
    if (commits.length === 0) {
      return -1;
    }

    if (mode === "commit-vs-working") {
      return -1;
    }

    if (!currentRef) {
      return undefined;
    }

    const normalized = this.normalizeRef(currentRef);
    if (!normalized) {
      return undefined;
    }

    if (normalized === "HEAD") {
      return 0;
    }

    const exact = commits.findIndex((commit) => commit.hash === normalized);
    if (exact >= 0) {
      return exact;
    }

    if (REF_HASH_PATTERN.test(normalized)) {
      const prefix = commits.findIndex((commit) => commit.hash.startsWith(normalized));
      if (prefix >= 0) {
        return prefix;
      }
    }

    return undefined;
  }

  private normalizeRef(ref: string): string | undefined {
    const trimmed = ref.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed === "HEAD") {
      return "HEAD";
    }

    const hashMatch = trimmed.match(/[0-9a-f]{7,40}/i);
    return hashMatch?.[0];
  }

  private computeCanPrev(context: DiffContext): boolean {
    if (context.currentIndex === -1) {
      return context.commits.length > 0;
    }

    return context.currentIndex + 1 < context.commits.length;
  }

  private computeCanNext(context: DiffContext): boolean {
    if (context.currentIndex === -1) {
      return false;
    }

    if (context.currentIndex > 0) {
      return true;
    }

    return this.isWorkingTreeAnchored(context);
  }

  private isWorkingTreeAnchored(context: DiffContext): boolean {
    return this.workingTreeAnchorKey === this.getContextKey(context.repoRoot, context.fileUri);
  }

  private getContextKey(repoRoot: string, fileUri: vscode.Uri): string {
    return `${repoRoot}|${fileUri.fsPath}`;
  }

  private shortRef(ref: string): string {
    return ref.slice(0, 8);
  }

  private isFileNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes("file was not found") || message.includes("not found");
    }

    if (typeof error === "string") {
      const message = error.toLowerCase();
      return message.includes("file was not found") || message.includes("not found");
    }

    return false;
  }

  private formatDiffTitle(fileUri: vscode.Uri, left: string, right: string): string {
    return `Diff Hop: ${path.basename(fileUri.fsPath)} (${left} \u2194 ${right})`;
  }

  private async updateContextKeys(active: boolean, canPrev: boolean, canNext: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "diffHop.active", active);
    await vscode.commands.executeCommand("setContext", "diffHop.canPrev", canPrev);
    await vscode.commands.executeCommand("setContext", "diffHop.canNext", canNext);
  }

  private async tryGetGitApi(): Promise<API | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension) {
      this.notifyGitUnavailable();
      return undefined;
    }

    if (!extension.isActive) {
      try {
        await extension.activate();
      } catch {
        this.notifyGitUnavailable();
        return undefined;
      }
    }

    const api = extension.exports?.getAPI?.(1);
    if (!api) {
      this.notifyGitUnavailable();
      return undefined;
    }

    return api;
  }

  private notifyGitUnavailable(): void {
    if (this.gitUnavailableNotified) {
      return;
    }

    this.gitUnavailableNotified = true;
    void vscode.window.showInformationMessage("Diff Hop: built-in Git extension is unavailable.");
  }
}

let controller: DiffHopController | undefined;

export async function activate(): Promise<void> {
  controller = new DiffHopController();
  await controller.initialize();
}

export function deactivate(): void {
  controller?.dispose();
}
