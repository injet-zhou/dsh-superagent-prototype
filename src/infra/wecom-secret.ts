/** Reads the private file holding a WeCom intelligent robot's bot ID and secret; no SDK dependency, so setup can validate it. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** The private JSON file's shape: both values belong to the robot shown in the WeCom admin console. */
const SecretSchema = z.object({ botId: z.string().trim().min(1).max(256), secret: z.string().trim().min(1).max(512) }).strict()
export type WecomSecret = z.infer<typeof SecretSchema>

/** Identifies an unreadable secret file without including its content or path in a diagnostic. */
class SecretReadError extends Error {}

/**
 * Reads and validates the private secret file.
 * @throws with operator-facing guidance, never with the file's content.
 */
export async function readWecomSecret(secretFile: string): Promise<WecomSecret> {
  if (!isAbsolute(secretFile)) throw new Error('The WeCom secret file must be an absolute path')
  let text: string
  try {
    const info = await stat(secretFile)
    if (!info.isFile() || info.size > 8192) throw new SecretReadError()
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('The WeCom secret file must deny group and other access; use chmod 600 (or stricter)')
    }
    text = await readFile(secretFile, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The WeCom secret file must deny')) throw error
    throw new SecretReadError('Cannot read the WeCom secret file; expected a private JSON file with botId and secret fields')
  }
  const parsed = (() => { try { return SecretSchema.safeParse(JSON.parse(text) as unknown) }
    catch { throw new SecretReadError('The WeCom secret file is not valid JSON; expected botId and secret strings') } })()
  if (!parsed.success) throw new Error('The WeCom secret file must contain only botId and secret strings')
  return parsed.data
}
