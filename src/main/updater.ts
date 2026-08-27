import { app, dialog, shell, BrowserWindow } from 'electron'

const REPO_OWNER = 'ShiZiMiao'
const REPO_NAME = 'Typewren'

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  assets: Array<{
    name: string
    browser_download_url: string
    size: number
  }>
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, '').split('.').map(Number)
}

function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const na = va[i] || 0
    const nb = vb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': `${REPO_NAME}/${app.getVersion()}`
      }
    })
    if (!response.ok) return null
    return (await response.json()) as GitHubRelease
  } catch {
    return null
  }
}

export async function checkForUpdates(silent = false): Promise<void> {
  const currentVersion = app.getVersion()
  const release = await fetchLatestRelease()

  if (!release) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Typewren',
        message: '检查更新失败',
        detail: '无法连接到更新服务器，请检查网络连接。',
        buttons: ['确定']
      })
    }
    return
  }

  const latestVersion = release.tag_name.replace(/^v/, '')
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Typewren',
        message: '当前已是最新版本',
        detail: `Typewren v${currentVersion}`,
        buttons: ['确定']
      })
    }
    return
  }

  const setupAsset = release.assets.find(a => a.name.endsWith('.exe'))
  const sizeStr = setupAsset ? `\n大小: ${formatBytes(setupAsset.size)}` : ''

  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const choice = dialog.showMessageBoxSync(win!, {
    type: 'info',
    title: 'Typewren - 发现新版本',
    message: `发现新版本 v${latestVersion}`,
    detail: `当前版本: v${currentVersion}${sizeStr}\n\n${release.body || ''}`,
    buttons: ['下载更新', '稍后提醒'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (choice === 0) {
    shell.openExternal(setupAsset?.browser_download_url || release.html_url)
  }
}
