# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-13

### Added

- **Core engine**
  - Event schema v1
  - Layered configuration with managed locks, history and rollback
  - Version-aware concept catalog: 40 concepts across 11 technologies
  - Runtime question generation with strict validation
  - Answer evaluation with a calibration matrix
  - Eight-dimension scoring (`scoring@1`) with an audit trail
  - Hierarchy aggregation (`agnostic-first@1`)
  - SM-2 review scheduling
  - Opportunity detection
  - Secret redaction
  - Provider resolution with privacy gates and budgets
- **Runtime**
  - Journaled JSON store with migrations
  - Project identity across clones, forks, worktrees and monorepos
  - Technology discovery from lockfiles and manifests
  - Markdown and Obsidian vaults with ownership markers
  - Anthropic API provider
  - Reports, backup and restore
  - Doctor
  - Extension loader
  - Agent protocol
- **CLI:** `dev-learning-ai` (alias `dla`), including guided setup and interactive assessments.
- **Local dashboard:** 11 views, with token authentication, CSRF protection and a strict CSP.
- **Claude Code mod**
  - Passive observation
  - Offer band
  - Consent before the session model writes questions
  - Question, feedback and summary UI
  - `/learn` command and pane
  - Recovery of interrupted assessments
- **Example extension:** GraphQL concepts and a CSV exporter, with contract tests.
