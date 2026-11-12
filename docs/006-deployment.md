# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: standalone mode changes process-wide `PATH` and git settings (multi-repository mode uses scoped subprocess environments), and its process needs independent restarts and upgrades.
- **An agent repository account, on GitHub, Gitea or self-managed GitLab.** The agent comments, pushes branches and opens pull requests through a CLI configured only for that account. Workers run in DeepSeek Harness for all repository providers.
- **Optional:** a Feishu, Discord or WeCom chat bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Security boundary

Run the service under a dedicated OS account with access only to its repositories and bot accounts. Workers and their shell commands run as that same account: private files, separate profiles, repository scopes and command shims do not isolate credentials from a compromised Worker. The loopback panel and its same-origin checks also do not authenticate local processes. Deploy repositories with different trust requirements in separate OS accounts or machines; sharing one service is appropriate only when they share a trust boundary. Isolating Workers from the service's own bot credentials requires a separate execution identity and a credential or messaging broker; this bundle does not provide that architecture.

Keep credential files outside repository checkouts. Gitea, GitLab, Discord and WeCom reject group/other-readable credential files on POSIX; use mode `0600` or stricter. Diagnostic errors retain fixed operational messages and numeric response codes rather than raw API errors or CLI output, since those can echo credentials. Rotate any secret previously exposed in the panel, logs, screenshots or chat, and update the service's private file. Dependency overrides in this source checkout do not update an independently installed DSH host; keep that host and its dependencies patched too.

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

Restart the service, open the panel, and select each repository in the header. On its Sources page set its GitHub/Gitea/GitLab repository and CLI; then configure its allowed users, execution prepare command and optional prompts. Each repository initializes independently. A pending probe or hard failure in an additional repository does not delay configured repositories or hide the panel; its catalog entry shows starting/error and details. State and settings reads do not wait for setup. Mutations during active setup return 503 so a settings write cannot race an old startup snapshot; retry once setup has finished. A context that could not open its Store returns 503 for scoped operations while remaining visible in the catalog. Adding entries does not grant any user access to the new repository.

IDs must be unique lowercase identifiers starting with a letter (up to 48 characters); `default` is reserved. Keep IDs stable: each additional repository stores its SQLite database, locks, shims and workspaces under `<stateDir>/repositories/<id>`. The default repository keeps its original state directory, database, history and Sessions. Changing an ID creates a new repository context; removing one stops its runtime but retains its files. Do not copy an existing database into another repository context or repoint a populated context at a different repository/provider. Account changes and configuration changes currently restart the whole bundle, with the existing Assignment recovery behavior.

Each repository keeps its existing router Session and one local Worker per Ticket, launched only when work exists. The default repository's Execution `maxWorkers` is the global ceiling for automatic launch/wake dispatch, and each additional repository's setting can impose a lower local ceiling. All repositories share startup reservations and running-worker slots; automatically delivered human follow-ups also respect that ceiling in multi-repository mode. Direct user turns in Worker Sessions and background jobs handed off to a person are not admission-controlled by WorkerSlots, so this is not a hard cap on total running Sessions or processes. No remote workers, task splitting or cross-repository work routing are added.

Native event IDs and Issue/PR numbers can repeat because each repository has a separate Store. Additional repositories namespace generated Ticket IDs so their Worker Sessions cannot collide in the shared DSH host. Multi-repository Sessions use per-tool subprocess environments instead of changing process-wide PATH/git settings; unrelated Sessions keep their ambient environment. The bundled bash/pwsh tools are supported; managed interactive terminals are rejected using the Session identity even when opened from the Web UI outside tool execution; personal Sessions retain terminal access. Native Feishu event consumers receive sanitized Source environments without operator tokens, git configuration overrides or inherited DSH identity. All Sessions still run under the operator's OS account, so these boundaries do not provide hostile-code isolation.

One Feishu, Discord or WeCom bot can serve multiple repositories. Select each repository in the panel and configure its Source with the same bot CLI, token-file path or secret-file path, then list only that repository's groups or Discord channels/threads. For example, `backend` can use the bot in `#backend` and `frontend` in `#frontend`; each message uses the receiving repository's Policy, Tickets, Sessions and reply destination. The application rejects duplicate repository subscriptions and groups/channels assigned to more than one repository, including during settings saves.

When sharing a Feishu or WeCom bot, set **Other chats/groups → Not received** and use explicit group lists. Feishu requires this in every multi-repository deployment. Enable **Direct messages** in at most one repository using that bot, since private messages have no group/channel to select a repository; turn it off in the others, or in all repositories to use groups only. Unassigned groups remain visible as filtered messages in **Getting started → Groups and people** and cannot start work until assigned. Use the same CLI/file path for a shared bot, rather than aliases. Shared WeCom configurations must also use the same WebSocket address.

Feishu repositories share one live event consumer and retain their own history cursors. WeCom repositories share one WebSocket connection. Disabling or removing one repository's Source leaves other subscribers connected; the last subscriber stops the connection. Discord repositories poll their own explicit channel lists with separate durable cursors, sharing the bot's REST queue and rate-limit waits across reads, reactions and replies. Allowed users and admission rules remain separate for each repository.

The management catalog is `GET /orchestrator/api/repositories`; scoped `GET repositories` returns that same catalog with correct IDs, per-repository health/startup failures and global automatic-dispatch usage. Existing `/orchestrator/api/...` requests still address `default`; `/orchestrator/repositories/<id>/api/...` addresses one configured repository. Scoped routes use the same loopback and same-origin checks and never fall back to a different repository for an unknown ID. Select an explicit repository when writing through the API. The default state endpoint also aggregates child health errors for the service script and hourly check. The panel warns about errors in other repositories, shows global running/dispatch-limit information and remembers selection in sessionStorage. Inspect the scoped state for detailed local load.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- For GitHub: GitHub CLI (`gh`) 2.48 or later and a repository on github.com; GitHub Enterprise Server is not supported. For GitLab: Python 3.8+ and the bundled `scripts/dsh-gitlab` CLI described below. For Gitea: Python 3.8+ and the bundled `scripts/dsh-gitea` CLI described below.
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

### Agent GitLab account

Use these steps for self-managed GitLab, including instances behind a reverse-proxy subpath. The repository Source is **GitHub / Gitea / GitLab**; its saved id, Policy namespace `policy.sources.github`, read resources and `DSH_SUPERAGENT_GITHUB_*` variables retain their historical names. Worker execution remains in DSH Sessions. Different repository contexts may select different providers.

1. Create a dedicated agent account with Developer or higher access to the project and permission to push ticket branches. Give it a personal access token with `api` scope (which also permits Git over HTTPS). Do not put the token in chat, the panel or the checkout.
2. Save `/srv/agent/gitlab.json` outside the checkout, owned by the agent's OS user with mode `0600`:

   ```json
   { "baseUrl": "https://gitlab.example.com/code", "token": "<agent access token>" }
   ```

3. Create an executable wrapper `/srv/agent/bin/agent-gitlab` using absolute paths:

   ```sh
   #!/bin/sh
   exec python3 /srv/dsh-superagent/scripts/dsh-gitlab --config /srv/agent/gitlab.json "$@"
   ```

4. In **Sources → GitHub / Gitea / GitLab**, select **GitLab (self-managed)**, enter the instance root, project path (for example `group/subgroup/project`) and wrapper path. Omit `/api/v4` from the instance root. HTTPS is required except on loopback; private certificate authorities can be configured through Python's `SSL_CERT_FILE`. TLS verification stays enabled. CLI and Source URLs must agree. Saving checks the account and project/group access level, and refuses archived or read-only projects. Optional `commitEmail` overrides the account email.
5. Add allowed GitLab usernames under the repository Source's Policy and configure the ordinary worktree prepare command with the GitLab HTTPS clone URL. Workers receive an isolated `gitlab` CLI and project-scoped Git credential helper; `gh`, `gitea` and `glab` fail with a provider instruction. Standard SSH origins are rewritten through the configured HTTP root; other SSH transports fail without using operator keys.

#### GitLab compatibility

The adapter uses REST v4 [projects](https://docs.gitlab.com/api/projects/), [to-dos](https://docs.gitlab.com/api/todos/), [notes](https://docs.gitlab.com/api/notes/), [discussions](https://docs.gitlab.com/api/discussions/) and [commit statuses](https://docs.gitlab.com/api/commits/). Local integration tests exercise the bundled CLI against a simulated GitLab API; a live self-managed instance has not been tested.

- Pending account to-dos identify mentioned Issue/MR conversations. The adapter leaves them pending and checks the conversations from their own saved cursors; it does not mark account notifications done. Already subscribed conversations are polled independently. Repository-wide Issue/MR and comment observation is optional and starts when enabled. Body edits do not become new requests. System notes never authorize work.
- Basic Issue, MR and note authors omit the account's bot flag. The adapter reads [user details](https://docs.gitlab.com/api/users/#retrieve-a-single-user) by numeric ID before assigning human authority, reusing each identity only within the current API operation. A failed lookup, missing bot flag or mismatched identity fails the read and retains its cursor for retry. Listed bots remain inferred candidates; an unlisted bot cannot use a human allowed-list entry or explicit admission cell to originate work.
- GitLab Issue `#1` and MR `!1` have independent IID sequences. Internal Issue thread IDs are `github:issue-1`, while MR thread IDs are `github:1`; replies, subscriptions, retries and cursors stay separate. Model reads use `github/issues/1` and `github/pulls/1`, with `issue-1` also accepted in Issue resources. Worker reports use the native MR IID as `pr_number`; source environment variables expose native IIDs and `refs/merge-requests/<iid>/head`.
- Discussion notes preserve authors, root/reply IDs and explicit diff file/line information. Host acknowledgements and reports are posted on the Issue/MR conversation with retry markers. Workers can reply directly through the documented Discussions API. Approval rules and automatic merge are left to people; GitHub GraphQL and reviewer coauthor commands do not apply.
- CI reads published commit statuses, including GitLab pipeline job statuses exposed by that endpoint. All pages are collected and sorted by descending status ID before selecting the newest result for each job name, so an older pipeline's success cannot mask a newer failure or running job. It does not fetch raw job logs or implement approval-rule APIs. An empty status list is unavailable, never a successful build.
- Pagination follows GitLab `Link` or `X-Next-Page` headers, rejects other instances and does not follow redirects with credentials. Reads fail before cursor advancement when incomplete. Each CLI subprocess has a 30-second deadline and 128-request budget, each adapter operation a shared 30-second deadline, and each full polling round a 45-second deadline. Broad observation may require many requests on large projects; narrow observation when repeated deadlines occur. Normalized streams provide ETags without trusting unchanged parent metadata.
- Keep existing populated contexts bound to their original provider and repository; add a new context to move to GitLab. Review customized prompts for provider-specific commands.

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

Discord works with GitHub, Gitea or GitLab and can run alongside Feishu. The worker remains a DSH Session. This Source uses Discord REST API v10 polling, so no public webhook endpoint or Gateway connection is required.

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Message Content Intent** to read non-mention history and receive-all channels. Invite the bot using the `bot` OAuth2 scope with **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, and **Add Reactions** where needed. The bot must have access to each configured thread; add it to private threads. Use a dedicated bot token, never a user account token or webhook URL.
2. Outside the repository, create a private JSON file owned by the service's OS user, for example `/srv/agent/discord.json` with mode `0600` (or stricter) and content `{"token":"<bot token>"}`. Enter only its absolute path in settings. On POSIX, the host rejects token files granting any access to the group or other users, with a chmod 600 remediation message. The host reads the file and sends the token exclusively to `https://discord.com/api/v10` with Bot authentication, refuses redirects, and never exports the token into worker environment variables or command arguments. Agents still share the operator's OS user, so file permissions are a deployment guardrail, not a process isolation boundary.
3. Uncomment `dsh-superagent-discord` in the example profile. After restart, set **Sources → Discord → Bot token file** and add the IDs of the text channels or native threads to receive. Enable Discord **Developer Mode**, then **Copy Channel ID** on each channel/thread. Threads must be listed individually: adding a parent channel does not discover its threads. Guild text/announcement channels and announcement/public/private threads are supported. DMs, voice channels and forum containers are not.
4. Set each row to **@ only** (the default choice) or **All messages**. Under **Eval → On each Source → Discord**, list the numeric **user IDs** allowed to originate work. Copy User ID from Discord; nicknames and usernames never grant authorization. An allowed user's message mentioning the bot can become an explicit request. In **@ only** mode, only messages that mention the bot are ingested as Triggers: unmentioned chatter cannot become a follow-up or resume an ended Ticket. The REST endpoint still returns channel messages so the adapter can check mentions; skipped messages advance the read cursor without entering the Engine. Context/history reads can include those messages as context. **All messages** mode retains the existing admission/rule and ticket-follow-up policy for unmentioned messages. Bot/webhook messages are marked non-human. There is no member-roster sync.
5. Send `@<bot> <request>` from an allowed user in a configured channel or thread. The next poll sends it through the same assessment, Ticket and DSH workflow and replies in that Discord channel, referencing the original message. A person's mention also gets a 👀 reaction as a receipt, whether or not the Policy later ignores it, and ⏳ once a Ticket is dispatched from it. Each channel or native thread is one shared conversation; use dedicated native threads to separate tasks. Removing a configured channel stops its outgoing replies through the existing outbox policy checks.

A `source:discord` settings block is:

```json
{"enabled":true,"config":{"tokenFile":"/srv/agent/discord.json","channels":[{"channelId":"123456789012345678","listen":"mentions"}],"pollIntervalMs":15000,"readPageSize":50}}
```

The Policy adds `"discord":{"allowed":[{"id":"234567890123456789","name":"Alice"}]}` under `policy.sources`; admission rows use channel/thread IDs. A token-file change is panel-only, checked with `GET users/@me`, and restarts setup. An unset token file or invalid Discord account pauses only Discord and is reported on its Source card; a setup recheck retries an account failure. The service CLI includes discordProblem as the discord field in status JSON and explains Discord setup failures during start, without treating a paused optional Source as a lasting component error. Worker environment variables contain only `DSH_SUPERAGENT_DISCORD_BOT` and, for a Discord-origin ticket, `DSH_SUPERAGENT_DISCORD_CHANNEL`.

On first activation of a channel, the host records Discord's last_message_id (or snapshots the latest message when metadata omits it), using 0 for an empty channel, and receives subsequent messages; it does not replay pre-existing history. On later starts it resumes the durable cursor, including messages sent while the service was stopped. Each round reads at most the next 100 messages per channel, orders snowflakes without numeric precision loss, and advances after each durable Engine receipt. Backlogs continue on subsequent rounds; a failed page or Engine receipt retains the corresponding cursor. Messages are validated individually: an identifiable malformed item is skipped with its ID reported in health and the cursor advances past it; missing/invalid ID or channel information fails the page because it cannot be safely checkpointed. A round has a 45-second budget, with round-robin channel progress so slow channels do not permanently starve later ones. Reaching that round budget reports ready with a continuation detail rather than a Source error; genuine HTTP or receipt failures still report error. Each REST operation has a 30-second budget including queue and rate-limit waits. Bot requests are serialized across Source reads, assessments and replies; response reset headers and HTTP 429 retry delays pause subsequent requests. An HTTP 401 stops the listener until the bot is corrected and dsh-superagent restarted. HTTP 403 is a retryable permission error; HTTP 404 on send marks the channel gone. Reactions are best effort: a refused receipt reaction is reported in Source health; it neither fails the poll nor keeps the Trigger from being stored and its cursor advanced, and a Ticket is never failed because its processing reaction could not be added.

Replies disable automatic user/role/everyone mentions, use a stable Discord nonce with `enforce_nonce`, and record a private receipt under `<stateDir>/discord-outbox`. Keep that directory with the database across restarts. At most once every five minutes during sends, receipt maintenance removes entries older than 30 days or beyond the newest 1000 only when the canonical Outbox confirms their outgoing ID is sent. Pending, unknown and legacy receipts are retained; deleting the transport file never deletes the canonical sent record. Discord only enforces nonce uniqueness for a few minutes: a crash after the remote send but before the local receipt can still duplicate a reply if recovery occurs after that window. Messages are limited to 100 words and 2000 characters; rewrite longer updates rather than splitting them. The Source skill exposes bounded message/parent/history reads through `orchestrator_read`, and replies through `orchestrator_reply`. Attachment links are preserved, without automatic downloads. Message edits/deletions, reactions other than the bot's own receipt and processing marks, slash commands, thread discovery and DM discovery are outside this adapter's scope. See the official [message endpoints](https://docs.discord.com/developers/resources/message) and [rate-limit rules](https://docs.discord.com/developers/topics/rate-limits).

### WeCom intelligent robot (optional)

A WeCom (企业微信) intelligent robot (智能机器人) works with GitHub or Gitea and can run alongside Feishu and Discord. It uses the robot's official WebSocket long connection through `@wecom/aibot-node-sdk`, so no public callback URL or gateway is needed. The worker remains a DSH Session.

1. In the WeCom admin console, create an intelligent robot and note its **robot ID** and **secret**. Add the robot to each group where people may ask it, and tell people they may message it directly. WeCom delivers only group messages that mention the robot; a direct message is addressed to it.
2. Outside the repository, create a private JSON file owned by the service's OS user, for example `/srv/agent/wecom.json` with mode `0600` (or stricter) and content `{"botId":"<robot id>","secret":"<secret>"}`. Enter only its absolute path in settings. On POSIX, the host rejects files granting any access to the group or other users, with a chmod 600 remediation message. The host reads the file to verify the robot and again when connecting; the secret never enters settings, worker environment variables or command arguments. Agents still share the operator's OS user, so file permissions are a deployment guardrail, not a process isolation boundary.
3. Enable `dsh-superagent-wecom` in the profile. After restart, set **Sources → WeCom → Robot secret file**, and optionally **Private deployment WebSocket address** for a deployment whose admin console shows a different `wss://` address. Enter only the path, never the secret. A secret-file or WebSocket-address change is panel-only and restarts setup.
4. Choose the receiving scopes. **Direct messages** receives all single conversations with the robot. Each row under **Groups** gets its own admission row and display name; enable **Other groups → @ only** to receive mentions from groups that are not listed. To avoid looking up IDs, open **Getting started → Groups and people**, save the robot configuration, mention the bot in the target group, then choose the group and sender from the received message and save. Group-filtered messages are discoverable too; **Other groups** can remain disabled. A group message is always a mention because WeCom delivers no other group messages.
5. Under **Eval → On each Source → WeCom**, list the WeCom **UserIDs** allowed to originate work. Display names never grant authorization. An allowed user's direct message, or a mention in a received group, can become an explicit request.

A `source:wecom` settings block is:

```json
{"enabled":true,"config":{"secretFile":"/srv/agent/wecom.json","wsUrl":"","chats":[{"chatId":"<group id>","name":"Team"}],"otherChats":"mentions","directMessages":true}}
```

The Policy adds `"wecom":{"allowed":[{"id":"<userid>","name":"Alice"}]}` under `policy.sources`; admission rows are each listed group, `other` for unlisted groups, and `direct`. A secret-file change is panel-only, checked by reading the private file, and restarts setup. An unset secret file or invalid robot check pauses only WeCom and is reported on its Source card; a setup recheck retries an account failure. The service CLI includes `wecomProblem` as the `wecom` field in status JSON and explains WeCom setup failures during start, without treating a paused optional Source as a lasting component error. Worker environment variables contain only `DSH_SUPERAGENT_WECOM_BOT` and, for a WeCom-origin ticket, `DSH_SUPERAGENT_WECOM_CHAT`.

Replies are Markdown sent through the robot's active-send channel to the group chat ID or the person's UserID, and record a private receipt under `<stateDir>/wecom-outbox`. Keep that directory with the database across restarts. WeCom has no server-side idempotency key for active sends: at most once every five minutes, receipt maintenance removes entries older than 30 days or beyond the newest 1000 only when the canonical Outbox confirms their outgoing ID is sent, so a crash after WeCom accepted a message but before its local receipt was written can duplicate that reply. Replies are limited to 100 words. A connection drop is retried by the SDK with exponential backoff; if another process connects with the same robot, WeCom disconnects this one and the Source reports an error that needs the other client stopped and dsh-superagent restarted. Only one service should use a robot.

WeCom's WebSocket channel has no message-history API. The Source stores the callbacks it receives: a direct or group Thread therefore contains only messages received while the Source was connected, and a reconnect or downtime gap is not backfilled. `trigger/<trigger-id>` and `thread/<thread-key>` expose what was stored; there is no `wecom/` original-message resource. Text, voice transcripts, mixed text/image items, and image/file/video labels are kept; attachments are not downloaded, and quoted text is included as context. Enter-chat, template-card and feedback events are not ingested. Message edits, deletions and recalls are not observed.

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

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, Discord or WeCom, also enable the corresponding `dsh-superagent-feishu`, `dsh-superagent-discord` or `dsh-superagent-wecom` entry there. The `webserver` entry sets the panel's port.

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

For testing an unmerged feature, install the plugin from a dedicated worktree and run the service script from that same worktree. Keep `stateDir` unchanged and retain that worktree; switching or building the main checkout then cannot replace the running feature build.

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

On Linux, Node may appear as `MainThread` in `ps`; the script recognizes that name as well as `node` and `dsh`, and still checks the exact profile and excludes plugin-management commands.

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
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, plus optional `discordProblem` and `wecomProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
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
| `memory`, `memory-capture`, `memory-consolidate` | Repository memory degradation, durable capture and consolidation backlog; errors do not change Runtime readiness |
| `github`, `feishu`, `history`, `discord`, `wecom` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `memory`: `{"enabled": false, "retrieval": true, "autoCapture": false, "dreaming": false, "dailyCallBudget": 0, "consolidationReservedCalls": 0, "analyzerModel": null}`. This independent repository setting is available through the management API and requires its own revision. Start by setting `enabled: true`; no model call is made. Read its revision from `GET settings` → `blocks.memory`. Save at `PUT settings/memory` using the same revisioned envelope as other blocks; use `/orchestrator/repositories/<id>/api/settings/memory` for an additional repository. Worker tools cannot change these settings. Disabling retains all records and aborts in-flight analysis. Schema 12 upgrades the existing database in place; restoring an older binary requires restoring the pre-upgrade database backup too.

Settings → Memory exposes the repository's feature switches, explicit model and daily call limit. The Memory tab provides search, evidence, revision history, operator confirmation, stale/retract actions, maintenance health and manual consolidation/rebuild. Management remains available with the feature disabled so retained records can be inspected. A confirmed candidate receives a fresh human attestation bound to the exact claim and review revision; a model cannot generate that attestation.

To explicitly enable model-backed Capture, also set `autoCapture: true`, `analyzerModel: {"provider": "<provider>", "model": "<model>"}` and a positive `dailyCallBudget`. Enable `dreaming: true` separately for consolidation: five candidates trigger a batch, and a 15-minute timer also reviews smaller backlogs. Reviewed revisions are not charged again until they change. The model never inherits the Worker model. The budget counts application LLM calls per UTC day, includes failures, and is shared by Capture and Dreaming within that repository; it is not a token/dollar estimate or a provider-wide quota. There is at most one Memory model call across all repositories, and each has a 45-second deadline. Start with a small budget and review candidate evidence. For reasoning models, select a supported low reasoning effort that fits the fixed 45-second/2048-output-token limit; a provider default can fail or exceed that limit. The live OpenCode Go/DeepSeek V4.1 Flash smoke test used explicit `low`. Transcript capture alone never creates Host verification attestations, so its claims stay candidates. Separately, `autoCapture` enables a deterministic Host observer for foreground `node --test`, `pnpm test`, `pnpm exec vitest run` and `npm test` invocations. It requires a simple command, an authorized current Worker, an in-repository working directory, a canonical successful DSH result and unchanged HEAD observations. It records only that invocation, never a general repair claim or uncommitted-tree certification. This path makes no model call and works with a zero model budget. Unsupported/background executions retain the candidate/manual-review path. Validate the chosen provider with a live smoke test before relying on automatic analysis.

The same scoped management API provides `GET memory` (status/query filters, bounded limit/offset, counts and health), `GET memory/<id>` (note, evidence and revisions), and `POST memory/<id>/review`. A review carries `action` (`confirm`, `stale` or `retract`), `revision` and `reason`; confirmation additionally requires `confirmed: true`. Invalid fields are rejected and stale revisions return 409. These endpoints are management capabilities and are never Worker tools. `POST memory/consolidate` returns `queued`; `POST memory/rebuild` returns `rebuilt`. Consolidation requires Memory and Dreaming to be enabled and obeys pause, shutdown and budget limits. One manual request continuously advances through unreviewed pages, including after a model returns no proposals. A repository keeps one durable consolidation wakeup; changed work advances its generation instead of creating a row for each snapshot. Unchanged requests return `queued: false` while the existing task remains queued. Startup coalesces legacy snapshot rows without deleting notes or review progress. Reviewed revisions and rotation order persist in the existing KV table; changed revisions become eligible again. Each primary Note also queries related historical Notes regardless of previous review, using exact text, overlapping paths and title terms. The Host resolves original transcript anchors into redacted, bounded evidence packages; missing, changed and truncated sources are explicit and observable. Rebuild regenerates FTS, the prompt snapshot and `stateDir/memory/index.md` plus `wiki/<id>.md` and `topics/<topic-id>.md`, without invoking a model. Source Notes remain the audit layer; topic records hold source-linked architecture summaries, procedures and explicitly labeled inferences, with exact Note revisions and evidence IDs. Host publication checks all sources and links under CAS; invalidated or changed sources withdraw the affected prose until another review. Derived article definitions and their revision audit live in SQLite KV; Markdown can be rebuilt from that state. Re-synthesizing article definitions from Notes requires the analyzer. SQLite is authoritative; editing these Markdown files never changes memory. A missing or unsafe projection path reports `memory_projection_failed` without failing Workers. Health also distinguishes partial history, unavailable analysis and exhausted budget.

- `source:github`, `source:feishu`, `source:discord`, `source:wecom`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`. WeCom's has `secretFile`, optional `wsUrl`, `chats` as `[{"chatId": "…", "name": "…"}]`, `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
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

Setup verifies the selected repository and the agent's push access, writes the worker environment, and checks that git uses the selected provider's agent credential helper. A Feishu, Discord or WeCom setup failure pauses only that Source. Disabled optional Sources are not probed. Changing their enabled state reloads the bundle to update account bindings and worker shims; disabling one with a broken account does not require its account check to pass.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` or `gitea` runs the selected repository CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the credential helper for github.com or the configured Gitea instance, rewrites standard SSH addresses through the selected HTTP(S) instance root, and defines Git LFS filters. Gitea uses HTTPS origins and a helper that verifies the repository path. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN`, `GITHUB_TOKEN` and `GITEA_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed repository account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu or WeCom, mention the bot in a configured chat; a WeCom direct message needs no mention.

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
| A Ticket fails with `The prepare command failed: …` | Check the prepare command, clone path and exit status, then retry the Ticket. Raw command output is omitted because it may contain credentials |
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

Worker retrieval matches all eligible repository records before limiting results. SQLite reads run in a dedicated read-only Node process with a 500ms deadline and no inherited credential environment; unavailable FTS5 falls back to scoped substring matching under the same isolation. The synchronous prompt index is a precomputed snapshot of at most 600 UTF-8 bytes. Dreaming can classify durable architecture as `core`, reusable procedures as `routine`, and one-off outcomes as `incidental`; core entries precede routine entries, while incidental records remain searchable without being injected. Classification has independent CAS/audit and cannot refresh a claim or its verification. Worker-only `orchestrator_read` resources include `memory/topic/index` and `memory/topic/<topic-id>`, with the same authorization and repository restrictions as Note reads.


Verified invalidation and replacement require a person: model-proposed stale/retract, claim rewrites, or merges that remove a verified source create a pending proposal, with source availability and an independent audit version. The Memory list and detail show it while the original Note stays verified and searchable. Operator review sends the displayed Note revision plus `reviewRevision` from `GET memory/<id>` → `pendingReview.revision`; an omitted or stale request version returns 409. A person may reaffirm the original claim or explicitly stale/retract it. Source availability alone, even a replayed record or another unverified candidate, never authorizes automatic removal. Read-only analysis receives a bounded pending flag; full pending-request details remain in scoped management/read output and private SQLite/Wiki.

Concurrent Worker searches use one reader per repository with a FIFO queue of at most eight waiters. A waiter has 1500ms to acquire the permit, followed by the existing 500ms isolated SQLite deadline. Excess queue load returns `memory_retrieval_busy`; an expired wait returns `memory_retrieval_timeout`. Cancellation and Memory setting changes remove waiters, cancel active reads and release permits. Healthy reads clear transient retrieval health without clearing unrelated evidence/projection errors. No additional WorkerSlot or model call is used.


If Memory capture repeatedly fails, inspect Memory health for the fixed failure code (credentials, model configuration, provider limit, deadline, incomplete output or invalid proposals). Three analysis/publication failures at the same cursor pause further model attempts for that Session; its durable effect and checkpoint remain available. Correct and change and save the Memory settings to retry, or wait for the next UTC day. Other Tickets and retrieval continue. Setting the Memory daily call budget to 0 temporarily stops model attempts while retaining settled-turn capture jobs; restore the previous budget after diagnosis. No database relocation or schema migration is required for retry recovery.


### Memory throughput and consolidation reservations

`dailyCallBudget` accepts 0–10,000 calls per repository per UTC day; it remains 0 by default. `consolidationReservedCalls` defaults to 0, preserving existing deployments. For example, set the Memory settings to `dailyCallBudget: 1000` and `consolidationReservedCalls: 300` to reserve at least 300 calls for Dreaming within the same 1,000-call ceiling. Unused reserved calls cannot be spent by Capture while Dreaming is enabled. Dreaming may use additional available calls, and disabling Dreaming releases the reservation to Capture. A zero total stops both model paths without requiring the saved reservation to be cleared. Failed calls count in their category and against the total.

Health reports Capture and consolidation usage separately. Legacy `{day,calls}` usage is retained as `unclassifiedCalls` and still consumes the total; it is never reset or guessed into a category during upgrade. New category counters reset with the existing UTC day boundary. Reservations apply to the remaining capacity, and cannot reclaim calls spent earlier in the day. Worker execution and deterministic Host attestation remain independent of model quota.

Backlog is processed a page at a time by one durable consolidation task. New revisions and notes arriving during a call are retained through Effect generations; successful review and publication remain atomic. Quota/processing pauses and restart retain the task, which continues all remaining pages when capacity returns. A queue length of one can represent many pending notes. A finite budget cannot guarantee zero backlog at arbitrary activity levels; the reservation prevents capture from spending all consolidation capacity.

The database remains schema 12 and upgrades existing settings/usage in place. Back up databases and the profile before deployment. An older binary cannot parse a budget above its former 100-call limit or the new reservation setting; binary rollback requires restoring compatible pre-upgrade settings/database backups. Turning Memory off on the current version retains its notes and audit trail.
