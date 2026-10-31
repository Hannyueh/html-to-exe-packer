# 📦 HTML to EXE Packer

一个图形化的 Windows 打包工具：把 **HTML/CSS/JS 静态网页** 或 **完整的 Electron 应用** 打包成独立的 Windows 程序。

- 静态网页：自动生成一个最小 Electron 壳，把你的 `index.html` 包进去。
- Electron 应用：**保留你项目自身的主进程**（`main.js`），原样打包，联机服务器、Node 内置模块等全部可用。

---

## 目录

- [环境要求](#环境要求)
- [技术参数速览](#技术参数速览)
- [快速开始](#快速开始)
- [界面说明](#界面说明)
- [支持的输入项目类型](#支持的输入项目类型)
- [打包流程与架构](#打包流程与架构)
- [技术参数详解](#技术参数详解)
- [输出产物](#输出产物)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [许可](#许可)

---

## 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（仅支持打包 Windows x64 程序） |
| Node.js | ≥ 16（建议 18+；自带 `npm` 与 `npx`，需在 PATH 中） |
| 磁盘空间 | ≥ 1 GB（首次打包需下载 Electron 二进制约 120 MB，及 electron-builder） |
| 网络 | 需能访问 npm 镜像（工具已内置 `npmmirror.com` 加速，无需手动配置代理） |

> 本工具本身也是一个 Electron 应用，首次启动会自动安装依赖与 Electron 二进制（见 [`启动.bat`](#项目结构)）。

---

## 技术参数速览

| 参数 | 值 |
|---|---|
| 工具自身框架 | Electron `35.7.5` |
| 静态壳 Electron 版本 | 跟随工具自身安装版本（运行时读取 `node_modules/electron`，回退 `35.7.5`） |
| Electron 应用打包版本 | 跟随项目自身 `devDependencies.electron`（如 `^30.0.0`） |
| 打包引擎 | electron-builder `^26.0.0` |
| 目标平台 | Windows（win32，x64） |
| 打包方式 | 文件夹版（`--dir` → `win-unpacked`）/ 单文件便携版（`--win portable`） |
| asar 归档 | 默认开启（资源打包进 `resources/app.asar`） |
| 运行时依赖（工具） | `uuid ^11.1.0` |
| npm 镜像 | `https://registry.npmmirror.com` |
| Electron 二进制镜像 | `https://npmmirror.com/mirrors/electron/` |
| electron-builder 二进制镜像 | `https://npmmirror.com/mirrors/electron-builder-binaries/` |
| npm install 超时 | 5 分钟（300 000 ms，超时强制终止） |
| electron-builder 超时 | 10 分钟（600 000 ms，超时强制终止） |
| 最小产物体积 | 约 70–80 MB（内置 Chromium 的基础开销） |

---

## 快速开始

### 方式一：双击启动脚本

直接双击 **`启动.bat`** 启动工具。

### 方式二：命令行

```powershell
cd "项目目录"
npm start
```

---

## 界面说明

打开后是一个表单：

| 字段 | 说明 | 必填 |
|---|---|---|
| **项目目录** | 静态网页：需含 `index.html`；Electron 应用：需含主进程 `main.js` | ✅ |
| **应用名称** | EXE 名称与窗口标题（会做非法字符清洗） | ✅ |
| **输出目录** | 生成结果保存位置 | ✅ |
| **应用图标** | 可选，支持 `.ico` / `.png`（Windows 建议 256×256） | ❌ |
| **打包方式** | `文件夹版`（推荐，启动快）/ `单文件 EXE`（便携，启动较慢） | ✅ |

### 窗口选项（仅对静态网页生效）

| 选项 | 效果 |
|---|---|
| ☐ **无边框窗口** | 去掉标题栏和边框，适合游戏界面 |
| ☐ **全屏启动** | 启动后自动全屏 |
| 窗口宽度 / 高度 | 默认窗口尺寸（默认 1280×720） |

> ⚠️ **Electron 应用会忽略以上三个窗口选项**——窗口由项目自己的 `main.js` 控制。

---

## 支持的输入项目类型

工具会**自动识别**项目类型并走对应的打包分支：

### A. 静态 HTML 网页

识别条件：项目根目录有 `index.html`，且不满足下面的 Electron 应用判定。

打包方式：生成一个最小 Electron 壳（注册自定义 `app://` 协议加载 `index.html`），把网页文件放进 `app/` 子目录。

### B. 完整 Electron 应用

识别条件（满足其一即判定为 Electron 应用）：

1. 项目 `package.json` 的 `main` 字段指向一个存在的 JS 文件，且该文件内容包含 `require('electron')`；
2. 或项目根目录存在 `main.js` / `index.js` / `app.js`，且其中包含 `require('electron')` 或 `import ... from 'electron'`。

打包方式：**保留项目自身主进程**，整个项目原样复制打包。项目的依赖（`dependencies`）、electron 版本（`devDependencies.electron`）会被保留。

> 判定正则：`require\(\s*['"]electron['"]\s*\)` 或 `from\s+['"]electron['"]`。

---

## 打包流程与架构

无论哪种类型，完整流水线均为 **9 步**，进度条按 `[步骤/9]` 展示：

```
[1] 校验输入            —— 校验目录存在、名称合法、输出目录可写、图标存在
[2] 创建工作区           —— 在系统临时目录创建 electron-packer-<uuid>
[3] 生成项目文件         —— 静态：生成壳 main.js；Electron：复制整个项目
[4] 复制项目文件         —— 静态：复制到 app/；Electron：复制到工作区根目录
[5] 生成 package.json    —— 按类型生成依赖与 build 配置
[6] npm install          —— 安装 electron / electron-builder（走 npmmirror 镜像）
[7] electron-builder     —— 生成 win-unpacked（文件夹版）或 portable（单文件版）
[8] 复制输出文件         —— 拷贝到用户输出目录
[9] 清理                —— 删除临时工作区
```

关键实现细节：

- 临时工作区位于 `os.tmpdir()/electron-packer-<uuid>`，打包结束后自动删除。
- 所有子进程（npm / npx）通过 `spawn` 启动，`stdout`/`stderr` 实时回传到界面日志。
- 超时机制：`npm install` 5 分钟、`electron-builder` 10 分钟，超时后强制 `taskkill` 终止进程树，避免无限卡死。
- `process.noAsar = true` 仅作用于工具自身进程，避免复制 `.asar` 文件时被误解析（不影响打包产物）。

### 静态网页分支（分支 B）

生成的壳 `main.js` 使用自定义 `app://` 协议加载网页，绕过 `file://` 在路径含空格/括号时的子资源加载 bug：

```js
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
}}]);
// ...
protocol.handle('app', (request) => {
  const { pathname } = new URL(request.url);
  const rel = decodeURIComponent(pathname).replace(/^\\//, '');
  return net.fetch(pathToFileURL(path.join(__dirname, rel)).toString());
});
win.loadURL('app://bundle/app/index.html');
```

生成的 `package.json`：

```json
{
  "main": "main.js",
  "dependencies": {},
  "devDependencies": {
    "electron": "<工具自身 electron 版本>",
    "electron-builder": "^26.0.0"
  },
  "build": {
    "appId": "com.packer.<npmName>",
    "productName": "<应用名称>",
    "directories": { "output": "dist" },
    "files": ["main.js", "app"]
  }
}
```

> `electron` / `electron-builder` 必须放在 `devDependencies`：electron-builder 26 检测到它们出现在 `dependencies` 时会直接报错退出。因此该分支的 `npm install` 不使用 `--omit=dev`。

### Electron 应用分支（分支 A）

保留项目 `main.js` 与依赖，生成的 `package.json`：

```json
{
  "main": "<项目自身主进程>",
  "dependencies": { "<项目原有运行时依赖>" },
  "devDependencies": {
    "electron": "<项目自身 electron 版本>",
    "electron-builder": "^26.0.0"
  },
  "build": {
    "appId": "com.packer.<npmName>",
    "productName": "<应用名称>",
    "directories": { "output": "dist" }
  }
}
```

> 该分支**不设置** `files`，沿用 electron-builder 默认 `**/*`，确保项目根目录与所有子目录文件全部进包。
>
> 源项目若把 `electron` / `electron-builder` 误放进 `dependencies`，生成时会自动剔除并统一移入 `devDependencies`。

---

## 技术参数详解

### 命名清洗规则

| 规则 | 说明 |
|---|---|
| `sanitizeName` | 移除 `<>:"/\|?*` 等 Windows 非法字符并去首尾空白；为空则回退 `MyApp` |
| `sanitizeNpmName` | 转小写、空格转 `-`、仅保留 `a-z0-9-`、去首尾 `-`；为空则回退 `html-app` |

### 打包方式对比

| | 文件夹版 | 单文件 EXE（便携版） |
|---|---|---|
| 构建命令 | `electron-builder --dir` | `electron-builder --win portable` |
| 产物 | `<应用名>/` 文件夹（内含 `win-unpacked` 文件） | `<应用名>.exe` 单文件 |
| 启动速度 | ⚡ 快（直接读磁盘） | 🐢 慢（每次启动解压到临时目录） |
| 分发方式 | 整个文件夹一起分发 | 单个文件 |

### 图标处理

- 支持 `.ico` / `.png`；复制到工作区后写入 `build.win.icon`。
- 静态分支图标路径为 `app/icon.<ext>`；Electron 分支为 `icon.<ext>`。
- 建议使用 256×256 的 `.ico` 以获得最佳效果。

### 镜像与超时

打包时注入的环境变量：

```js
{
  npm_config_registry: 'https://registry.npmmirror.com',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}
```

| 阶段 | 超时 | 超时行为 |
|---|---|---|
| `npm install` | 300 000 ms（5 分钟） | 强制终止进程树并报错 |
| `electron-builder` | 600 000 ms（10 分钟） | 强制终止进程树并报错 |

---

## 输出产物

| 打包方式 | 输出位置 | 内容 |
|---|---|---|
| 文件夹版 | `<输出目录>/<应用名称>/` | `win-unpacked` 全部文件 |
| 单文件版 | `<输出目录>/<应用名称>.exe` | 单个便携 EXE |

两种方式均开启 asar，应用资源打包进 `resources/app.asar`，不会以散文件暴露。

---

## 项目结构

```
Electron打包/
├── 启动.bat           ← 双击启动（自动装依赖 + 下载 Electron 二进制）
├── 启动.ps1           ← PowerShell 启动脚本
├── package.json       ← 工具自身依赖（electron 35.7.5, uuid）
├── main.js            ← 主进程：完整打包流水线 + 类型识别
├── preload.js         ← 安全 IPC 桥接（contextBridge）
├── renderer/
│   ├── index.html     ← 工具 GUI
│   ├── style.css
│   └── renderer.js    ← 界面逻辑与打包进度显示
├── template/
│   └── main.js        ← 静态网页分支注入到产物的壳模板
├── README.md
└── node_modules/
```

> `template/main.js` 为旧版静态壳模板参考；当前实际使用的壳模板已内联在 `main.js` 中。

---

## 常见问题

### Q: 打包卡在 `npm warn config production Use --omit=dev instead`？

这是旧版 `--production` 参数触发的弃用告警。当前版本已改用 `--omit=dev --no-audit --no-fund`，并补全了 npm 镜像源，不会再卡住。

### Q: 打包后缺失部分文件（如 index.html）？

历史版本用 `files: ["app/**/*"]`，该 glob 无法匹配 `app/` 目录下的一级文件。现已改为 `files: ["app"]`（直接匹配目录会递归复制全部内容）。

### Q: 打包 Electron 应用后白屏？

白屏通常因为把 Electron 应用当成了静态网页打包（主进程被通用壳替换、联机服务器丢失）。现版本会自动识别 Electron 应用并保留其主进程。

### Q: 打包失败，提示网络超时？

Electron 二进制约 120 MB，工具已内置 `npmmirror.com` 镜像。仍失败可重试几次。

### Q: 打包出来的 EXE 很大？

最小约 70–80 MB，因为内置了 Chromium 浏览器，是 Electron 应用的基础开销。

### Q: 单文件 EXE 启动慢怎么办？

便携版每次启动前都要把内置文件解压到临时目录。改用「文件夹版」即可明显加快。

### Q: 无边框窗口怎么关闭？

在网页里放关闭按钮：`<button onclick="window.close()">关闭</button>`，或监听按键调用 `window.close()`。

### Q: 打包后中文乱码？

确保 HTML 有 `<meta charset="UTF-8">`，工具打包前会检测并提示。

---

## 技术栈

- **Electron 35** — 桌面框架
- **electron-builder 26** — EXE 打包工具
- **Vanilla HTML/CSS/JS** — GUI（零框架）
- **contextBridge** — 安全 IPC 通信

---

## 许可

MIT License
