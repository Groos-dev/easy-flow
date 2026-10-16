/**
 * Codex 的标题：读它自己的库 ~/.codex/state_*.sqlite 里的 threads 表。
 *
 * rollout 与 hook 报文里都没有标题，只有这儿有。取 `name` 不取 `title`——后者是首条消息
 * 原文（常常一整段带换行），前者才是应用侧边栏显示的那个短名。
 *
 * 读不到（库没建、被锁、表换过）一律当没有，调用方据此保留原来那句。
 */
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {readdirOrEmpty} from './fsutil.ts'

const DB_PREFIX = 'state_'
const DB_SUFFIX = '.sqlite'

/**
 * 编号最大的那个 state_*.sqlite：codex 升级会换编号，认不出就别读了。
 */
function stateDb(codexHome: string): string | null {
    const files = readdirOrEmpty(codexHome).filter((f) => f.startsWith(DB_PREFIX) && f.endsWith(DB_SUFFIX))
    const rank = (f: string) => Number(f.slice(DB_PREFIX.length, -DB_SUFFIX.length))
    const best = files.filter((f) => Number.isFinite(rank(f))).sort((a, b) => rank(b) - rank(a))[0]
    return best ? join(codexHome, best) : null
}

/** thread id → 应用里的标题。读不到返回空表 */
export function codexTitles(codexHome: string): Map<string, string> {
    const out = new Map<string, string>()
    const path = stateDb(codexHome)
    if (!path) return out

    let db: DatabaseSync
    try {
        db = new DatabaseSync(path, {readOnly: true})
    } catch {
        return out
    }
    try {
        const rows = db.prepare('SELECT id, name FROM threads WHERE name IS NOT NULL').all() as unknown as Array<{
            id?: unknown
            name?: unknown
        }>
        for (const row of rows) {
            if (typeof row.id === 'string' && typeof row.name === 'string' && row.name) out.set(row.id, row.name)
        }
    } catch {
        /* 表不在 / 库被锁 / 版本换过：当没有 */
    } finally {
        db.close()
    }
    return out
}
