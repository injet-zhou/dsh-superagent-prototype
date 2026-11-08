# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: standalone mode changes process-wide `PATH` and git settings (multi-repository mode uses scoped subprocess environments), and its process needs independent restarts and upgrades.
- **An agent repository account, on GitHub or Gitea.** The agent comments, pushes branches and opens pull requests through a CLI configured only for that account. Workers run in DeepSeek Harness for both providers.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Multiple local repositories

Keep the existing repository as `default`. In the sidebar, open **Superagent → Repositories → Add repository**, enter a name and stable ID, and confirm the service reload. When the repository appears, its Source settings open automatically; configure its repository account, permissions and models there. Use **Superagent settings** to switch between global and repository settings. Removing a repository from the overview stops its runtime and retains its files; the default repository stays in place.

For configuration-file-based deployments, the equivalent `dsh-superagent` profile configuration is:

```yaml
- id: dsh-superagent
  config:
    stateDir: /srv/dsh-superagent
    repositories:
      - id: backend
        name: Backend
      - id: frontend
        name: Frontend
```

Restart the service, open the panel, and select each repository in the header. On its Sources page set its GitHub/Gitea repository and CLI; then configure its allowed users, execution prepare command and optional prompts. Each repository initializes independently. A pending probe or hard failure in an additional repository does not delay configured repositories or hide the panel; its catalog entry shows starting/error and details. State and settings reads do not wait for setup. Mutations during active setup return 503 so a settings write cannot race an old startup snapshot; retry once setup has finished. A context that could not open its Store returns 503 for scoped operations while remaining visible in the catalog. Adding entries does not grant any user access to the new repository.

IDs must be unique lowercase identifiers starting with a letter (up to 48 characters); `default` is reserved. Keep IDs stable: each additional repository stores its SQLite database, locks, shims and workspaces under `<stateDir>/repositories/<id>`. The default repository keeps its original state directory, database, history and Sessions. Changing an ID creates a new repository context; removing one stops its runtime but retains its files. Do not copy an existing database into another repository context or repoint a populated context at a different repository/provider. Account changes and configuration changes currently restart the whole bundle, with the existing Assignment recovery behavior.

Each repository keeps its existing router Session and one local Worker per Ticket, launched only when work exists. The default repository's Execution `maxWorkers` is the global ceiling for automatic launch/wake dispatch, and each additional repository's setting can impose a lower local ceiling. All repositories share startup reservations and running-worker slots; automatically delivered human follow-ups also respect that ceiling in multi-repository mode. Direct user turns in Worker Sessions and background jobs handed off to a person are not admission-controlled by WorkerSlots, so this is not a hard cap on total running Sessions or processes. No remote workers, task splitting or cross-repository work routing are added.

Native event IDs and Issue/PR numbers can repeat because each repository has a separate Store. Additional repositories namespace generated Ticket IDs so their Worker Sessions cannot collide in the shared DSH host. Multi-repository Sessions use per-tool subprocess environments instead of changing process-wide PATH/git settings; unrelated Sessions keep their ambient environment. The bundled bash/pwsh tools are supported; managed interactive terminals are rejected using the Session identity even when opened from the Web UI outside tool execution; personal Sessions retain terminal access. Native Feishu event consumers receive sanitized Source environments without operator tokens, git configuration overrides or inherited DSH identity. All Sessions still run under the operator's OS account, so these boundaries do not provide hostile-code isolation.

In this version, give each repository distinct IM bot configurations and channel/chat destinations. Shared-channel request disambiguation is not implemented. The application rejects duplicate configured repositories and overlapping explicit IM destinations during settings saves. Feishu `otherChats: mentions` is rejected in multi-repository mode; use `otherChats: none` and explicit chat lists. Do not use alternate wrappers or token-file aliases for the same bot to bypass these checks.

The management catalog is `GET /orchestrator/api/repositories`; scoped `GET repositories` returns that same catalog with correct IDs, per-repository health/startup failures and global automatic-dispatch usage. Existing `/orchestrator/api/...` requests still address `default`; `/orchestrator/repositories/<id>/api/...` addresses one configured repository. Scoped routes use the same loopback and same-origin checks and never fall back to a different repository for an unknown ID. Select an explicit repository when writing through the API. The default state endpoint also aggregates child health errors for the service script and hourly check. The panel warns about errors in other repositories, shows global running/dispatch-limit information and remembers selection in sessionStorage. Inspect the scoped state for detailed local load.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- For GitHub: GitHub CLI (`gh`) 2.48 or later and a repository on github.com; GitHub Enterprise Server is not supported. For Gitea: Python 3.8+ and the bundled `scripts/dsh-gitea` CLI described below.
- To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. With Gitea, use its HTTPS clone URL. Standard SSH URLs for the configured host are rewritten through the instance root (including its reverse-proxy subpath); other SSH transports are disabled rather than using operator keys. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Agent Gitea account

Choose Gitea instead of the GitHub account steps above. GitHub CLI is not needed for a Gitea repository. The existing repository Source appears as **GitHub / Gitea**; its persisted kind, health entry, policy namespace, `github/` read resources and `DSH_SUPERAGENT_GITHUB_*` environment variables retain their historical names. They refer to the selected Gitea repository, not github.com. Each repository context watches one repository on one provider; contexts in the same deployment may use different providers.

1. Create a dedicated Gitea account with write access to the repository. Create an access token for that account with the permissions needed to read the account, notifications, repository, issues and reviews, and write issues and pull requests. Restrict repository access where your Gitea version supports it. Do not paste the token into chat or the panel.
2. Save a private JSON file outside the checkout, for example `/srv/agent/gitea.json`, owned by the agent's OS user with mode `0600`:

   ```json
   { "baseUrl": "https://git.example.com", "token": "<agent access token>" }
   ```

   `baseUrl` is the instance root, optionally including a reverse-proxy subpath such as `https://git.example.com/code`. HTTPS is required; HTTP is accepted only for loopback hosts such as localhost, 127.0.0.1 and ::1. The Source and CLI reject an /api/v1 suffix, query, fragment or embedded credentials. An invalid Source URL is reported as an instance-address problem, before any account probe.
3. Create an executable wrapper, for example `/srv/agent/bin/agent-gitea`, whose paths are absolute:

   ```sh
   #!/bin/sh
   exec python3 /srv/dsh-superagent/scripts/dsh-gitea --config /srv/agent/gitea.json "$@"
   ```

   The script is also included in the built package. Run the wrapper's `config`, `api user` and `api repos/<owner>/<name>` commands to check it. `config` prints only the instance URL. Keep this wrapper and configuration available to the DSH process and worker shells; the token is read from the file because DSH removes credential-shaped environment variables.
4. In **Sources → GitHub / Gitea**, choose provider **Gitea**, set the instance URL, `owner/name` repository and the wrapper's absolute path. Optionally set a commit email; the default is the account's returned email, or `<login>@noreply.<instance host>` if unavailable. Saving checks the CLI's instance URL, account and push permission, then restarts. GitHub installations need no new settings.
5. Configure the allowed repository usernames under **Eval → On each Source**, as for GitHub. Feishu configuration and authorization are independent and work with either provider. `source:github` and `policy.sources.github` remain the management API keys.
6. Use the ordinary worktree prepare command with a clone whose `origin` is the Gitea HTTPS URL. Workers get an account-isolated `gitea` shim and Git credential helper scoped to the configured instance and repository. `gh` fails with a Gitea-specific instruction, preventing accidental GitHub writes. The helper refuses credentials for another host, protocol or repository. Standard git@host: and ssh://git@host/ origins are rewritten to the configured instance root, preserving any HTTP proxy prefix. Unrecognized SSH URLs (including custom SSH ports) fail with SSH transport disabled; they do not fall back to operator keys.

To use another repository or provider, add a `repositories` context; to replace the default context's repository or provider, start with a fresh state directory. Do not repoint a populated context at a different repository or provider: its existing Thread, Trigger and PR identifiers belong to that context and are not a migration between hosting services. Changing provider, URL, account, repository or commit email re-runs setup; polling and admission switches still apply normally.

#### Gitea compatibility

Validated against Gitea 1.24.6 using its [REST API](https://docs.gitea.com/api/). Check the API capabilities of your deployed version before enabling additional workflows.

- The adapter uses REST `/api/v1` and polling, without a public webhook endpoint or GitHub service dependency. It reads mentions through repository notifications, subscribed Issue/PR conversation comments, reviews and review comments, and follows agent-authored PR branches until merged or closed. It preserves reply markers across retries and Gitea URLs in panel links and Feishu terminal notices.
- Source-wide observation switches also work: Issue/PR lists and conversation/review comments are polled with timestamp cursors. Gitea can cap page sizes; the CLI follows the server's `Link` headers, and a failed page fails the read before cursor advancement. Review observation still requires multiple HTTP requests per recently updated PR because Gitea has no equivalent repository-wide inline-comment endpoint. These requests run in one Python subprocess, skip reviews with zero comments, and reuse HTTP response bodies only after the server validates their ETag. An unchanged parent PR timestamp alone never authorizes cache reuse. Cached responses are scoped to instance, repository, login and CLI, stored privately under the state directory, and limited to 512 entries. The normalized stream also honors If-None-Match. Each CLI/API operation has a 30-second deadline and a 128-request budget; the whole Gitea polling round has a 45-second deadline. A failed or incomplete stream retains its cursor for retry. If the budget repeatedly fails on a large repository, narrow source-wide observation rather than increasing an unbounded poll; subscribed ticket discussions remain independently available. On-demand model-facing pages stop fetching once the requested window is full.
- CI covers **commit statuses published to Gitea**. GitHub Check Runs and native Gitea Actions job/log APIs are not read. If your CI runs in Gitea Actions or elsewhere, publish commit statuses to make them observable. An empty status list is shown as unavailable, never as a successful build.
- Review feedback is delivered with its file and diff_position. A diff position is explicitly labeled as not a file line number; line is included only when the instance actually returns line or original_line. Replies go to the PR conversation with a reference to the review comment; GitHub inline-reply and GraphQL thread-resolution operations are not emulated. Resolve remaining threads manually or supply instance-specific instructions for supported REST operations.
- The repository skill gives Gitea REST commands for reading context, creating PRs and closing superseded PRs. Automatic merge and GitHub-specific reviewer coauthor commands are disabled by the default Gitea instructions; people merge. Existing customized prompts must also be reviewed for GitHub-only commands. This does not change the DSH Executor or add another coding-agent runtime.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

### Discord bot (optional)

Discord works with GitHub or Gitea and can run alongside Feishu. The worker remains a DSH Session. This Source uses Discord REST API v10 polling, so no public webhook endpoint or Gateway connection is required.

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Message Content Intent** to read non-mention history and receive-all channels. Invite the bot using the `bot` OAuth2 scope with **View Channel**, **Read Message History**, **Send Messages**, and **Send Messages in Threads** where needed. The bot must have access to each configured thread; add it to private threads. Use a dedicated bot token, never a user account token or webhook URL.
2. Outside the repository, create a private JSON file owned by the service's OS user, for example `/srv/agent/discord.json` with mode `0600` (or stricter) and content `{"token":"<bot token>"}`. Enter only its absolute path in settings. On POSIX, the host rejects token files granting any access to the group or other users, with a chmod 600 remediation message. The host reads the file and sends the token exclusively to `https://discord.com/api/v10` with Bot authentication, refuses redirects, and never exports the token into worker environment variables or command arguments. Agents still share the operator's OS user, so file permissions are a deployment guardrail, not a process isolation boundary.
3. Uncomment `dsh-superagent-discord` in the example profile. After restart, set **Sources → Discord → Bot token file** and add the IDs of the text channels or native threads to receive. Enable Discord **Developer Mode**, then **Copy Channel ID** on each channel/thread. Threads must be listed individually: adding a parent channel does not discover its threads. Guild text/announcement channels and announcement/public/private threads are supported. DMs, voice channels and forum containers are not.
4. Set each row to **@ only** (the default choice) or **All messages**. Under **Eval → On each Source → Discord**, list the numeric **user IDs** allowed to originate work. Copy User ID from Discord; nicknames and usernames never grant authorization. An allowed user's message mentioning the bot can become an explicit request. In **@ only** mode, only messages that mention the bot are ingested as Triggers: unmentioned chatter cannot become a follow-up or resume an ended Ticket. The REST endpoint still returns channel messages so the adapter can check mentions; skipped messages advance the read cursor without entering the Engine. Context/history reads can include those messages as context. **All messages** mode retains the existing admission/rule and ticket-follow-up policy for unmentioned messages. Bot/webhook messages are marked non-human. There is no member-roster sync.
5. Send `@<bot> <request>` from an allowed user in a configured channel or thread. The next poll sends it through the same assessment, Ticket and DSH workflow and replies in that Discord channel, referencing the original message. Each channel or native thread is one shared conversation; use dedicated native threads to separate tasks. Removing a configured channel stops its outgoing replies through the existing outbox policy checks.

A `source:discord` settings block is:

```json
{"enabled":true,"config":{"tokenFile":"/srv/agent/discord.json","channels":[{"channelId":"123456789012345678","listen":"mentions"}],"pollIntervalMs":15000,"readPageSize":50}}
```

The Policy adds `"discord":{"allowed":[{"id":"234567890123456789","name":"Alice"}]}` under `policy.sources`; admission rows use channel/thread IDs. A token-file change is panel-only, checked with `GET users/@me`, and restarts setup. An unset token file or invalid Discord account pauses only Discord and is reported on its Source card; a setup recheck retries an account failure. The service CLI includes discordProblem as the discord field in status JSON and explains Discord setup failures during start, without treating a paused optional Source as a lasting component error. Worker environment variables contain only `DSH_SUPERAGENT_DISCORD_BOT` and, for a Discord-origin ticket, `DSH_SUPERAGENT_DISCORD_CHANNEL`.

On first activation of a channel, the host records Discord's last_message_id (or snapshots the latest message when metadata omits it), using 0 for an empty channel, and receives subsequent messages; it does not replay pre-existing history. On later starts it resumes the durable cursor, including messages sent while the service was stopped. Each round reads at most the next 100 messages per channel, orders snowflakes without numeric precision loss, and advances after each durable Engine receipt. Backlogs continue on subsequent rounds; a failed page or Engine receipt retains the corresponding cursor. Messages are validated individually: an identifiable malformed item is skipped with its ID reported in health and the cursor advances past it; missing/invalid ID or channel information fails the page because it cannot be safely checkpointed. A round has a 45-second budget, with round-robin channel progress so slow channels do not permanently starve later ones. Reaching that round budget reports ready with a continuation detail rather than a Source error; genuine HTTP or receipt failures still report error. Each REST operation has a 30-second budget including queue and rate-limit waits. Bot requests are serialized across Source reads, assessments and replies; response reset headers and HTTP 429 retry delays pause subsequent requests. An HTTP 401 stops the listener until the bot is corrected and dsh-superagent restarted. HTTP 403 is a retryable permission error; HTTP 404 on send marks the channel gone.

Replies disable automatic user/role/everyone mentions, use a stable Discord nonce with `enforce_nonce`, and record a private receipt under `<stateDir>/discord-outbox`. Keep that directory with the database across restarts. At most once every five minutes during sends, receipt maintenance removes entries older than 30 days or beyond the newest 1000 only when the canonical Outbox confirms their outgoing ID is sent. Pending, unknown and legacy receipts are retained; deleting the transport file never deletes the canonical sent record. Discord only enforces nonce uniqueness for a few minutes: a crash after the remote send but before the local receipt can still duplicate a reply if recovery occurs after that window. Messages are limited to 100 words and 2000 characters; rewrite longer updates rather than splitting them. The Source skill exposes bounded message/parent/history reads through `orchestrator_read`, and replies through `orchestrator_reply`. Attachment links are preserved, without automatic downloads. Message edits/deletions, reactions, slash commands, thread discovery and DM discovery are outside this adapter's scope. See the official [message endpoints](https://docs.discord.com/developers/resources/message) and [rate-limit rules](https://docs.discord.com/developers/topics/rate-limits).

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu or Discord, also enable the corresponding `dsh-superagent-feishu` or `dsh-superagent-discord` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, plus optional `discordProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history`, `discord` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`, `source:discord`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the selected repository and the agent's push access, writes the worker environment, and checks that git uses the selected provider's agent credential helper. A Feishu or Discord setup failure disables only that Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` or `gitea` runs the selected repository CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the credential helper for github.com or the configured Gitea instance, rewrites standard SSH addresses through the selected HTTP(S) instance root, and defines Git LFS filters. Gitea uses HTTPS origins and a helper that verifies the repository path. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN`, `GITHUB_TOKEN` and `GITEA_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed repository account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent repository CLI is not set.` | Set the agent's CLI on the GitHub / Gitea card |
| `The agent repository CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent repository CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `Set a valid Gitea instance root URL` | Set the instance root on Sources: HTTPS, or HTTP only on loopback. Remove /api/v1, credentials, query and fragment; this is checked before the CLI account |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The repository Source names no repository.` | Set the repository, `owner/name`, on the GitHub / Gitea card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the repository credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
