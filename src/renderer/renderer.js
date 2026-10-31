// ── Wait for DOM ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

// ── DOM references ────────────────────────────────────────────────
const el = {
  projectPath:   document.getElementById('projectPath'),
  appName:       document.getElementById('appName'),
  outputDir:     document.getElementById('outputDir'),
  iconPath:      document.getElementById('iconPath'),
  chkFrameless:  document.getElementById('chkFrameless'),
  chkFullscreen: document.getElementById('chkFullscreen'),
  modeFolder:    document.getElementById('modeFolder'),
  modeSingle:    document.getElementById('modeSingle'),
  winWidth:      document.getElementById('winWidth'),
  winHeight:     document.getElementById('winHeight'),
  btnBuild:      document.getElementById('btnBuild'),
  btnCancel:     document.getElementById('btnCancel'),
  progressBar:   document.getElementById('progressBar'),
  progressFill:  document.getElementById('progressFill'),
  progressText:  document.getElementById('progressText'),
  logOutput:     document.getElementById('logOutput'),
  btnClearLog:   document.getElementById('btnClearLog'),
  btnBrowseProject: document.getElementById('btnBrowseProject'),
  btnBrowseOutput:  document.getElementById('btnBrowseOutput'),
  btnBrowseIcon:    document.getElementById('btnBrowseIcon'),
};

// ── Persistent settings via localStorage ──────────────────────────
function getPackageMode() {
  return el.modeSingle.checked ? 'single' : 'folder';
}

function saveSettings() {
  localStorage.setItem('packer-settings', JSON.stringify({
    projectPath: el.projectPath.value,
    appName: el.appName.value,
    outputDir: el.outputDir.value,
    iconPath: el.iconPath.value,
    frameless: el.chkFrameless.checked,
    fullscreen: el.chkFullscreen.checked,
    packageMode: getPackageMode(),
    width: el.winWidth.value,
    height: el.winHeight.value,
  }));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('packer-settings');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.projectPath) el.projectPath.value = s.projectPath;
    if (s.appName) el.appName.value = s.appName;
    if (s.outputDir) el.outputDir.value = s.outputDir;
    if (s.iconPath) el.iconPath.value = s.iconPath;
    if (s.frameless) el.chkFrameless.checked = s.frameless;
    if (s.fullscreen) el.chkFullscreen.checked = s.fullscreen;
    if (s.packageMode === 'single') el.modeSingle.checked = true;
    else el.modeFolder.checked = true;
    if (s.width) el.winWidth.value = s.width;
    if (s.height) el.winHeight.value = s.height;
  } catch (_) { /* ignore */ }
}

// ── Log helpers ───────────────────────────────────────────────────
function logLine(text, cls) {
  const div = document.createElement('div');
  div.className = 'log-line ' + (cls || 'log-info');
  div.textContent = text;
  el.logOutput.appendChild(div);
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}

function clearLog() {
  el.logOutput.innerHTML = '';
}

// ── Browse button handlers ────────────────────────────────────────
el.btnBrowseProject.addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) {
    el.projectPath.value = dir;
    saveSettings();
  }
});

el.btnBrowseOutput.addEventListener('click', async () => {
  const dir = await window.electronAPI.selectOutput();
  if (dir) {
    el.outputDir.value = dir;
    saveSettings();
  }
});

el.btnBrowseIcon.addEventListener('click', async () => {
  const file = await window.electronAPI.selectIcon();
  if (file) {
    el.iconPath.value = file;
    saveSettings();
  }
});

// ── Save settings on change ───────────────────────────────────────
[el.projectPath, el.appName, el.outputDir, el.iconPath,
 el.chkFrameless, el.chkFullscreen, el.modeFolder, el.modeSingle,
 el.winWidth, el.winHeight,
].forEach(el => {
  el.addEventListener('change', saveSettings);
  el.addEventListener('input', saveSettings);
});

el.btnClearLog.addEventListener('click', clearLog);

// ── Validation ────────────────────────────────────────────────────
function validate() {
  const errors = [];

  if (!el.projectPath.value.trim()) {
    errors.push('请选择项目目录');
  }

  if (!el.appName.value.trim()) {
    errors.push('请输入应用名称');
  } else if (el.appName.value.length > 64) {
    errors.push('应用名称不能超过 64 个字符');
  }

  if (!el.outputDir.value.trim()) {
    errors.push('请选择输出目录');
  }

  const w = parseInt(el.winWidth.value, 10);
  const h = parseInt(el.winHeight.value, 10);
  if (isNaN(w) || w < 100 || w > 9999) {
    errors.push('窗口宽度需在 100-9999 之间');
  }
  if (isNaN(h) || h < 100 || h > 9999) {
    errors.push('窗口高度需在 100-9999 之间');
  }

  return errors;
}

// ── Build lifecycle ───────────────────────────────────────────────
let unsubscribeFns = [];

function setBuildingState(active) {
  if (active) {
    el.btnBuild.disabled = true;
    el.btnBuild.textContent = '打包中...';
    el.btnCancel.classList.remove('hidden');
    el.progressBar.classList.remove('hidden');
    el.progressText.classList.remove('hidden');
    el.progressFill.style.width = '0%';
  } else {
    el.btnBuild.disabled = false;
    el.btnBuild.textContent = '打  包';
    el.btnCancel.classList.add('hidden');
    el.progressBar.classList.add('hidden');
    el.progressText.classList.add('hidden');
  }
}

function setupBuildListeners() {
  unsubscribeFns.forEach(fn => fn());
  unsubscribeFns = [];

  unsubscribeFns.push(
    window.electronAPI.onBuildProgress((data) => {
      const pct = Math.min(Math.round((data.step / 9) * 100), 100);
      el.progressFill.style.width = pct + '%';
      el.progressText.textContent = `[${data.step}/9] ${data.message}`;
    }),
    window.electronAPI.onBuildStdout((text) => {
      logLine(text, 'log-info');
    }),
    window.electronAPI.onBuildStderr((text) => {
      logLine(text, 'log-error');
    }),
    window.electronAPI.onBuildComplete((data) => {
      logLine('', 'log-info');
      logLine('═══════════════════════════════════════', 'log-success');
      logLine(data.message, 'log-success');
      logLine('═══════════════════════════════════════', 'log-success');
      setBuildingState(false);
      if (data.outputPath) {
        logLine(`输出文件: ${data.outputPath}`, 'log-success');
      }
    }),
    window.electronAPI.onBuildError((data) => {
      logLine(`✗ 打包失败: ${data.message}`, 'log-error');
      setBuildingState(false);
    }),
  );
}

// ── Build button ──────────────────────────────────────────────────
el.btnBuild.addEventListener('click', async () => {
  const errors = validate();
  if (errors.length > 0) {
    errors.forEach(e => logLine(`✗ ${e}`, 'log-error'));
    return;
  }

  clearLog();
  logLine('开始打包...', 'log-info');
  setBuildingState(true);
  setupBuildListeners();

  const config = {
    projectPath: el.projectPath.value.trim(),
    appName: el.appName.value.trim(),
    outputDir: el.outputDir.value.trim(),
    iconPath: el.iconPath.value.trim() || null,
    frameless: el.chkFrameless.checked,
    fullscreen: el.chkFullscreen.checked,
    packageMode: getPackageMode(),
    width: parseInt(el.winWidth.value, 10),
    height: parseInt(el.winHeight.value, 10),
  };

  const result = await window.electronAPI.startBuild(config);

  if (result && !result.success) {
    logLine(`✗ ${result.error}`, 'log-error');
    setBuildingState(false);
  }
});

// ── Cancel button ─────────────────────────────────────────────────
el.btnCancel.addEventListener('click', async () => {
  await window.electronAPI.cancelBuild();
});

// ── Init ──────────────────────────────────────────────────────────
loadSettings();

}); // end DOMContentLoaded
