# Security policy

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security Advisories) on this repository. Don't open a public issue. Include the steps to reproduce, the impact and the affected version.

We aim to acknowledge reports within 5 working days.

In scope:

- the dashboard: authentication, CSRF, XSS, path traversal
- the agent protocol
- data leaving the machine without the configured permission
- cross-project data leakage
- secret handling
- storage integrity

The security model is described in [docs/security.md](docs/security.md). Claude Code mods are not a sandbox; that document explains what the mod does and does not do.
