# FinTracka development environment

Audit and setup date: 2026-10-11 (America/New_York)

## Application implementation update

The historical setup audit below predates the application. FinTracka now includes a React 19/TypeScript 7/Vite 8 frontend with React Router, TanStack Table, Recharts, Vitest, and Playwright 1.64, all pinned in `frontend/package-lock.json`. The Python package now includes the SQLite ledger, FastAPI application, synthetic fixtures, fake-tested Plaid Sandbox boundary, Keychain boundary, Excel/fake-Google exports, backup/restore, launchd plist generation, CLI, and 37+ automated backend tests.

Use `scripts/verify.sh` from the repository root for the complete current verification. It selects the project virtual environment, runs Pytest and `pip check`, then runs frontend units, TypeScript checking, the production build, a fresh-ledger real-Uvicorn Playwright workflow, and `npm audit`. The browser test installs no credentials and uses only generated records.

The Python 3.11.5 restriction remains unchanged: it is acceptable only for synthetic/Sandbox development. A security-current Python 3.14.x environment, FileVault confirmation, encrypted off-device backup, and explicit approval remain hard gates before real financial data.

This document records development-environment setup only. No finance application code, live financial connection, browser profile, credential, or private website was accessed.

## Outcome

The local Python, Git, Node.js, Playwright CLI, Chromium, and Codex security-skill foundation is working. Public TodoMVC smoke tests passed through both the Playwright CLI and Python Playwright.

The two requested Anthropic skills were installed from the user-provided repository archive, reviewed, matched byte-for-byte against Anthropic's current official files, and discovered by a fresh Codex process. Direct GitHub access recovered, allowing the OpenAI security skills to be matched to the current official repository `HEAD`. After a full Cursor restart, this Codex-in-Cursor session also discovered and used Superpowers. The requested project environment is therefore ready, with isolated non-project limitations documented below.

## Mac and host environment

- macOS: 27.0.1 (build 26A434)
- Hardware: Apple Silicon, `arm64`, Apple M5 Pro
- Active agent host: OpenAI Codex running inside Cursor, established from the active extension process at `/Users/david/.cursor/extensions/openai.chatgpt-26.908.40401-darwin-arm64/bin/macos-aarch64/codex`
- OpenAI Codex CLI: 0.154.0-alpha.6.2
- OpenAI Cursor extension directory: `openai.chatgpt-26.908.40401-darwin-arm64`
- Git repository: initialized locally on branch `main`; no commit was created
- Experimental multi-agent settings: not changed. The existing Codex feature listing already reported `multi_agent` enabled by the environment.

## Installed and verified tools

### Core tools

- Git 2.50.1 (Apple Git-155): `/usr/bin/git`
- Python 3.11.5, universal binary running natively as arm64: `/usr/local/bin/python3` (functional but not security-current; see Dependency freshness)
- Global pip 25.3: `/usr/local/bin/pip3`
- Node.js 26.10.0, arm64: `/Users/david/.local/bin/node` (current major, one patch behind 26.11.1 at final audit)
- npm/npx 11.19.1: `/Users/david/.local/bin/npm` and `/Users/david/.local/bin/npx` (npm registry latest was 12.2.0 at final audit)
- npm user prefix: `/Users/david/.local`
- SQLite CLI 3.54.0: `/usr/bin/sqlite3`
- Project virtual environment: `/Users/david/Cursor Project/FinTracka/.venv`
- Project virtual-environment pip: 26.2.1
- FastAPI: 0.143.0
- Pytest: 9.1.1
- Python Playwright: 1.63.0

Python dependencies are pinned in `requirements-dev.txt`. The virtual environment and generated Playwright artifacts are excluded by `.gitignore`.

TypeScript and React frameworks were intentionally not installed. The current Node/npm installation is sufficient to choose and initialize that stack later without prematurely selecting an application framework.

### Dependency freshness

- FastAPI 0.143.0: current PyPI release
- Python Playwright 1.63.0: current PyPI release
- Pytest 9.1.1: current PyPI release
- Playwright CLI 0.1.22: current npm registry release
- Project dependency integrity: `python -m pip check` returned `No broken requirements found`
- Project Playwright driver: native arm64 executable

Python 3.11.5 is not security-current. Python.org lists 3.11.17 as the current 3.11 security release and 3.14.8 as the current maintenance release with a macOS installer. The newer 3.11 security releases are source-only. Because 3.11.17 includes multiple security fixes relevant to archive handling, TLS, URL credentials, XML, and Unicode processing, do not process real financial data with the existing 3.11.5 interpreter. Install a current supported Python from the official macOS installer in a separate upgrade task, rebuild `.venv`, reinstall `requirements-dev.txt`, and rerun the complete smoke-test suite before switching.

Node 26.10.0 remains compatible and passed all checks, but the official release index reported 26.11.1 as current. The user-local executable is managed through `/Users/david/.hermes/node`; update it through its owning runtime rather than overwriting that symlink manually. Update npm together with that runtime and retest before selecting a TypeScript/React stack.

### Microsoft Playwright CLI and agent skill

Official source: <https://github.com/microsoft/playwright-cli>

- Playwright CLI 0.1.22: `/Users/david/.local/bin/playwright-cli`
- Global npm package: `/Users/david/.local/lib/node_modules/@playwright/cli`
- Codex-compatible agent skill: `/Users/david/.agents/skills/playwright-cli`
- Chromium runtime: Playwright Chromium revision 1247, Chrome for Testing 155.0.8059.12, arm64
- Browser application: `/Users/david/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app`
- Headless shell: `/Users/david/Library/Caches/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-mac-arm64/chrome-headless-shell`

The browser binaries were checked with `file`; both are native arm64 executables. A login-shell check found `playwright-cli`, Node, and npm on `PATH`, matching what a newly opened Cursor integrated terminal should receive.

Use an explicit bundled-browser selection on this machine:

```sh
playwright-cli open https://example.com --browser=chromium
```

The CLI's default system-Chrome channel currently launches and then fails with `TypeError: Cannot read properties of undefined (reading '_page')`. The installed bundled Chromium works correctly.

### Superpowers plugin

Official source: <https://github.com/obra/superpowers>

- Superpowers 6.4.2 installed and enabled through the native Codex plugin manager
- Location: `/Users/david/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2`
- Manifest: valid
- License: MIT
- Hooks: none
- Dependencies: none declared

The installed bundle contains 15 skills, including the requested `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, and `verification-before-completion` workflows. After restarting Cursor, the current Codex-in-Cursor session exposed all of them and successfully invoked the Superpowers startup, systematic-debugging, and verification-before-completion workflows during the final audit. No fallback copy or symlink was needed.

A separate limitation remains: repeated fresh, ephemeral `codex exec` CLI processes do not expose the Superpowers workflow names even though `codex plugin list --json` reports Superpowers 6.4.2 as installed and enabled. This is a standalone noninteractive CLI discovery difference; it does not affect the restarted Cursor environment for which this setup was requested.

### OpenAI security skills

Official source: <https://github.com/openai/skills>

- `security-best-practices`: `/Users/david/.codex/skills/security-best-practices` (13 files)
- `security-threat-model`: `/Users/david/.codex/skills/security-threat-model` (5 files)
- License in the source material: Apache-2.0

The official skill installer was attempted first but could not reach GitHub. Both complete skill directories were then copied, with destination-existence guards, from the existing clean local checkout at `/Users/david/.codex/vendor_imports/skills`. Its configured origin is `https://github.com/openai/skills.git`, its worktree was clean, and its source commit was `49f948faa9258a0c61caceaf225e179651397431` dated 2026-06-23.

A fresh Codex process explicitly discovered and invoked both installed skills. During the final audit, direct GitHub access returned remote `HEAD` `49f948faa9258a0c61caceaf225e179651397431`, exactly matching the clean local checkout and the complete installed skill directories. Online freshness is therefore verified. The upstream repository now describes itself as deprecated, but these were the exact official curated skills requested.

These skills cover secure Python/FastAPI and JavaScript/TypeScript/React development guidance plus structured threat modeling. They are useful controls, not a security guarantee. A finance application will still require explicit design and tests for encrypted provider tokens, least-privilege API access, sensitive-log redaction, local-data encryption and permissions, authentication and authorization, retention and deletion, transaction integrity, and incident handling.

### Built-in Skill Creator

- Official built-in skill: `/Users/david/.codex/skills/.system/skill-creator/SKILL.md`
- Status: present; no duplicate was installed

The proposed `finance-data-integrity` skill was not created, as requested.

### Anthropic skills

Official source: <https://github.com/anthropics/skills>

The requested `frontend-design` and `webapp-testing` skills were reviewed from their official source. They use the Agent Skills layout and are compatible with Codex's native skill discovery when installed as complete directories. `webapp-testing` includes supporting scripts such as `scripts/with_server.py` and depends on Python Playwright; that dependency is installed in this project. The upstream license is Apache-2.0.

- `frontend-design`: `/Users/david/.codex/skills/frontend-design`
- `webapp-testing`: `/Users/david/.codex/skills/webapp-testing`
- Source archive: `/Users/david/Downloads/skills-main.zip`
- Source archive SHA-256: `149d804241449c2a382079de32e37032ba6a18eb7621ec20217ce4974e1fbc21`

The official network installer had initially failed because the terminal could not resolve GitHub. The replacement archive supplied by the user had safe relative paths and contained the expected Anthropic repository metadata. After direct GitHub access recovered, every installed file in both skills was compared byte-for-byte with the corresponding current official `main` file and matched. Only the two requested skill directories were extracted. Neither destination existed, so nothing was overwritten.

All four bundled Python files parsed successfully before installation. The reviewed `with_server.py` helper uses only the Python standard library to start explicitly supplied local server commands, poll localhost ports, run a child test command, and terminate its child servers.

A fresh, ephemeral, read-only Codex process explicitly invoked `$frontend-design` and `$webapp-testing` and reported both as discovered. The installed web-testing helper then started a localhost-only Python HTTP server, Python Playwright opened it in headless Chromium and asserted the page title, and the helper stopped the server cleanly. No persistent test file or server process was left behind.

## Validation results

### Playwright CLI public-browser smoke test — PASS

Target: `https://demo.playwright.dev/todomvc/`

Using a named session and `--browser=chromium`, the test successfully:

- navigated to the public TodoMVC demonstration site;
- captured before-and-after accessibility/page snapshots;
- inspected page title and todo state;
- filled the new-todo form and pressed Enter;
- confirmed one todo with text `Verify FinTracka tooling`;
- saved and visually inspected a screenshot; and
- closed the isolated browser session.

Artifacts are under `/Users/david/Cursor Project/FinTracka/.playwright-cli/`, including `todomvc-smoke.png`, `todomvc-before.yml`, `todomvc-after.yml`, `verification-20261011.yml`, and `verification-20261011.png`. The final screenshot was visually inspected and showed the asserted `Recheck complete` todo.

No private site, login, saved browser profile, or credential was used. The test used Playwright's isolated bundled browser profile.

### Python foundation smoke test — PASS

Inside the project virtual environment:

- FastAPI 0.143.0 imported successfully.
- A temporary FastAPI `GET /health` endpoint returned the expected response through `TestClient`.
- Pytest 9.1.1 executed successfully.
- Python's SQLite module, backed by SQLite 3.42.0, created an in-memory database, inserted a row, and read it back.
- Python Playwright 1.63.0 launched native arm64 Chromium, navigated to public TodoMVC, submitted a todo, asserted the resulting state, and saved `python-todomvc-smoke.png`.

The FastAPI `TestClient` check emitted a non-failing Starlette warning about future `httpx` compatibility. It does not invalidate the smoke test and does not justify adding another direct dependency yet.

### Codex discovery checks

- `playwright-cli` agent skill: PASS in a fresh Codex process
- `security-best-practices`: PASS in a fresh Codex process
- `security-threat-model`: PASS in a fresh Codex process
- Built-in `skill-creator`: PASS in the active Codex environment
- Superpowers workflows in restarted Codex inside Cursor: PASS; all requested names are exposed, and applicable startup, debugging, and verification workflows were invoked during the final audit
- Superpowers workflows in separate noninteractive `codex exec`: FAIL; repeated fresh processes still report the names missing
- Anthropic `frontend-design`: PASS in a fresh Codex process
- Anthropic `webapp-testing`: PASS in a fresh Codex process; bundled server lifecycle helper and local Python Playwright test also passed

## Existing incompatibilities left unchanged

### Homebrew — FAIL, not required for this setup

An existing Homebrew installation is present under `/usr/local`, but it is an Intel installation whose bundled portable Ruby fails on this Apple Silicon Mac with `Bad CPU type in executable`. It was not modified because all required core tooling was already available through native, user-local, or project-local installations.

Repairing or replacing Homebrew is a separate global-machine change. If needed later, inspect and use only the current official Apple Silicon instructions from <https://brew.sh/> with explicit approval.

### Existing global Python Playwright — FAIL, left isolated

An unrelated global Python Playwright 1.58.0 installation has a wrong-architecture bundled driver and raises `OSError: [Errno 86] Bad CPU type in executable`. It is a dependency of the unrelated global `facebookdealfinder` package, so it was not removed or overwritten. FinTracka uses the working project-local `.venv` installation instead.

### Terminal GitHub access — PASS after recovery

Direct `git ls-remote` and official raw-file downloads succeeded during the final audit. This made it possible to verify the OpenAI security skills against the current remote commit and both Anthropic skills byte-for-byte against official `main`. No proxy, VPN, alternate DNS, mirror, or bypass route was used.

## Maintenance

Activate and restore the project environment with:

```sh
cd "/Users/david/Cursor Project/FinTracka"
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

Update the Playwright CLI and bundled browser deliberately with:

```sh
npm install -g @playwright/cli@latest
playwright-cli install-browser chromium
playwright-cli install --skills=agents --global
```

Review release notes and rerun both smoke tests before changing the pinned Python dependency versions. Use `codex plugin list` to inspect the Superpowers plugin. Treat skills as executable instructions: update them only from their official repositories, inspect changes, restart Cursor after updates, and rerun fresh-session discovery checks.

## Final status report

- PASS — Mac architecture and active Codex-in-Cursor host identified.
- PASS — Git, native Python, pip, Node.js, npm, SQLite, and package-manager inventory completed.
- PASS — Project Git repository, `.gitignore`, isolated virtual environment, and pinned Python development dependencies created.
- PASS — FastAPI, Pytest, SQLite, and project-local Python Playwright smoke-tested.
- PASS — Playwright CLI, Codex agent skill, and native arm64 Chromium installed.
- PASS — Browser navigation, snapshots/page inspection, form interaction, state assertion, screenshot capture, and isolated-session close tested on a public site.
- PASS — Playwright and both OpenAI security skills discovered and invoked by a fresh Codex process.
- PASS — Built-in OpenAI Skill Creator found; no duplicate and no custom finance skill created.
- PASS — Superpowers 6.4.2 installed and enabled; the restarted Codex-in-Cursor session exposes all requested workflows and invoked applicable Superpowers workflows during the final audit.
- PASS — Anthropic `frontend-design` and `webapp-testing` installed completely from the inspected local repository archive and discovered by a fresh Codex process.
- PASS — Anthropic's web-testing helper started and stopped a localhost-only test server while project-local Python Playwright completed a headless browser assertion.
- PASS — Direct GitHub access recovered; OpenAI security skills match the current official remote `HEAD`, and Anthropic skills match current official files byte-for-byte.
- PASS — FastAPI, Python Playwright, Pytest, and Playwright CLI match the latest package-registry releases; `pip check` reports no broken requirements.
- FAIL — Existing Intel Homebrew and unrelated global Python Playwright installations are incompatible with arm64; both were safely left unchanged and are not used by this project.
- FAIL — Playwright CLI's default system-Chrome channel fails; explicit `--browser=chromium` passes.
- FAIL — Standalone noninteractive `codex exec` does not expose Superpowers workflows, despite the plugin being installed/enabled and those workflows working in the restarted Cursor session.
- FAIL — Python 3.11.5 is not security-current. Upgrade to a current supported official Python and rebuild the virtual environment before handling real financial data.
- NOT VERIFIED — Node 26.11.1 and npm 12.2.0 upgrade compatibility, because the existing Hermes-managed runtime was not changed during this verification request.

Overall status: **PARTIAL — FUNCTIONAL, SECURITY UPDATE REQUIRED**. The requested Codex-in-Cursor skills, project dependencies, design tooling, security workflows, and browser tests work. Before using real financial data, upgrade Python from 3.11.5 to a current supported official release and rebuild/retest `.venv`. In the meantime, use project-local Python Playwright, pass `--browser=chromium` to Playwright CLI, and use Superpowers from Cursor rather than standalone `codex exec`. The unrelated global Homebrew and global Python Playwright architecture problems remain intentionally untouched.
