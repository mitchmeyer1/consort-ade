# Set up a new Linux worker

Use this checklist before `consort-cli setup`. Consort's headless CLI runs without Electron or a desktop session. Use Linux x64 or arm64, which have provider CLI targets in Consort. Run Consort, GitHub authentication, provider logins, and repository commands as the same Linux user. Use an account authorized to push branches, open PRs, read CI logs, and request reviews. Consort never merges.

## 1. Install the host tools

- Install a current [Node.js LTS release](https://nodejs.org/en/download/) for this user; Node 24 LTS meets the repository's Node 22.12+ minimum.
- Install pnpm 10 for compatibility with this repository's lockfile; the repository accepts pnpm 9+. See [pnpm installation](https://pnpm.io/installation).
- Install Git, curl, CA certificates, OpenSSH client, tar, and gzip. Consort uses tar to unpack provider CLI updates.
- Install [GitHub CLI using its Linux instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). Installing Git alone does not install GitHub CLI.
- Install the target repository's build tools and runtimes. For native Node dependencies, this commonly includes Python 3, make, and a C/C++ compiler; other repositories may also need Python, Go, Java, or database client tools. Read that repository's setup guide first.

For Debian/Ubuntu, these base packages cover Git and common native build tools; Node, GitHub CLI, Docker, and the browser are separate installations:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates openssh-client tar gzip build-essential python3
```

After installing Node as this user:

```bash
npm install --global pnpm@10
node --version
pnpm --version
git --version
gh --version
```

## 2. Authenticate GitHub and configure commits

For HTTPS Git remotes, use [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login) and its [Git credential helper](https://cli.github.com/manual/gh_auth_setup-git). Browser/device login can be completed from another computer. Approve organization SSO access when the organization requires it. The workflow scope allows the worker to push changes to GitHub Actions workflow files.

Replace the commit name and email below with the worker's real, approved Git identity:

```bash
gh auth login --hostname github.com --git-protocol https --scopes repo,read:org,workflow
gh auth setup-git
gh auth status
git config --global user.name "Consort Worker"
git config --global user.email "you@example.com"
```

For SSH remotes, configure this user's SSH key and GitHub host trust instead. GitHub CLI still needs its own authentication for PRs, contributor lookup, reviewer requests, and CI logs. A read-only deploy key cannot push the worker's changes. Do not run Consort as root to work around missing credentials.

## 3. Install Docker and a screenshot browser

- If the target repository uses containers, install [Docker Engine](https://docs.docker.com/engine/install/) and the [Docker Compose plugin](https://docs.docker.com/compose/install/), including Buildx when its builds require it.
- Follow [Docker's Linux user-access instructions](https://docs.docker.com/engine/install/linux-postinstall/) so the Consort user can run Docker without an interactive sudo prompt. Log out and back in after changing group membership. Docker group membership grants root-level host access; use a trusted worker account.
- Install Chrome or Chromium and its distribution's runtime libraries. The worker needs a browser for frontend screenshots; an API response or an error page cannot replace working frontend evidence.
- If browser discovery fails, set `CONSORT_CHROME` to the browser's absolute executable path in the environment used to start Consort. An exported variable in an SSH shell is not automatically inherited by a system service.

Check Docker only when the target repository needs it:

```bash
docker info
docker compose version
```

Find the installed browser:

```bash
command -v google-chrome || command -v chromium || command -v chromium-browser
```

## 4. Install Consort and clone the target repository

Install dependencies on Linux; do not copy macOS node_modules, provider binaries, or Keychain credentials to this machine. Keep optional dependencies enabled so the provider SDKs install their platform binaries.

```bash
git clone https://github.com/mitchmeyer1/consort-ade.git
cd consort-ade
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:cli
npm link --ignore-scripts
consort-cli help
consort-cli cli status
```

Ignoring install scripts skips Consort's desktop native builds. It does not install the target repository's dependencies; each task follows that repository's own setup instructions.

Clone the repository Consort will work on separately. Replace OWNER/REPO with its actual GitHub name:

```bash
cd ..
gh repo clone OWNER/REPO
```

Confirm its origin and base branch, install its documented prerequisites, and prepare its ignored root env file on this Linux machine. Supply the actual API keys needed to run the feature locally. Never put secret values in Slack or commit env files. If a task needs a missing key, Consort asks you to add the named variable to the root env file and confirm in the ticket's Slack thread before copying that variable into its worktree.

## 5. Run the setup wizard

Have these ready:

- The absolute path of the target repository and its base branch.
- At least one Claude Code or Codex account with available capacity, or a supported provider API key. Sign in on this machine during setup; do not assume your laptop's login is available here.
- A ClickUp API key and scope if scanning ClickUp; GitHub authentication covers GitHub issue scanning.
- A Slack bot token and the owner's Slack member ID. The bot needs chat:write, im:write, and im:history for DMs; channel-based use also needs the matching channel history permission. Reinstall the Slack app after changing scopes.
- Writable Consort state/worktree directories, enough disk and memory for the target repository's build/tests, and unused ports for each task's allocated block.
- Outbound access to GitHub, the package registries, Slack, provider APIs, and the target app's external services. The Slack reply loop polls over HTTPS; it does not need an inbound webhook.

```bash
consort-cli setup
consort-cli status
consort-cli run -d
consort-cli view
```

Setup checks GitHub access, agent binaries, the repository, Slack posting and reply access, and a dry-run push. Browser discovery is reported, but setup does not prove the target application's screenshots, Docker services, external API keys, or all build dependencies work. A real task must exercise those; blocked evidence asks for help instead of advancing.

## 6. Keep the worker running

The detached daemon survives closing the SSH terminal; it does not install a reboot service. For unattended operation across reboots, configure a systemd service running the foreground `run` command as the same Linux user. Use absolute paths to Node and the built CLI, set the working directory and PATH for the installed tools, and enable automatic restart. Set any required Consort/browser environment variables in that service. Version-manager shell initialization is not automatically loaded by systemd.

After a reboot, verify the daemon is running and the existing tickets have resumed. Avoid enabling the same scanner against the same tickets on another machine without deciding which machine owns the in-flight work; see [claims and moving machines](CLI.md#claims-with-many-boxes).
