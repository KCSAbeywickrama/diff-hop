import * as vscode from "vscode";

export interface Commit {
  readonly hash: string;
  readonly parents: string[];
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  log(options?: { path?: string; maxEntries?: number }): Promise<Commit[]>;
}

export interface API {
  getRepository(uri: vscode.Uri): Repository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export interface GitExtension {
  getAPI(version: 1): API;
}
