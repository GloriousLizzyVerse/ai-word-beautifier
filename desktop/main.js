const { app, BrowserWindow, Menu, shell } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const APP_NAME = 'word助手';
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
const APP_URL = String(config.appUrl || '').trim() || 'https://word.violet27chen.com/';
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
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

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
    const retry = `location.replace(${JSON.stringify(APP_URL)})`;
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#111827;}
.card{max-width:420px;text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;box-shadow:0 10px 15px -3px rgba(0,0,0,.08);}
h1{margin:0 0 10px;font-size:18px;}p{margin:0 0 22px;color:#6b7280;font-size:14px;line-height:1.7;}
button{padding:10px 28px;border-radius:10px;border:0;background:#4f46e5;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}</style>
</head><body><div class="card"><h1>无法连接到服务</h1><p>请检查网络连接后重试。<br>如持续失败，请联系管理员或稍后再试。</p><button onclick="${retry.replace(/"/g, '&quot;')}">重新连接</button></div></body></html>`)}`);
  });

  mainWindow.loadURL(APP_URL);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
