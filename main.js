const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// Electron 会给 fs 打上 asar 补丁：复制 *.asar 文件时会被误当成归档去读内部路径，
// 抛 "ENOENT, not found in app.asar"。本工具从源码运行、从不读取 asar 内容，
// 关闭该补丁后 copyFileSync/readdirSync 等按普通文件处理（打包产物里的 app.asar 原样复制）。
process.noAsar = true;

// ── Global state ──────────────────────────────────────────────────
let mainWindow = null;
let buildState = 'idle';        // 'idle' | 'building'
let currentBuildProcess = null;  // so we can cancel it

// ── Get exact Electron version installed ──────────────────────────
const electronVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(__dirname, 'node_modules', 'electron', 'package.json'), 'utf-8'
    )).version;
  } catch (_) {
    return '35.7.5'; // fallback
  }
})();

// ── Find npm & npx full paths at startup ──────────────────────────
let npmCmd = 'npm';
let npxCmd = 'npx';
try {
  npmCmd = execSync('where npm', { encoding: 'utf8' }).trim().split('\n')[0].trim();
  npxCmd = execSync('where npx', { encoding: 'utf8' }).trim().split('\n')[0].trim();
  console.log('[main] npm:', npmCmd, '| npx:', npxCmd);
} catch (_) { /* fall back to bare command */ }

// ── Create the tool window ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 750,
    height: 680,
    resizable: true,
    title: 'HTML to EXE Packer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (buildState === 'building') {
    killBuildProcess();
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: File dialogs ─────────────────────────────────────────────
ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:select-output', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择输出目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:select-icon', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: '图标文件', extensions: ['ico', 'png'] },
    ],
    properties: ['openFile'],
    title: '选择图标文件',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Helper: send progress to renderer ─────────────────────────────
function sendProgress(step, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('build:progress', { step, message });
  }
}

function sendLog(channel, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, text);
  }
}

// ── Helper: sanitize app name ─────────────────────────────────────
function sanitizeName(name) {
  let cleaned = name.replace(/[<>:"/\\|?*]/g, '').trim();
  if (!cleaned) cleaned = 'MyApp';
  return cleaned;
}

function sanitizeNpmName(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '') || 'html-app';
}

// ── Helper: read project's own package.json (if any) ──────────────
function readProjectPackage(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch (_) { /* ignore malformed package.json */ }
  }
  return {};
}

// ── Helper: detect project type ────────────────────────────────────
// 返回 { type: 'electron', mainFile } 或 { type: 'static' }。
// 判定规则：项目的 package.json 声明了 main，或根目录存在 main/index/app.js，
// 且该入口文件里 require('electron')，则视为完整 Electron 应用（保留其自身主进程）。
function detectProjectType(projectPath) {
  const pkg = readProjectPackage(projectPath);

  const candidates = [];
  if (pkg.main && typeof pkg.main === 'string') candidates.push(pkg.main);
  for (const name of ['main.js', 'index.js', 'app.js']) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  for (const cand of candidates) {
    const fp = path.join(projectPath, cand);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      if (/require\(\s*['"]electron['"]\s*\)/.test(content) ||
          /from\s+['"]electron['"]/.test(content)) {
        return { type: 'electron', mainFile: cand };
      }
    } catch (_) { /* ignore */ }
  }

  return { type: 'static' };
}

// ── Helper: kill current build process ────────────────────────────
function killBuildProcess() {
  if (currentBuildProcess) {
    try {
      currentBuildProcess.kill('SIGTERM');
      // On Windows, SIGTERM may not work; force kill children too
      spawn('taskkill', ['/pid', String(currentBuildProcess.pid), '/f', '/t']);
    } catch (_) { /* ignore */ }
    currentBuildProcess = null;
  }
}

// ── Helper: spawn with real-time output ───────────────────────────
function spawnPromise(command, args, options) {
  return new Promise((resolve, reject) => {
    // Quote command path if it contains spaces
    const cmd = command.includes(' ') ? `"${command}"` : command;
    const { timeout, ...spawnOptions } = options || {};
    const child = spawn(cmd, args, {
      ...spawnOptions,
      shell: true,
      windowsHide: true,
    });

    currentBuildProcess = child;

    // `timeout` 不是 spawn 的选项，需手动计时，超时后强制终止进程树
    let timedOut = false;
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      try { spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']); } catch (_) { /* ignore */ }
    }, timeout) : null;

    child.stdout.on('data', (data) => {
      sendLog('build:stdout', data.toString());
    });

    child.stderr.on('data', (data) => {
      sendLog('build:stderr', data.toString());
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      currentBuildProcess = null;
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      currentBuildProcess = null;
      if (code === 0) {
        resolve();
      } else if (timedOut) {
        reject(new Error('进程超时，已强制终止'));
      } else {
        reject(new Error(`进程退出，代码 ${code}`));
      }
    });
  });
}

// ── IPC: Start build ──────────────────────────────────────────────
ipcMain.handle('build:start', async (_event, config) => {
  if (buildState === 'building') {
    return { success: false, error: '已有打包任务正在进行中' };
  }

  buildState = 'building';

  const {
    projectPath,
    appName,
    outputDir,
    iconPath,
    frameless,
    fullscreen,
    width,
    height,
    packageMode,
  } = config;

  const safeName = sanitizeName(appName);
  const npmName = sanitizeNpmName(safeName);
  // 'folder' = 文件夹版（启动快）；其余一律按单文件便携版处理（兼容旧调用）
  const singleFile = packageMode !== 'folder';
  let workspaceDir = null;

  try {
    // ── [1] Input validation ──────────────────────────────────────
    sendProgress(1, '正在校验输入...');

    if (!projectPath || !fs.existsSync(projectPath)) {
      throw new Error('项目目录不存在');
    }

    if (!safeName || safeName.length === 0) {
      throw new Error('应用名称不能为空');
    }

    if (!outputDir) {
      throw new Error('请选择输出目录');
    }

    if (!fs.existsSync(outputDir)) {
      throw new Error('输出目录不存在');
    }

    // Test output dir is writable
    try {
      const testFile = path.join(outputDir, '.write-test');
      fs.writeFileSync(testFile, 'test', 'utf-8');
      fs.unlinkSync(testFile);
    } catch (_) {
      throw new Error(`输出目录不可写\n路径: ${outputDir}`);
    }

    if (iconPath && !fs.existsSync(iconPath)) {
      throw new Error('图标文件不存在');
    }

    // ── Detect project type ───────────────────────────────────────
    // 完整 Electron 应用（自带 main 进程）保留其主进程直接打包；纯静态网页用通用壳模板包裹。
    const projectType = detectProjectType(projectPath);
    if (projectType.type === 'electron') {
      sendLog('build:stdout',
        `✓ 检测到 Electron 应用（主进程: ${projectType.mainFile}）\n` +
        '  将保留项目自身主进程直接打包；「无边框/全屏/窗口尺寸」选项由项目代码控制，此处忽略。\n');
    } else {
      const indexPath = path.join(projectPath, 'index.html');
      if (!fs.existsSync(indexPath)) {
        throw new Error(`项目目录中缺少 index.html 文件\n路径: ${projectPath}`);
      }

      // Check for meta charset in user's HTML
      const htmlContent = fs.readFileSync(indexPath, 'utf-8');
      if (!/<meta\s+charset/i.test(htmlContent)) {
        sendLog('build:stdout',
          '\n⚠ 警告: index.html 中未检测到 <meta charset> 标签，建议添加\n' +
          '  <meta charset="UTF-8"> 以确保中文正常显示\n');
      }
    }

    sendLog('build:stdout', `✓ 校验通过\n  应用名称: ${safeName}\n  项目目录: ${projectPath}\n  输出目录: ${outputDir}\n`);

    // ── [2] Create temp workspace ─────────────────────────────────
    sendProgress(2, '正在创建工作区...');
    const uuid = uuidv4();
    workspaceDir = path.join(os.tmpdir(), `electron-packer-${uuid}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    sendLog('build:stdout', `✓ 工作区: ${workspaceDir}\n`);

    // 图标统一复制到工作区（静态壳放 app/ 下，Electron 应用放根目录）
    let iconFileName = null;
    if (iconPath) {
      const ext = path.extname(iconPath);
      iconFileName = 'icon' + ext;
    }

    // 按项目类型生成 electron-builder 配置与 npm install 参数
    let buildConfig;
    let installArgs;

    if (projectType.type === 'electron') {
      // ── 分支 A：完整 Electron 应用（保留项目自身主进程）──────
      sendProgress(3, '正在复制项目文件...');
      copyDir(projectPath, workspaceDir);
      sendLog('build:stdout', '✓ 项目文件已复制\n');

      if (iconFileName) {
        fs.copyFileSync(iconPath, path.join(workspaceDir, iconFileName));
        sendLog('build:stdout', `✓ 图标已复制: ${iconFileName}\n`);
      }

      // 读取项目原有 package.json，保留依赖 / 版本 / 主进程入口
      const srcPkg = readProjectPackage(projectPath);
      const electronVer =
        (srcPkg.devDependencies && srcPkg.devDependencies.electron) || electronVersion;

      // electron / electron-builder 只能出现在 devDependencies：
      // 源项目若把它们错放进 dependencies，这里剔除后统一移到 devDependencies，
      // 否则 electron-builder 26 会直接报错退出。
      const runtimeDeps = { ...(srcPkg.dependencies || {}) };
      delete runtimeDeps.electron;
      delete runtimeDeps['electron-builder'];

      buildConfig = {
        appId: `com.packer.${npmName}`,
        productName: safeName,
        directories: { output: 'dist' },
      };
      if (singleFile) {
        buildConfig.win = { target: 'portable' };
        buildConfig.portable = { artifactName: '${productName}.${ext}' };
      }
      if (iconFileName) {
        buildConfig.win = buildConfig.win || {};
        buildConfig.win.icon = iconFileName;
      }

      const packageJson = {
        name: srcPkg.name || npmName,
        version: srcPkg.version || '1.0.0',
        description: srcPkg.description || safeName,
        main: projectType.mainFile,
        author: srcPkg.author || '',
        license: srcPkg.license || 'UNLICENSED',
        dependencies: runtimeDeps,
        devDependencies: {
          electron: electronVer,
          'electron-builder': '^26.0.0',
        },
        build: buildConfig,
      };

      fs.writeFileSync(
        path.join(workspaceDir, 'package.json'),
        JSON.stringify(packageJson, null, 2),
        'utf-8',
      );
      sendLog('build:stdout', `✓ package.json 已生成（保留原主进程 ${projectType.mainFile} 与依赖）\n`);

      installArgs = ['install', '--no-audit', '--no-fund'];
    } else {
      // ── 分支 B：静态 HTML 项目（生成通用壳模板包裹）──────────
      fs.mkdirSync(path.join(workspaceDir, 'app'), { recursive: true });

      // ── [3] Generate template main.js ─────────────────────────────
      sendProgress(3, '正在生成项目文件...');

      const frameOption = frameless ? 'false' : 'true';
      const fullscreenOption = fullscreen ? 'true' : 'false';

      const templateMainContent = `const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// 自定义 app:// 协议：绕开 file:// 在路径含空格/括号（如 C:\\Program Files (x86)\\...）
// 时的子资源加载 bug（图片/视频/字体等资源无法加载）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,        // 相对路径（data/textures/...）能正确解析
      secure: true,          // 视为安全上下文，FontFace / 媒体可用
      supportFetchAPI: true,
      stream: true,          // mp4 / mp3 流式播放
    },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: ${width || 1280},
    height: ${height || 720},
    frame: ${frameOption},
    fullscreen: ${fullscreenOption},
    title: '${safeName.replace(/'/g, "\\'")}',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL('app://bundle/app/index.html');
  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  // 拦截 app:// 请求，映射回 asar 内的文件（pathToFileURL 保证路径编码正确）
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\\//, '');
    return net.fetch(pathToFileURL(path.join(__dirname, rel)).toString());
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
`;

      fs.writeFileSync(path.join(workspaceDir, 'main.js'), templateMainContent, 'utf-8');
      sendLog('build:stdout', `✓ 已生成 main.js (无边框=${frameless ? '是' : '否'}, 全屏=${fullscreen ? '是' : '否'})\n`);

      // ── [4] Copy user assets ──────────────────────────────────────
      sendProgress(4, '正在复制项目文件...');
      copyDir(projectPath, path.join(workspaceDir, 'app'));
      sendLog('build:stdout', '✓ 项目文件已复制\n');

      // ── Copy icon if provided ─────────────────────────────────────
      if (iconFileName) {
        fs.copyFileSync(iconPath, path.join(workspaceDir, 'app', iconFileName));
        sendLog('build:stdout', `✓ 图标已复制: ${iconFileName}\n`);
      }

      // ── [5] Generate package.json ─────────────────────────────────
      sendProgress(5, '正在生成 package.json...');

      buildConfig = {
        appId: `com.packer.${npmName}`,
        productName: safeName,
        directories: { output: 'dist' },
        files: [
          'main.js',
          'app',
        ],
      };

      if (singleFile) {
        // 单文件便携版：每次启动需解压到临时目录，启动较慢
        buildConfig.win = { target: 'portable' };
        buildConfig.portable = { artifactName: '${productName}.${ext}' };
      }
      // 文件夹版：不加 win.target，配合 `--dir` 生成 win-unpacked，启动更快。
      // asar 保持默认开启，应用文件（含素材）会打包进 resources/app.asar，
      // 不会以散文件形式直接暴露在打包结果里。

      if (iconFileName) {
        buildConfig.win = buildConfig.win || {};
        buildConfig.win.icon = `app/${iconFileName}`;
      }

      const packageJson = {
        name: npmName,
        version: '1.0.0',
        description: safeName,
        main: 'main.js',
        author: '',
        license: 'UNLICENSED',
        // 壳应用无运行时依赖；electron-builder 必须放在 devDependencies，
        // 否则 electron-builder 26 会报错拒绝执行（它也会自动排除 devDependencies 不打进包）
        dependencies: {},
        devDependencies: {
          electron: electronVersion,
          'electron-builder': '^26.0.0',
        },
        build: buildConfig,
      };

      fs.writeFileSync(
        path.join(workspaceDir, 'package.json'),
        JSON.stringify(packageJson, null, 2),
        'utf-8',
      );
      sendLog('build:stdout', '✓ package.json 已生成\n');

      // 不能用 --omit=dev：electron-builder 在 devDependencies 里，省略后 npx 找不到它
      installArgs = ['install', '--no-audit', '--no-fund'];
    }

    // ── [6] npm install ───────────────────────────────────────────
    sendProgress(6, '正在安装依赖 (npm install)...');
    sendLog('build:stdout', '正在运行 npm install，请稍候...\n');

    // Set China mirror env vars for faster downloads
    const env = {
      ...process.env,
      npm_config_registry: 'https://registry.npmmirror.com',
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    };

    await spawnPromise(npmCmd, installArgs, {
      cwd: workspaceDir,
      env,
      timeout: 300000, // 5 min
    });

    sendLog('build:stdout', '✓ npm install 完成\n');

    // ── [7] electron-builder ──────────────────────────────────────
    sendProgress(7, singleFile
      ? '正在打包单文件 EXE (portable)...'
      : '正在打包文件夹版本 (dir)...');
    sendLog('build:stdout', '正在运行 electron-builder，首次使用会下载 Electron 二进制文件，请耐心等待...\n');

    const builderArgs = singleFile
      ? ['electron-builder', '--win', 'portable']
      : ['electron-builder', '--dir'];

    await spawnPromise(npxCmd, builderArgs, {
      cwd: workspaceDir,
      env,
      timeout: 600000, // 10 min
    });

    sendLog('build:stdout', '✓ electron-builder 完成\n');

    // ── [8] Copy output ───────────────────────────────────────────
    sendProgress(8, '正在复制输出文件...');

    const distDir = path.join(workspaceDir, 'dist');
    let outputPath;

    if (singleFile) {
      const exeFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.exe'));
      if (exeFiles.length === 0) {
        throw new Error('未找到生成的 EXE 文件，打包可能失败');
      }
      outputPath = path.join(outputDir, `${safeName}.exe`);
      fs.copyFileSync(path.join(distDir, exeFiles[0]), outputPath);
    } else {
      const unpackedDir = path.join(distDir, 'win-unpacked');
      if (!fs.existsSync(unpackedDir)) {
        throw new Error('未找到生成的文件夹版本 (win-unpacked)，打包可能失败');
      }
      outputPath = path.join(outputDir, safeName);
      copyDir(unpackedDir, outputPath);
    }
    sendLog('build:stdout', `✓ 输出: ${outputPath}\n`);

    // ── [9] Cleanup ───────────────────────────────────────────────
    sendProgress(9, '正在清理...');
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    } catch (e) {
      sendLog('build:stdout', `⚠ 清理工作区失败: ${e.message}\n`);
    }
    sendLog('build:stdout', '✓ 清理完成\n');

    // ── Done ──────────────────────────────────────────────────────
    buildState = 'idle';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('build:complete', {
        success: true,
        outputPath,
        message: `打包成功!\n输出: ${outputPath}`,
      });
    }

    return { success: true, outputPath };

  } catch (err) {
    // Cleanup on error
    if (workspaceDir) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch (_) { /* ignore */ }
    }

    buildState = 'idle';
    currentBuildProcess = null;

    const errMsg = err.message || String(err);
    sendLog('build:stderr', `\n✗ 错误: ${errMsg}\n`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('build:error', { message: errMsg });
    }

    return { success: false, error: errMsg };
  }
});

// ── IPC: Cancel build ─────────────────────────────────────────────
ipcMain.handle('build:cancel', async () => {
  if (buildState !== 'building') {
    return { success: false, message: '没有正在进行的打包任务' };
  }

  killBuildProcess();
  buildState = 'idle';
  sendLog('build:stdout', '\n⚠ 打包已取消\n');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('build:error', { message: '用户取消了打包' });
  }

  return { success: true };
});

// ── Utility: recursive directory copy ─────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip common non-asset directories
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svn') {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
