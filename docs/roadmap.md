# Roadmap

Planned, not implemented:

- **More agent adapters**: Codex, Cursor, Gemini CLI, GitHub Copilot, Cline, Aider and others, using the [adapter guide](adapters.md).
- **More providers**: OpenAI, Gemini, and local models through an OpenAI-compatible or Ollama-style provider.
- **Host grading of open answers**: grading open answers on the session's model inside Claude Code. Today only a direct provider refines rubric grades.
- **Teach mode inside the agent**: guided hints during a task. The mode is resolved and recorded today, but the mod only runs post-task assessments.
- **Pre-task assessment and Socratic mode**: the settings exist and are reserved.
- **Verified documentation lookup**: fetching official docs for version-aware explanations and resource freshness, with source URL, version and retrieval time. Resources are curated official links today.
- **SQLite storage backend** behind the `Store` boundary, for very large histories.
- **Vault-provider extensions** (Notion, Logseq) through the extension API.
- **Deterministic execution of output-prediction questions** in an isolated sandbox.
- **VS Code extension** using the same agent protocol.
- **Trend charts** in the dashboard (retention and mastery over time).
