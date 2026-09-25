const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromeColors, isExternalHttpUrl } = require('./window-chrome.cjs');

const rootDir = path.resolve(__dirname, '..');
let serverHandle = null;

async function startBackend() {
  const existingUrl = process.env.AGENTBOT_SERVER_URL || 'http://127.0.0.1:8787';
  try {
    const res = await fetch(`${existingUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      console.log(`[agentbot-desktop] existing backend detected at ${existingUrl}, reusing it`);
      return existingUrl;
    }
  } catch {}

  const httpEntry = path.join(rootDir, 'dist', 'server', 'http.js');
  const indexFile = path.join(rootDir, 'web', 'dist', 'index.html');

  if (!fs.existsSync(httpEntry)) {
    throw new Error('Backend is not built. Run `npm run build` in the project root first.');
  }
  if (!fs.existsSync(indexFile)) {
    throw new Error('UI is not built. Run `npm run web:build` in the project root first.');
  }

  const backend = await import(pathToFileURL(httpEntry).href);
  try {
    serverHandle = await backend.createAgentServer({
      port: 0,
      staticDir: path.join(rootDir, 'web', 'dist'),
      rootDir,
    });
  } catch (error) {
    // 未配置 API Key 时给出可操作的指引，而不是让窗口白屏
    if (error && error.name === 'MissingApiKeyError') {
      dialog.showErrorBox(
        'AgentBot 未配置 API Key',
        [
          '请在项目根目录创建 .env 文件，写入：',
          '',
          '    AGENT_API_KEY=sk-...',
          '',
          '也可以从 .env.example 复制一份再填。',
          '保存后重新启动。',
        ].join('\n'),
      );
      app.exit(1);
      throw error;
    }
    // 同一份数据已经有一个后端在跑（单实例锁，E3.6）
    if (error && error.name === 'InstanceLockError') {
      try {
        const check = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(1000) });
        if (check.ok) {
          console.log('[agentbot-desktop] existing AgentBot instance is running at http://127.0.0.1:8787/, connecting to it');
          return 'http://127.0.0.1:8787/';
        }
      } catch {}

      dialog.showErrorBox('AgentBot 已经在运行', String(error.message));
      app.exit(1);
      throw error;
    }
    throw error;
  }
  console.log(`[agentbot-desktop] backend ready at ${serverHandle.url}`);
  return serverHandle.url;
}

async function createWindow() {
  const backendUrl = await startBackend();
  const target = process.env.AGENTBOT_DEV_URL || backendUrl;

  // 首帧前页面还没告诉我们主题：按 web 端默认的浅色起，页面加载后经 preload 同步真实主题
  const initial = chromeColors('light');
  const win = new BrowserWindow({
    // 默认 1280 宽：落在「三栏常驻」档（≥1280，docs/主题与CSS.md 断点），右侧面板不必一开就变覆盖层
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: initial.background,
    title: 'AgentBot',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: initial.background, symbolColor: initial.symbol, height: 52 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 页面切主题 → 窗口底色与 Windows 标题栏同步（只认本窗口发来的消息）
  const onTheme = (event, theme) => {
    if (event.sender !== win.webContents || win.isDestroyed()) return;
    const colors = chromeColors(theme);
    win.setBackgroundColor(colors.background);
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: 52 });
    }
  };
  ipcMain.on('agentbot:theme', onTheme);
  win.on('closed', () => ipcMain.removeListener('agentbot:theme', onTheme));

  // 外链（Markdown 里的链接、target=_blank）交给系统浏览器，不在应用里开新窗口或把应用页面导走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url, target)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isExternalHttpUrl(url, target)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  await win.loadURL(target);
  console.log(`[agentbot-desktop] window loaded ${target}`);

  const screenshotPath = process.env.AGENTBOT_SCREENSHOT;
  if (screenshotPath) {
    const delay = Number.parseInt(process.env.AGENTBOT_SCREENSHOT_DELAY ?? '', 10) || 2500;
    setTimeout(async () => {
      try {
        if (process.env.AGENTBOT_SCREENSHOT_SCRIPT) {
          await win.webContents.executeJavaScript(process.env.AGENTBOT_SCREENSHOT_SCRIPT);
          await new Promise((r) => setTimeout(r, 800));
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(screenshotPath, image.toPNG());
        console.log(`[agentbot-desktop] screenshot saved to ${screenshotPath}`);
        app.exit(0);
      } catch (error) {
        console.error('[agentbot-desktop] screenshot failed:', error);
        app.exit(1);
      }
    }, delay);
  }

  return win;
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error('[agentbot-desktop] failed to start:', error);
    app.exit(1);
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => console.error(error));
  }
});

app.on('window-all-closed', () => {
  void (async () => {
    if (serverHandle) await serverHandle.close().catch(() => undefined);
    app.quit();
  })();
});
