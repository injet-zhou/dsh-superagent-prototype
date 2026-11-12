# Applications

An application connects related repositories behind one chat entry point. Someone can report a checkout bug without deciding whether the frontend or backend owns it. The application diagnoses across authorized repositories, delegates scoped work to their existing Workers, and reports results in the original conversation.

## Setup

1. Connect the application's repositories as usual. Keep each repository's existing account, execution prepare command and permissions.
2. Open **Superagent → Repositories → Applications → Add application**. Enter its name and select the related repositories.
3. Enable Feishu, Discord or WeCom and configure its bot and explicit groups/channels. Applications do not receive private messages or mentions from unlisted groups.
4. Add allowed senders using each chat service's own user IDs. Those senders must also be allowed on the same Source in every repository they need to inspect or change. The application does not map chat identities to GitHub usernames.
5. Optionally select the diagnosis model. An empty model uses the DSH default.

A group/channel belongs to one application or one repository. To move an existing repository group, select **Move selected chats from repositories to this application** when saving. Finish or stop its existing repository tasks first. The transfer removes that explicit subscription from the repository and records a durable recovery journal before assigning it to the application. Other application subscriptions cannot be taken over this way. Shared Feishu/WeCom bots still require explicit chat lists and the same CLI/secret paths.

Mention the bot with the failure and the requested outcome. Reply in the same thread to add reproduction details. The application asks for missing information there and provides PR links and actual validation results when ready. Select an application in the panel to view tasks, diagnosis Sessions, child results, retry a blocked diagnosis, or stop all work on a request.

## Execution and authorization

Application configurations and task records use separate `application:`, `application-task:` and `application-source:` KV namespaces in the default Store. Application bot contexts mount only the existing chat adapters, with isolated polling cursors and no repository identity. Each diagnosis has its own persistent Session and only six local tools: repository reading, chat context, dispatch, scoped follow-up, reporting and stopping. Inherited shell, editing, subagent and unrelated service tools are masked.

Reads require both application and repository authorization. They use the repository's existing provider adapter, pin its first inspected default-branch revision, page long files, and record repository/revision/path evidence. Hidden paths and dependencies remain unavailable, matching existing repository assessment reads. Running tests or reproduction requires a scoped repository investigation.

A handoff persists its stable task/repository/purpose ID before creating a repository Ticket. Repository creation is idempotent, so restart between creation and linkage does not create another Ticket. The Ticket records the original actor and an `application` Mandate basis; no group subscription or mention is forged. Dispatch and tool use recheck current application membership, sender permissions and repository availability. The application group does not need to be subscribed to each repository.

There is at most one current child per repository. An investigation that reports ready can be followed by a separately scoped fix Ticket, retaining the investigation reference. Dependencies may refer to already dispatched repositories; a dependent child waits for those results to be ready. Cross-repository PRs remain separate and merges are not atomic. The coordinator includes interface and merge dependencies and labels any unverified business flow in its result.

Repository Workers retain their account environments, worktrees, PR tracking and local limits. Diagnosis turns share the global automatic-dispatch limit, including installations without extra repository entries. Waiting for a person or child does not hold a diagnosis slot. Workers report to the coordinator; their handoffs have no application chat reply channels. The coordinator sends brief, idempotent replies with the existing Source adapters. Delivery failures are retried separately from diagnosis.

Stopping a request stops its current children. Disabling an application stops active requests and keeps their history. Change repository or chat associations only after stopping active application requests. A repository referenced by an application must be unlinked before removal. Startup resumes interrupted diagnoses and incomplete handoffs; unavailable repositories block their own work without changing the target.

## Management API and upgrades

The existing loopback and same-origin restrictions apply. Application operations are global, including when reached through a repository-scoped API path:

- `GET /orchestrator/api/applications` lists configuration and Source health.
- `POST .../applications` creates an application with `{ value, revision: 0, transfer?: boolean }`.
- `GET/PUT .../applications/:id` reads or updates configuration; updates require the current revision and cannot change the ID.
- `GET .../applications/:id/tasks` and `GET .../applications/:id/tasks/:taskId` inspect requests.
- `POST .../applications/:id/tasks/:taskId/retry` or `.../stop` retries diagnosis or stops the request.

`value` contains `id`, `name`, `enabled`, `repositories` (repository IDs), `sources` (chat Source configurations), `allowed` (per-Source sender lists), and nullable `model`. Source configuration shapes are the same as repository chat Sources, with private messages disabled and explicit chat lists. Conflicting revisions/subscriptions return 409. Unknown applications/tasks return 404.

Schema 13 adds the authorization compatibility boundary for application Mandates; existing schemas 10–12 upgrade transactionally without rewriting repository history. An older binary must refuse schema 13 rather than run application Tickets without their authorization check. Restore a pre-upgrade database backup when rolling back. Existing installations need no application configuration or account migration.
