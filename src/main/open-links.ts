import childProcess from 'node:child_process'

// Codex / 程小帮的深链要显式指定 bundle，否则已有窗口时只被拉到前台、不投递 URL
export function externalOpenArgs(url: string, platform = process.platform): string[] {
  if (platform === 'darwin' && url.startsWith('codex://')) {
    return ['-b', 'com.openai.codex', url]
  }
  if (platform === 'darwin' && url.startsWith('chengxiaobang://')) {
    return ['-b', 'com.chengxiaobang.desktop', url]
  }
  return [url]
}

/**
 * 以系统打开结果作为 Promise 回执。
 */
export async function openExternalLink(
  url: string,
  openUrl: (url: string) => Promise<void>,
  platform = process.platform,
): Promise<void> {
  const args = externalOpenArgs(url, platform)
  if (args.length > 1) {
    await new Promise<void>((resolve, reject) => {
      childProcess.execFile('open', args, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  } else {
    await openUrl(url)
  }
}
