// 这是模板文件，会被工具读取并注入配置后写入打包项目
// 占位符在 main.js 的构建流水线中直接替换，此处仅作参考
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: true,
    fullscreen: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.setMenuBarVisibility(false);
});

app.on('window-all-closed', () => {
  app.quit();
});
