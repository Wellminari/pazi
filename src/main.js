// Pazi para Windows — processo principal (Electron).
// - Abre o painel (painel.pazi.app) e o Pazi Atende (/whatsapp-chat) em janelas próprias
// - Fechar a janela só esconde: o app continua no relógio do Windows ouvindo pedidos e mensagens
// - Expõe para o painel (via preload) impressão direta, notificações e contador no ícone
// - Atualiza a casca sozinho pelas versões publicadas no GitHub

const {
  app, BrowserWindow, Tray, Menu, shell, ipcMain, Notification,
  nativeImage, session, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const cfg = require('./config');

// ---------------------------------------------------------------------------
// Configurações salvas do usuário (tela cheia, iniciar com o Windows)
// ---------------------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'pazi-settings.json');
let settings = { fullscreen: { panel: false, atende: false }, openAtLogin: true, bounds: {} };

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...settings, ...raw, fullscreen: { ...settings.fullscreen, ...(raw.fullscreen || {}) } };
  } catch { /* primeira execução */ }
  // "Iniciar com o Windows" vem LIGADO por padrão (aplicado uma única vez;
  // depois vale a escolha da pessoa no menu do relógio).
  if (!settings.autostartDefaultApplied) {
    settings.openAtLogin = true;
    settings.autostartDefaultApplied = true;
    saveSettings();
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, args: [cfg.ARG_HIDDEN] });
  }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Instância única: o segundo clique (ou o atalho "Pazi Atende") só abre a janela
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(cfg.ARG_ATENDE)) showWindow('atende');
    else showWindow('panel');
  });
}

app.setAppUserModelId(cfg.APP_ID_PANEL);

// Ícones: Pazi (painel e relógio) e Pazi Atende (janela, barra de tarefas e notificações de mensagem)
const iconPath = (kind = 'panel') => {
  const file = kind === 'atende' ? 'atende.ico' : 'icon.ico';
  return app.isPackaged ? path.join(process.resourcesPath, file) : path.join(__dirname, '..', 'build', file);
};

const windows = { panel: null, atende: null };
let tray = null;
let isQuitting = false;
let updateReadyVersion = null;
// A janela do Pazi é criada sempre (escondida quando a pessoa abriu só o Pazi Atende
// ou iniciou com o Windows): é nela que rodam o som, as notificações e o contador.
const startPanelHidden = process.argv.includes(cfg.ARG_HIDDEN) || process.argv.includes(cfg.ARG_ATENDE);
const badgeCounts = { panel: 0, atende: 0 };

// ---------------------------------------------------------------------------
// Segurança: só o painel do Pazi abre dentro do app; o resto vai para o navegador
// ---------------------------------------------------------------------------
function isPanelUrl(url) {
  try { return new URL(url).host === cfg.PANEL_HOST; } catch { return false; }
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['https:', 'http:', 'mailto:', 'tel:', 'whatsapp:'].includes(u.protocol)) shell.openExternal(url);
  } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------
function savedBounds(kind) {
  const b = settings.bounds && settings.bounds[kind];
  if (!b || !b.width || !b.height) return null;
  // Só reaproveita se a posição ainda cair num monitor conectado
  const visible = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 50 && b.x + b.width > w.x + 50 && b.y < w.y + w.height - 50 && b.y + 40 > w.y);
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

function createWindow(kind) {
  const isAtende = kind === 'atende';
  const bounds = savedBounds(kind);
  const win = new BrowserWindow({
    width: bounds ? bounds.width : 1366,
    height: bounds ? bounds.height : 860,
    ...(bounds && bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 380,
    minHeight: 500,
    show: false,
    title: isAtende ? 'Pazi Atende' : 'Pazi',
    icon: iconPath(kind),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Essencial: com a janela escondida/minimizada o painel continua rodando
      // e consegue tocar o som do Pazi na hora.
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  // Entrada própria na barra de tarefas para o Pazi Atende
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: isAtende ? cfg.APP_ID_ATENDE : cfg.APP_ID_PANEL,
      appIconPath: iconPath(kind),
      relaunchCommand: `"${process.execPath}"${isAtende ? ` ${cfg.ARG_ATENDE}` : ''}`,
      relaunchDisplayName: isAtende ? 'Pazi Atende' : 'Pazi',
    });
  }

  const homeUrl = isAtende ? cfg.ATENDE_URL : cfg.PANEL_URL;
  win.loadURL(homeUrl);

  win.once('ready-to-show', () => {
    if (bounds && bounds.maximized) win.maximize();
    if (settings.fullscreen[kind]) win.setFullScreen(true);
    if (!(kind === 'panel' && startPanelHidden)) win.show();
  });

  // Guarda tamanho e posição (cada janela a sua)
  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      const prev = (settings.bounds && settings.bounds[kind]) || {};
      settings.bounds = { ...(settings.bounds || {}), [kind]: maximized ? { ...prev, maximized: true } : { ...win.getBounds(), maximized: false } };
      saveSettings();
    }, 500);
  };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((ev) => win.on(ev, rememberBounds));

  // Sem internet: mostra a tela "Sem conexão" e volta sozinho quando reconectar
  win.webContents.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = carregamento cancelado (normal)
    const target = isPanelUrl(validatedURL) ? validatedURL : homeUrl;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { target } });
  });

  // Recuperação automática: se o painel travar ou fechar sozinho, recarrega
  let hangTimer = null;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(homeUrl); }, 1500);
  });
  win.webContents.on('unresponsive', () => {
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      try { win.webContents.forcefullyCrashRenderer(); } catch { /* noop */ }
      setTimeout(() => { if (!win.isDestroyed()) win.loadURL(homeUrl); }, 1000);
    }, 30000);
  });
  win.webContents.on('responsive', () => clearTimeout(hangTimer));

  // Fechar = esconder no relógio (o som e as notificações continuam)
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { windows[kind] = null; });

  win.on('enter-full-screen', () => { settings.fullscreen[kind] = true; saveSettings(); rebuildTrayMenu(); });
  win.on('leave-full-screen', () => { settings.fullscreen[kind] = false; saveSettings(); rebuildTrayMenu(); });

  // Links: dentro do painel abrem aqui; fora (WhatsApp, Maps, catálogo...) no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPanelUrl(url)) {
      const u = new URL(url);
      if (u.pathname.startsWith('/whatsapp-chat')) { showWindow('atende'); return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: iconPath(kind),
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
          },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return; // tela "Sem conexão" do próprio app
    if (!isPanelUrl(url)) { e.preventDefault(); openExternal(url); }
  });

  // Atalhos de teclado (sem barra de menu do Windows)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'Escape' && win.isFullScreen()) { win.setFullScreen(false); }
    else if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
    else if (ctrl && (input.key === '=' || input.key === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (ctrl && input.key === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (ctrl && input.key === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
    else if (ctrl && input.shift && input.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });

  // Menu do botão direito (copiar/colar e correção ortográfica) — essencial no Pazi Atende
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions || []) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    if (p.misspelledWord) {
      items.push({ label: 'Adicionar ao dicionário', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.linkURL) items.push({ label: 'Abrir link no navegador', click: () => openExternal(p.linkURL) }, { type: 'separator' });
    items.push(
      { label: 'Recortar', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copiar', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Colar', role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Selecionar tudo', role: 'selectAll' },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  windows[kind] = win;
  return win;
}

function showWindow(kind) {
  const win = windows[kind] || createWindow(kind);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

function kindOf(webContents) {
  for (const k of Object.keys(windows)) {
    if (windows[k] && windows[k].webContents === webContents) return k;
  }
  return 'panel';
}

// ---------------------------------------------------------------------------
// Contador no ícone da barra de tarefas (bolinha vermelha com número)
// ---------------------------------------------------------------------------
function makeBadge(count) {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - r + 0.5, dy = y - r + 0.5;
      if (dx * dx + dy * dy <= (r - 1) * (r - 1)) {
        const i = (y * size + x) * 4;
        buf[i] = 0x3c; buf[i + 1] = 0x14; buf[i + 2] = 0xe8; buf[i + 3] = 0xff; // vermelho/rosa
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function applyBadge(kind) {
  const win = windows[kind];
  const count = badgeCounts[kind] || 0;
  if (win && process.platform === 'win32') {
    win.setOverlayIcon(count > 0 ? makeBadge(count) : null, count > 0 ? `${count} pendentes` : '');
  }
  if (tray) {
    const total = badgeCounts.panel + badgeCounts.atende;
    tray.setToolTip(total > 0 ? `Pazi — ${badgeCounts.panel} pedido(s), ${badgeCounts.atende} mensagem(ns)` : 'Pazi');
  }
}

// ---------------------------------------------------------------------------
// Ponte com o painel (chamada pelo preload): impressão, notificação, contador
// ---------------------------------------------------------------------------
function assertFromPanel(event) {
  const url = event.senderFrame ? event.senderFrame.url : event.sender.getURL();
  if (!isPanelUrl(url)) throw new Error('Origem não permitida');
}

ipcMain.handle('pazi:info', (event) => {
  assertFromPanel(event);
  return { isDesktop: true, version: app.getVersion(), platform: process.platform, window: kindOf(event.sender) };
});

ipcMain.handle('pazi:list-printers', async (event) => {
  assertFromPanel(event);
  const list = await event.sender.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault, status: p.status }));
});

// Imprime um HTML direto na impressora, sem janela de impressão.
// options: { deviceName?, copies?, widthMm? (ex.: 80 para térmica), heightMm?, landscape? }
ipcMain.handle('pazi:print-html', async (event, html, options = {}) => {
  assertFromPanel(event);
  if (typeof html !== 'string' || html.length === 0) throw new Error('HTML vazio');
  if (html.length > 5 * 1024 * 1024) throw new Error('HTML muito grande');

  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pageSize = options.widthMm
      ? { width: Math.round(options.widthMm * 1000), height: Math.round((options.heightMm || 297) * 1000) }
      : 'A4';
    return await new Promise((resolve, reject) => {
      printWin.webContents.print({
        silent: true,
        printBackground: true,
        deviceName: options.deviceName || '',
        copies: Math.max(1, Math.min(10, Number(options.copies) || 1)),
        landscape: !!options.landscape,
        margins: { marginType: 'none' },
        pageSize,
      }, (success, reason) => (success ? resolve({ ok: true }) : reject(new Error(reason || 'Falha ao imprimir'))));
    });
  } finally {
    if (!printWin.isDestroyed()) printWin.destroy();
  }
});

// Notificação do Windows. O SOM é tocado pelo painel (som escolhido nas configurações),
// por isso a notificação sai em silêncio.
ipcMain.handle('pazi:notify', (event, payload = {}) => {
  assertFromPanel(event);
  const kind = payload.kind === 'message' ? 'atende' : kindOf(event.sender);
  const n = new Notification({
    title: String(payload.title || (kind === 'atende' ? 'Nova mensagem' : 'Novo pedido')).slice(0, 120),
    body: String(payload.body || '').slice(0, 300),
    icon: iconPath(kind),
    silent: true,
  });
  n.on('click', () => {
    const win = showWindow(kind);
    if (payload.url && isPanelUrl(new URL(payload.url, cfg.PANEL_ORIGIN).href)) {
      win.loadURL(new URL(payload.url, cfg.PANEL_ORIGIN).href);
    }
  });
  n.show();
  return true;
});

ipcMain.handle('pazi:set-badge', (event, count) => {
  assertFromPanel(event);
  const kind = kindOf(event.sender);
  badgeCounts[kind] = Math.max(0, Math.min(999, Number(count) || 0));
  applyBadge(kind);
  return true;
});

ipcMain.handle('pazi:open-atende', (event) => { assertFromPanel(event); showWindow('atende'); return true; });
ipcMain.handle('pazi:open-panel', (event) => { assertFromPanel(event); showWindow('panel'); return true; });
ipcMain.handle('pazi:toggle-fullscreen', (event) => {
  assertFromPanel(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
  return win ? win.isFullScreen() : false;
});

// ---------------------------------------------------------------------------
// Ícone no relógio do Windows
// ---------------------------------------------------------------------------
function rebuildTrayMenu() {
  if (!tray) return;
  const focused = BrowserWindow.getFocusedWindow() || windows.panel;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(updateReadyVersion ? [
      { label: `Reiniciar para atualizar (versão ${updateReadyVersion})`, click: () => installUpdateNow() },
      { type: 'separator' },
    ] : []),
    { label: 'Abrir Pazi', click: () => showWindow('panel') },
    { label: 'Abrir Pazi Atende', click: () => showWindow('atende') },
    { type: 'separator' },
    {
      label: 'Tela cheia', type: 'checkbox', checked: !!(focused && focused.isFullScreen()),
      click: () => { const w = BrowserWindow.getFocusedWindow() || showWindow('panel'); w.setFullScreen(!w.isFullScreen()); },
    },
    {
      label: 'Iniciar com o Windows', type: 'checkbox', checked: !!settings.openAtLogin,
      click: (item) => {
        settings.openAtLogin = item.checked; saveSettings();
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [cfg.ARG_HIDDEN] });
      },
    },
    { label: 'Procurar atualização', click: () => checkUpdates(true) },
    { type: 'separator' },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { label: 'Sair do Pazi', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(iconPath());
  tray.setToolTip('Pazi');
  tray.on('click', () => showWindow('panel'));
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Atualização automática da casca (o sistema online já atualiza sozinho)
// ---------------------------------------------------------------------------
function notifyApp(title, body, onClick) {
  const n = new Notification({ title, body, icon: iconPath() });
  if (onClick) n.on('click', onClick);
  n.show();
}

function installUpdateNow() {
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
}

function checkUpdates(manual = false) {
  if (!app.isPackaged) return;
  if (manual && updateReadyVersion) {
    notifyApp('Atualização do Pazi pronta', `A versão ${updateReadyVersion} já foi baixada. Clique aqui para reiniciar e atualizar.`, installUpdateNow);
    return;
  }
  autoUpdater.checkForUpdates().then((r) => {
    if (manual && (!r || !r.updateInfo || r.updateInfo.version === app.getVersion())) {
      notifyApp('Pazi', 'Você já está na versão mais recente.');
    } else if (manual) {
      notifyApp('Pazi', `Baixando a versão ${r.updateInfo.version}… avisaremos quando estiver pronta.`);
    }
  }).catch((err) => {
    if (manual) notifyApp('Pazi', `Não foi possível procurar atualização: ${err.message}`);
  });
}

autoUpdater.autoDownload = true;
// Se a pessoa não reiniciar agora, a atualização instala sozinha quando o Pazi for fechado
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', (info) => {
  updateReadyVersion = info.version;
  rebuildTrayMenu();
  if (tray) tray.setToolTip(`Pazi — atualização ${info.version} pronta`);
  notifyApp('Atualização do Pazi pronta', `A versão ${info.version} foi baixada. Clique aqui para reiniciar e atualizar.`, installUpdateNow);
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  loadSettings();

  // Permissões: só para o painel do Pazi (notificações, microfone para áudio no Pazi Atende)
  const allowed = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isPanelUrl(wc.getURL()) && allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    !!wc && isPanelUrl(wc.getURL()) && allowed.has(permission));
  session.defaultSession.setSpellCheckerLanguages(['pt-BR']);

  createTray();
  createWindow('panel');
  if (process.argv.includes(cfg.ARG_ATENDE)) showWindow('atende');

  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
});

app.on('before-quit', () => { isQuitting = true; });
// Não encerra quando todas as janelas fecham: continua no relógio
app.on('window-all-closed', () => { /* fica rodando */ });
