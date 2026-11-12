/** Shared worktree recipe; every operator-supplied value is a shell literal. */
export const shellLiteral = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export function worktreeCommand(path: string, remote: string): string {
  const git = `git -C ${shellLiteral(path)}`
  return `${git} fetch --no-tags ${shellLiteral(remote)} "${DSH_HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&\n${git} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`
}
const DSH_HEAD = '${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}'
export type WorkspaceCheck = { ok: boolean; code: 'ready' | 'path' | 'repository' | 'remote' | 'credentials' | 'writable' }
