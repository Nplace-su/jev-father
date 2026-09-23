# Install and launch Jev Father

When the user asks to install, run, or try this repository, complete the local setup and open the working page. Do not hand the user an installation checklist. For code changes or review, follow the actual request instead of starting the app automatically.

## Local setup

1. Use this checkout if already present. Otherwise clone `https://github.com/Nplace-su/jev-father` into an appropriate user workspace. Preserve existing files and uncommitted work. If Git is unavailable, downloading and extracting the GitHub source archive is sufficient. If repository access is denied, report the actual access problem; do not change repository visibility.
2. Check Node.js. Minimum is 20.12; prefer a supported LTS version already installed. This project has no third-party packages: no `npm install`, build, Docker, database, or API key is needed to launch it. If Node is missing or too old, install a supported LTS runtime using the user's existing version manager/package manager or an official nodejs.org distribution. Prefer a user-local installation; preserve their existing default runtime. Honor the agent environment's permissions and approval policy. If runtime installation is blocked, explain that specific blocker.
3. From the repository, run `npm run start:agent` (or `node scripts/agent-start.mjs` if npm is unavailable). It starts a detached local service, waits for its health endpoint, and returns JSON with `url`, `status`, and, for a new process, `pid` and `log`. It reuses a healthy Jev Father service and tries ports 3210–3220 when occupied. An explicit `PORT` or existing `.env` changes the starting port. Never kill an unrelated process to free a port.
4. Verify the returned URL: `GET /api/health` must return `app: "jev-father"` and `status: "ready"`; `GET /` must serve the Jev Father page. Open that URL with the available browser tool or normal system browser. If browser interaction is available, click “先看一个虚构示例” and verify the clearly labeled demo result. Do not call real Jev just to check installation. A sandbox/container/remote environment must expose or forward the local port before claiming that the user's browser can reach it.
5. Leave the server running and report the clickable local URL, where it was installed, and a short stop instruction for the process you started. If reusing an existing service, do not guess its PID. The user enters their own Jev API key and public GitHub URL in the page.

## Credentials and boundaries

- Do not ask the user to paste an API key into agent chat or require creating `.env`. The default UI uses a key for one evaluation and clears the field on submission. No author-hosted service receives it.
- An existing `.env` is optional local configuration. Do not print, overwrite, commit, or copy its values. Do not add keys to command lines, screenshots, logs, or reports.
- Only public GitHub repositories are evaluated. GitHub CLI authentication is optional for rate limits; do not demand it during installation.
- Local bind only: `127.0.0.1`. Do not switch to `0.0.0.0`, open a public tunnel, or publish the app as part of a local installation.
- Runtime logs live under ignored `.local/`. `npm start` and the platform launchers remain available for foreground/manual use. Detailed harness documentation is in `docs/harness.md`.

## Development

Use `npm test` for affected server/harness changes. Preserve final Jev Choice selection, public-repository-only collection, per-request key isolation, and explicit coverage/cost reporting. Do not run paid evaluations merely for documentation or installation edits.
