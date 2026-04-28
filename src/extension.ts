import * as path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { API, Commit, GitExtension, Repository } from "./git";

type Direction = "previous" | "next";
type ContextMode = "commit-vs-commit" | "commit-vs-working";
type OpenCommitDiffResult = "opened" | "no-left-side" | "error";
type HistorySource = "path" | "follow";

interface DiffContext {
  fileUri: vscode.Uri;
  repoRoot: string;
  repo: Repository;
  history: HistoryCursor;
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

interface HistoryCursor {
  commits: Commit[];
  source: HistorySource;
  canExtendAcrossRenames: boolean;
}

type DiffSide = "original" | "modified";

interface NavigationSnapshot {
  anchorLine: number;
  cursorCharacter: number;
  cursorLine: number;
  preferredSide: DiffSide;
  sourceFileUri: string;
  viewportAnchorLine: number;
  visibleEndLine: number;
  visibleStartLine: number;
}

interface FollowCacheEntry {
  commits: Commit[];
  pathsByHash: Record<string, string>;
  ts: number;
}

const CACHE_TTL_MS = 10_000;
const MAX_LOG_ENTRIES = 200;
const REF_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const EXTEND_RENAMES_ACTION = "Extend Across Renames";
const execFileAsync = promisify(execFile);

class DiffHopController {
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly logCache = new Map<string, CacheEntry>();
  private readonly followCache = new Map<string, FollowCacheEntry>();
  private readonly followPromptShown = new Set<string>();
  private readonly followInFlight = new Set<string>();
  private gitApi: API | undefined;
  private gitUnavailableNotified = false;
  private currentContext: DiffContext | undefined;

  public async initialize(): Promise<void> {
    this.gitApi = await this.tryGetGitApi();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.commands.registerCommand("diffHop.previousCommit", () => this.navigate("previous")),
      vscode.commands.registerCommand("diffHop.nextCommit", () => this.navigate("next")),
      vscode.commands.registerCommand("diffHop.copyLeftCommitHash", () => this.copyCommitHash("left")),
      vscode.commands.registerCommand("diffHop.copyRightCommitHash", () => this.copyCommitHash("right"))
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
      await this.updateContextKeys(false, false, false, false, false);
      return;
    }

    const diffPair = this.getActiveDiffPair();
    const context = await this.createContextFromActiveDiff(diffPair);
    this.currentContext = context;
    const leftCommitAvailable = diffPair?.original.scheme === "git";
    const rightCommitAvailable = diffPair?.modified.scheme === "git";

    if (!context) {
      await this.updateContextKeys(
        false,
        false,
        false,
        leftCommitAvailable,
        rightCommitAvailable
      );
      return;
    }

    await this.updateContextKeys(
      true,
      context.canPrev,
      context.canNext,
      leftCommitAvailable,
      rightCommitAvailable
    );
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
    }

    const navigationSnapshot = this.captureNavigationSnapshot(context.fileUri);

    if (direction === "previous" && !context.canPrev) {
      await this.maybeOfferFollowAndRetry(context, navigationSnapshot);
      return;
    }

    if (direction === "next" && !context.canNext) {
      void vscode.window.showInformationMessage("Diff Hop: reached the newest side of history for this file.");
      return;
    }

    const target = this.resolveTargetIndex(context, direction);
    if (target === undefined) {
      if (direction === "previous") {
        await this.maybeOfferFollowAndRetry(context, navigationSnapshot);
      } else {
        void vscode.window.showInformationMessage("Diff Hop: reached the newest side of history for this file.");
      }
      return;
    }

    if (target === -1) {
      await this.openWorkingTreeDiff(context.fileUri);
      await this.restoreEditorContextAfterOpen(navigationSnapshot);
    } else {
      const targetCommit = context.commits[target];
      if (!targetCommit) {
        return;
      }
      const result = await this.openCommitDiff(context.fileUri, targetCommit, context.repoRoot);
      if (result === "no-left-side") {
        await this.maybeOfferFollowAndRetry(context, navigationSnapshot);
        return;
      }

      if (result === "error") {
        return;
      }

      if (result === "opened") {
        await this.restoreEditorContextAfterOpen(navigationSnapshot);
      }
    }

    await this.refreshContext();
  }

  private async maybeOfferFollowAndRetry(
    context: DiffContext,
    navigationSnapshot: NavigationSnapshot | undefined
  ): Promise<void> {
    if (context.mode !== "commit-vs-commit" && context.mode !== "commit-vs-working") {
      return;
    }

    const cacheKey = this.getContextKey(context.repoRoot, context.fileUri);
    let extendedCommits = this.followCache.get(cacheKey)?.commits;

    if (!extendedCommits) {
      if (this.followPromptShown.has(cacheKey)) {
        return;
      }

      this.followPromptShown.add(cacheKey);
      try {
        const action = await vscode.window.showInformationMessage(
          "Diff Hop: Reached path history boundary. Extend across renames?",
          EXTEND_RENAMES_ACTION
        );
        if (action !== EXTEND_RENAMES_ACTION) {
          return;
        }
      } finally {
        this.followPromptShown.delete(cacheKey);
      }

      extendedCommits = await this.extendHistoryAcrossRenames(context);
      if (!extendedCommits) {
        return;
      }
    }

    if (extendedCommits.length <= context.commits.length) {
      void vscode.window.showInformationMessage("Diff Hop: No additional history found across renames.");
      return;
    }

    const applied = this.applyExtendedHistoryToContext(context, extendedCommits);
    if (!applied || !context.canPrev) {
      void vscode.window.showInformationMessage("Diff Hop: reached the beginning of history for this file.");
      return;
    }

    const nextTarget = this.resolveTargetIndex(context, "previous");
    if (nextTarget === undefined || nextTarget === -1) {
      void vscode.window.showInformationMessage("Diff Hop: reached the beginning of history for this file.");
      return;
    }

    const nextCommit = context.commits[nextTarget];
    if (!nextCommit) {
      return;
    }

    const result = await this.openCommitDiff(context.fileUri, nextCommit, context.repoRoot);
    if (result === "opened") {
      await this.restoreEditorContextAfterOpen(navigationSnapshot);
      await this.refreshContext();
      return;
    }

    if (result === "no-left-side") {
      void vscode.window.showInformationMessage("Diff Hop: reached the beginning of comparable history for this file.");
      return;
    }
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

    return undefined;
  }

  private async openCommitDiff(fileUri: vscode.Uri, commit: Commit, repoRoot?: string): Promise<OpenCommitDiffResult> {
    if (!this.gitApi) {
      return "error";
    }

    const rightFileUri = this.resolveFileUriForCommit(repoRoot, fileUri, commit.hash);
    const right = this.gitApi.toGitUri(rightFileUri, commit.hash);
    const parent = commit.parents[0];
    const rightRef = this.shortRef(commit.hash);

    if (!parent) {
      return "no-left-side";
    }

    const parentFileUri = this.resolveFileUriForCommit(repoRoot, fileUri, parent);
    const parentLeft = this.gitApi.toGitUri(parentFileUri, parent);

    try {
      await vscode.workspace.openTextDocument(parentLeft);
    } catch {
      return "no-left-side";
    }

    try {
      const title = this.formatDiffTitle(fileUri, this.shortRef(parent), rightRef);
      await vscode.commands.executeCommand("vscode.diff", parentLeft, right, title, this.getDiffOpenOptions());
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
    await vscode.commands.executeCommand("vscode.diff", left, fileUri, title, this.getDiffOpenOptions());
  }

  private async copyCommitHash(side: "left" | "right"): Promise<void> {
    await this.refreshContext();
    const diffPair = this.getActiveDiffPair();
    const targetUri = side === "left" ? diffPair?.original : diffPair?.modified;
    const hash = targetUri?.scheme === "git" ? this.normalizeRef(this.parseGitUri(targetUri).ref ?? "") : undefined;
    if (!hash) {
      void vscode.window.showInformationMessage(`Diff Hop: no ${side} commit hash is available in the active diff.`);
      return;
    }

    await vscode.env.clipboard.writeText(hash);
    void vscode.window.showInformationMessage(`Diff Hop: copied ${side} commit hash ${this.shortRef(hash)}.`);
  }

  private async createContextFromActiveDiff(
    pair = this.getActiveDiffPair()
  ): Promise<DiffContext | undefined> {
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
      history: {
        commits,
        source: "path",
        canExtendAcrossRenames: true
      },
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
      history: {
        commits,
        source: "path",
        canExtendAcrossRenames: true
      },
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

  private captureNavigationSnapshot(fileUri: vscode.Uri): NavigationSnapshot | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    const diffPair = this.getActiveDiffPair();
    if (!activeEditor) {
      return undefined;
    }

    const sourceFileUri = this.resolveSourceFileUri(activeEditor.document.uri) ?? fileUri;
    if (sourceFileUri.toString() !== fileUri.toString()) {
      return undefined;
    }

    const preferredSide = this.resolvePreferredDiffSide(activeEditor.document.uri, diffPair);
    const selection = activeEditor.selection.active;
    const visibleRange = activeEditor.visibleRanges[0];
    const fallbackLine = selection.line;
    const visibleStartLine = visibleRange?.start.line ?? fallbackLine;
    const visibleEndLine = Math.max(visibleRange?.end.line ?? fallbackLine, visibleStartLine);
    const cursorIsVisible = selection.line >= visibleStartLine && selection.line <= visibleEndLine;
    const viewportAnchorLine = visibleStartLine + Math.floor((visibleEndLine - visibleStartLine) / 2);

    return {
      anchorLine: cursorIsVisible ? selection.line : viewportAnchorLine,
      cursorCharacter: selection.character,
      cursorLine: selection.line,
      preferredSide,
      sourceFileUri: sourceFileUri.toString(),
      viewportAnchorLine,
      visibleEndLine,
      visibleStartLine
    };
  }

  private resolvePreferredDiffSide(
    activeUri: vscode.Uri,
    diffPair: { original: vscode.Uri; modified: vscode.Uri } | undefined
  ): DiffSide {
    if (!diffPair) {
      return "modified";
    }

    if (activeUri.toString() === diffPair.original.toString()) {
      return "original";
    }

    if (activeUri.toString() === diffPair.modified.toString()) {
      return "modified";
    }

    return "modified";
  }

  private resolveSourceFileUri(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === "file") {
      return uri;
    }

    if (uri.scheme === "git") {
      return this.parseGitUri(uri).fileUri;
    }

    return undefined;
  }

  private async restoreEditorContextAfterOpen(snapshot: NavigationSnapshot | undefined): Promise<void> {
    if (!snapshot) {
      return;
    }

    const editor = await this.findVisibleEditorForDiffSide(snapshot);
    if (!editor) {
      return;
    }

    const targetLine = this.clampLine(snapshot.anchorLine, editor.document.lineCount);
    const targetCharacter = this.clampCharacter(targetLine, snapshot.cursorCharacter, editor.document);
    const position = new vscode.Position(targetLine, targetCharacter);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private async findVisibleEditorForDiffSide(
    snapshot: NavigationSnapshot
  ): Promise<vscode.TextEditor | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const diffPair = this.getActiveDiffPair();
      const sourceMatches = diffPair
        ? this.diffPairMatchesSource(diffPair, snapshot.sourceFileUri)
        : false;

      if (diffPair && sourceMatches) {
        const preferredEditor = this.findEditorByUri(
          snapshot.preferredSide === "original" ? diffPair.original : diffPair.modified
        );
        if (preferredEditor) {
          return preferredEditor;
        }

        const fallbackEditor = this.findEditorByUri(diffPair.modified) ?? this.findEditorByUri(diffPair.original);
        if (fallbackEditor) {
          return fallbackEditor;
        }
      }

      await this.delay(40);
    }

    return undefined;
  }

  private diffPairMatchesSource(diffPair: { original: vscode.Uri; modified: vscode.Uri }, sourceFileUri: string): boolean {
    const originalSource = this.resolveSourceFileUri(diffPair.original)?.toString();
    const modifiedSource = this.resolveSourceFileUri(diffPair.modified)?.toString();
    return originalSource === sourceFileUri || modifiedSource === sourceFileUri;
  }

  private findEditorByUri(uri: vscode.Uri): vscode.TextEditor | undefined {
    const target = uri.toString();
    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === target);
  }

  private clampLine(line: number, lineCount: number): number {
    if (lineCount <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(line, lineCount - 1));
  }

  private clampCharacter(line: number, character: number, document: vscode.TextDocument): number {
    const targetLine = document.lineAt(line);
    return Math.max(0, Math.min(character, targetLine.text.length));
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

    return context.currentIndex > 0;
  }

  private getContextKey(repoRoot: string, fileUri: vscode.Uri): string {
    return `${repoRoot}|${fileUri.fsPath}`;
  }

  private applyExtendedHistoryToContext(context: DiffContext, commits: Commit[]): boolean {
    context.commits = commits;
    context.history = {
      commits,
      source: "follow",
      canExtendAcrossRenames: false
    };

    const currentIndex = this.resolveCurrentIndex(context.mode, context.currentCommitHash, commits);
    if (currentIndex === undefined) {
      return false;
    }

    context.currentIndex = currentIndex;
    context.canPrev = this.computeCanPrev(context);
    context.canNext = this.computeCanNext(context);
    return true;
  }

  private async extendHistoryAcrossRenames(context: DiffContext): Promise<Commit[] | undefined> {
    const cacheKey = this.getContextKey(context.repoRoot, context.fileUri);
    const cached = this.followCache.get(cacheKey);
    if (cached) {
      return cached.commits;
    }

    if (this.followInFlight.has(cacheKey)) {
      return undefined;
    }

    this.followInFlight.add(cacheKey);
    try {
      const relativePath = this.getRepoRelativePath(context.repoRoot, context.fileUri.fsPath);
      const followOutput = await this.runGitFollowLog(context.repoRoot, relativePath);
      const parsedFollow = this.parseFollowLog(followOutput, relativePath, context.repoRoot);
      const followHashes = parsedFollow.hashes;
      if (followHashes.length === 0) {
        this.cacheFollowResult(context.repoRoot, context.fileUri.fsPath, {
          commits: context.commits,
          pathsByHash: {},
          ts: Date.now()
        });
        return context.commits;
      }

      const mergedCommits = await this.mergeFollowCommits(context.commits, followHashes, context.repoRoot);
      const mergedPaths = this.buildMergedPathMap(mergedCommits, parsedFollow.pathsByHash);
      this.cacheFollowResult(context.repoRoot, context.fileUri.fsPath, {
        commits: mergedCommits,
        pathsByHash: mergedPaths,
        ts: Date.now()
      });
      return mergedCommits;
    } catch {
      void vscode.window.showInformationMessage("Diff Hop: Unable to extend history across renames.");
      return undefined;
    } finally {
      this.followInFlight.delete(cacheKey);
    }
  }

  private async mergeFollowCommits(existing: Commit[], followHashes: string[], repoRoot: string): Promise<Commit[]> {
    const existingByHash = new Map(existing.map((commit) => [commit.hash, commit]));
    const merged = [...existing];
    const seen = new Set(existingByHash.keys());
    const oldestExisting = existing[existing.length - 1]?.hash;
    const startIndex = oldestExisting ? followHashes.indexOf(oldestExisting) + 1 : 0;
    const candidates = startIndex > 0 ? followHashes.slice(startIndex) : followHashes;

    for (const hash of candidates) {
      if (merged.length >= MAX_LOG_ENTRIES) {
        break;
      }

      if (seen.has(hash)) {
        continue;
      }

      const known = existingByHash.get(hash);
      if (known) {
        merged.push(known);
        seen.add(hash);
        continue;
      }

      const parents = await this.runGitParents(repoRoot, hash);
      merged.push({ hash, parents });
      seen.add(hash);
    }

    return merged;
  }

  private getRepoRelativePath(repoRoot: string, fileFsPath: string): string {
    const relative = path.relative(repoRoot, fileFsPath);
    return relative.split(path.sep).join("/");
  }

  private resolveFileUriForCommit(repoRoot: string | undefined, fallbackFileUri: vscode.Uri, hash: string): vscode.Uri {
    if (!repoRoot) {
      return fallbackFileUri;
    }

    const cacheKey = this.getContextKey(repoRoot, fallbackFileUri);
    const mappedPath = this.followCache.get(cacheKey)?.pathsByHash[hash];
    if (mappedPath) {
      return vscode.Uri.file(mappedPath);
    }

    return fallbackFileUri;
  }

  private cacheFollowResult(repoRoot: string, primaryFilePath: string, entry: FollowCacheEntry): void {
    this.followCache.set(`${repoRoot}|${primaryFilePath}`, entry);

    const uniquePaths = new Set<string>(Object.values(entry.pathsByHash));
    for (const filePath of uniquePaths) {
      this.followCache.set(`${repoRoot}|${filePath}`, entry);
    }
  }

  private async runGitFollowLog(repoRoot: string, relativePath: string): Promise<string> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "log",
      "--follow",
      "--name-status",
      "--format=%H",
      "--",
      relativePath
    ]);
    return stdout;
  }

  private parseFollowLog(
    output: string,
    relativePath: string,
    repoRoot: string
  ): { hashes: string[]; pathsByHash: Record<string, string> } {
    const hashes: string[] = [];
    const pathsByHash: Record<string, string> = {};
    const seen = new Set<string>();
    let currentPath = this.normalizeRepoRelativePath(relativePath);
    let currentHash: string | undefined;

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (/^[0-9a-f]{40}$/i.test(line)) {
        currentHash = line;
        if (!seen.has(line)) {
          seen.add(line);
          hashes.push(line);
          pathsByHash[line] = this.repoRelativeToAbsolutePath(repoRoot, currentPath);
        }
        continue;
      }

      if (!currentHash) {
        continue;
      }

      const parts = line.split("\t");
      if (parts.length < 2) {
        continue;
      }

      const status = parts[0];
      if (status.startsWith("R") && parts.length >= 3) {
        const oldPath = this.normalizeRepoRelativePath(parts[1]);
        const newPath = this.normalizeRepoRelativePath(parts[2]);
        if (newPath === currentPath) {
          currentPath = oldPath;
        }
      }
    }

    return { hashes, pathsByHash };
  }

  private buildMergedPathMap(commits: Commit[], parsedMap: Record<string, string>): Record<string, string> {
    const mergedMap: Record<string, string> = {};
    for (const commit of commits) {
      const mappedPath = parsedMap[commit.hash];
      if (mappedPath) {
        mergedMap[commit.hash] = mappedPath;
      }
    }

    return mergedMap;
  }

  private normalizeRepoRelativePath(relativePath: string): string {
    return relativePath.split(path.sep).join("/");
  }

  private repoRelativeToAbsolutePath(repoRoot: string, relativePath: string): string {
    return path.join(repoRoot, ...relativePath.split("/"));
  }

  private async runGitParents(repoRoot: string, hash: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-list", "--parents", "-n", "1", hash]);
    const line = stdout.trim().split(/\r?\n/)[0] ?? "";
    const parts = line.trim().split(/\s+/);
    if (parts.length <= 1) {
      return [];
    }

    return parts.slice(1);
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

  private getDiffOpenOptions(): vscode.TextDocumentShowOptions {
    return {
      preview: true,
      preserveFocus: false,
      viewColumn: vscode.window.activeTextEditor?.viewColumn
    };
  }

  private async updateContextKeys(
    active: boolean,
    canPrev: boolean,
    canNext: boolean,
    leftCommitAvailable: boolean,
    rightCommitAvailable: boolean
  ): Promise<void> {
    await vscode.commands.executeCommand("setContext", "diffHop.active", active);
    await vscode.commands.executeCommand("setContext", "diffHop.canPrev", canPrev);
    await vscode.commands.executeCommand("setContext", "diffHop.canNext", canNext);
    await vscode.commands.executeCommand("setContext", "diffHop.leftCommitAvailable", leftCommitAvailable);
    await vscode.commands.executeCommand("setContext", "diffHop.rightCommitAvailable", rightCommitAvailable);
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
