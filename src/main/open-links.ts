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
