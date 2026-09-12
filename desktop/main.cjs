const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const rootDir = path.resolve(__dirname, '..');
let serverHandle = null;

async function startBackend() {
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

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0c11',
    title: 'AgentBot',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  await win.loadURL(target);
  console.log(`[agentbot-desktop] window loaded ${target}`);

  const screenshotPath = process.env.AGENTBOT_SCREENSHOT;
  if (screenshotPath) {
    const delay = Number.parseInt(process.env.AGENTBOT_SCREENSHOT_DELAY ?? '', 10) || 2500;
    setTimeout(async () => {
      try {
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
