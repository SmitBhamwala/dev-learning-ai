# dev-learning-ai for Claude Code

A Claude Code mod built on function hooks. After a turn that changes code, it offers a few questions about what you just did. The questions are written at that moment by your session's model, from the task's file names and identifiers.

## Install

The dev-learning-ai CLI must be installed first: run `npm install -g dev-learning-ai`, or build it from source. Then, in a terminal Claude Code session:

```bash
claude plugin marketplace add /path/to/dev-learning-ai/integrations/claude-code
```

```text
/plugin install dev-learning-ai@dev-learning-ai
```

If `dev-learning-ai` isn't on the PATH that Claude Code sees (common on Windows), set the plugin's `cli` option to `node /abs/path/to/dev-learning-ai/apps/cli/dist/bin.js`.

## Use

- After a meaningful task, a band above the prompt offers questions. Press `1` to start, `2` for later or `3` to skip.
- The first time, it asks whether your session's model may write questions. It sends file names, identifiers and detected concepts, never whole files and never your prompt.
- Answer with the choice's letter. Optionally type why, then say how sure you are (`1` to `4`). Feedback appears immediately.
- `/learn` shows the status pane.
- `/learn review` reviews due concepts with new questions.
- `/learn pause` pauses learning for the current task.
- `/learn off` turns learning off for this session.

## Guarantees

- It never rewrites or blocks prompts or tool calls, and never changes permissions.
- It runs only the configured CLI, by argv with no shell, and only once per code-changing turn or user action.
- It fails open: if the CLI is missing or errors, nothing is shown and your session continues.

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude plugin validate` checks the manifest and hooks, and `claude plugin test` runs the behaviour tests. `claude --plugin-dir .` starts a session with the mod loaded from this folder.
