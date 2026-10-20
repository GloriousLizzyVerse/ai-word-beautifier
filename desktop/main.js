const { app, BrowserWindow, Menu, shell, net, ipcMain, dialog } = require('electron');
const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join, basename, extname, isAbsolute, normalize } = require('node:path');

const APP_NAME = 'word助手';
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
// 优先取环境变量 APP_URL（本地调试指向 dev server），否则用 config.json，最后回退线上地址
const APP_URL = (process.env.APP_URL && process.env.APP_URL.trim()) || String(config.appUrl || '').trim() || 'https://word.violet27chen.com/';
let appOrigin = '';
try {
  appOrigin = new URL(APP_URL).origin;
} catch {
  appOrigin = '';
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let offlineWatchTimer = null;
let showingOfflinePage = false;

function buildMenu() {
  const template = [
    {
      label: '窗口',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.loadURL(APP_URL) },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function offlinePageHtml(message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#111827;}
.card{max-width:460px;text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;box-shadow:0 10px 15px -3px rgba(0,0,0,.08);}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:13px;font-weight:600;margin-bottom:18px;}
h1{margin:0 0 10px;font-size:19px;}
p{margin:0 0 8px;color:#6b7280;font-size:14px;line-height:1.8;}
.hint{margin:14px 0 24px;padding:12px 14px;border-radius:10px;background:#f9fafb;border:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.7;text-align:left;}
button{padding:11px 32px;border-radius:10px;border:0;background:#4f46e5;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
button:hover{background:#4338ca;}
.status{margin-top:14px;font-size:12px;color:#9ca3af;}
</style></head><body>
<div class="card">
  <div class="badge">● 当前处于离线状态</div>
  <h1>无法连接到服务</h1>
  <p>${message || '请检查网络连接后重试。'}</p>
  <div class="hint">联网功能（AI 生成、下载 .docx、历史记录、账号登录）暂时不可用；<br>网络恢复后点击下方按钮即可继续使用，窗口无需关闭。</div>
  <button onclick="retry()">重新连接</button>
  <div class="status" id="status"></div>
</div>
<script>
function retry(){
  document.getElementById('status').textContent = '正在检查网络…';
  fetch(location.href, { method:'HEAD', cache:'no-store' }).then(function(){
    location.replace(${JSON.stringify(APP_URL)});
  }).catch(function(){
    document.getElementById('status').textContent = '仍未检测到网络连接，请稍后再试。';
  });
}
</script>
</body></html>`;
}

function showOfflinePage(reason) {
  if (!mainWindow || showingOfflinePage) return;
  showingOfflinePage = true;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePageHtml(reason))}`);
}

const DOC_EXTENSIONS = ['.docx', '.doc', '.txt', '.md', '.markdown'];

function registerDesktopIpc() {
  ipcMain.handle('desktop:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('desktop:pickFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '文档', extensions: DOC_EXTENSIONS.map((ext) => ext.slice(1)) }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const ext = extname(filePath).toLowerCase();
    if (ext === '.docx') {
      // docx needs mammoth in the renderer, so hand over raw bytes.
      return { filePath, name: basename(filePath), ext, bytes: new Uint8Array(readFileSync(filePath)) };
    }
    return { filePath, name: basename(filePath), ext, text: readFileSync(filePath, 'utf8') };
  });

  ipcMain.handle('desktop:saveDoc', async (_event, dir, fileName, data) => {
    if (typeof dir !== 'string' || !dir || typeof fileName !== 'string' || !fileName) {
      return { ok: false, error: '参数无效' };
    }
    // Keep writes inside the chosen working directory.
    const safeName = fileName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').trim();
    if (!safeName) return { ok: false, error: '文件名无效' };
    const targetDir = isAbsolute(dir) ? normalize(dir) : dir;
    const target = join(targetDir, safeName);
    if (!target.startsWith(targetDir) || !isAbsolute(target)) {
      return { ok: false, error: '目标路径不在工作目录内' };
    }
    try {
      writeFileSync(target, Buffer.from(data instanceof Uint8Array ? data : Buffer.from(String(data))));
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '写入失败' };
    }
  });

  ipcMain.handle('desktop:listDocs', async (_event, dir) => {
    if (typeof dir !== 'string' || !dir) return [];
    try {
      return readdirSync(dir)
        .filter((name) => DOC_EXTENSIONS.includes(extname(name).toLowerCase()))
        .map((name) => {
          const info = statSync(join(dir, name));
          return { name, size: info.size, mtime: info.mtime.toISOString() };
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
        .slice(0, 50);
    } catch {
      return [];
    }
  });

  ipcMain.handle('desktop:showInFolder', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
}

function startOfflineWatch() {
  if (offlineWatchTimer) return;
  offlineWatchTimer = setInterval(() => {
    if (!mainWindow) return;
    // Recover automatically once the network is back.
    if (net.isOnline() && showingOfflinePage) {
      showingOfflinePage = false;
      mainWindow.loadURL(APP_URL).catch(() => { showingOfflinePage = true; });
    }
  }, 5000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    title: APP_NAME,
    icon: join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f9fafb',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: join(__dirname, 'preload.js'),
    },
  });

  buildMenu();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Prevent the app from navigating away from the site; open other
  // origins (e.g. docs or GitHub links) in the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!appOrigin) return;
    try {
      if (new URL(url).origin !== appOrigin) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // ignore aborted subframe loads
    showOfflinePage('页面加载失败，可能是网络中断或服务暂时不可用。');
  });

  mainWindow.webContents.on('did-start-loading', () => {
    showingOfflinePage = false;
  });

  mainWindow.loadURL(APP_URL);
  startOfflineWatch();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  registerDesktopIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
