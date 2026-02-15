# Diff Hop

Diff Hop is a lightweight VS Code extension that adds commit navigation arrows to Git diffs.

- `◀` jumps to an older commit diff for the same file.
- `▶` jumps to a newer commit diff for the same file.

It is intentionally minimal:
- No webviews
- No custom trees
- No background repository polling

## Commands

- `Git: Previous Commit (Diff Hop)`
- `Git: Next Commit (Diff Hop)`

These commands are available in the Command Palette and in the editor title toolbar (when applicable).

## How it works

1. Open a file and use Timeline/Git UI to open a commit diff.
2. When the active editor is a supported Git diff, arrows appear in the editor title.
3. Use arrows or commands to move through commit diffs for the same file.

Outside a diff editor, running a Diff Hop command uses the active file as the baseline and starts from HEAD vs working tree navigation.

## Behavior details

- The extension detects Git diff context from active diff tabs (`git:` URIs).
- It resolves the correct repository in multi-root workspaces using `api.getRepository(fileUri)`.
- It reads commit history for that file (`repo.log`) with a small 10-second cache.
- Navigation opens diffs via `vscode.diff` + `api.toGitUri`.

## Limitations (MVP)

- File renames across history are not tracked.
- Works only for Git-backed file resources.
- Requires VS Code built-in Git extension (`vscode.git`) to be enabled.

## Manual Test Checklist

1. Timeline commit diff
- Open tracked file.
- Open Timeline and click a commit diff.
- Confirm arrows appear in editor title.
- Click `◀` repeatedly and confirm older commit diffs open.
- Click `▶` and confirm navigation returns toward newer commits.

2. Non-diff editor fallback
- Open a regular file editor.
- Confirm arrows are hidden.
- Run `Git: Previous Commit (Diff Hop)`.
- Confirm a diff opens for that file history.

3. Working tree comparison
- Open a `HEAD` vs working tree diff for a file.
- Confirm `◀` opens commit-vs-parent history.
- Confirm `▶` can return to `HEAD` vs working tree when at newest commit boundary.

4. Multi-root workspace
- Open two repos in one workspace.
- Run Diff Hop on a file in repo B.
- Confirm navigation uses repo B history.

5. Boundary conditions
- At oldest commit: previous action does nothing and does not crash.
- At newest working-tree position: next action does nothing and does not crash.
- Root commit: empty-left fallback opens without crashing.

6. Git disabled
- Disable built-in Git extension.
- Confirm one friendly message is shown and UI stays hidden.

7. Responsiveness
- Switch editors rapidly.
- Confirm no visible lag and no heavy background scanning behavior.

## Build & Package

```bash
npm install
npm run compile
npm run package
```

`npm run package` uses `vsce package` and produces a `.vsix`.
