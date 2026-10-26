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
const { execFile } = require('child_process');
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

// O som do pedido precisa tocar mesmo que ninguém tenha clicado na janela
// (ex.: o Pazi abriu escondido ao ligar o computador). Sem isto o Chromium
// bloqueia o áudio até a primeira interação.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Não deixa o Windows "adormecer" o painel quando a janela está escondida/atrás de outras
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
// Visualizador interno de mídias (imagem, PDF, vídeo, áudio) — usado pelo Pazi Atende
// ---------------------------------------------------------------------------
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|pdf|mp4|webm|mov|m4v|3gp|ogg|oga|opus|mp3|m4a|aac|wav|amr)$/i;
const MEDIA_HOSTS = /(\.supabase\.co|\.supabase\.in|lookaside\.fbsbx\.com|\.whatsapp\.net|\.fbcdn\.net|\.cdninstagram\.com)$/i;

function isMediaUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:' || (u.protocol === 'data:' && /^data:(image|video|audio|application\/pdf)/i.test(url))) return true;
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    if (MEDIA_EXT.test(decodeURIComponent(u.pathname))) return true;
    // Arquivos do Supabase (storage e funções de mídia) e mídias da Meta/WhatsApp
    if (MEDIA_HOSTS.test(u.hostname)) {
      return u.hostname.includes('supabase') ? /\/(storage|functions)\/v1\//.test(u.pathname) : true;
    }
    return false;
  } catch { return false; }
}

let viewerWin = null;
function openMediaViewer(url, parent) {
  if (viewerWin && !viewerWin.isDestroyed()) {
    viewerWin.loadURL(url);
    if (viewerWin.isMinimized()) viewerWin.restore();
    viewerWin.show(); viewerWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  viewerWin = new BrowserWindow({
    width: Math.min(1100, area.width - 80),
    height: Math.min(800, area.height - 80),
    parent: parent || undefined,
    modal: false,
    title: 'Visualizar — Pazi',
    icon: iconPath('atende'),
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      plugins: true, // visualizador de PDF do próprio app
    },
  });
  viewerWin.setMenuBarVisibility(false);
  viewerWin.loadURL(url);

  // Dentro do visualizador nada navega para fora; links vão para o navegador
  viewerWin.webContents.setWindowOpenHandler(({ url: u }) => { openExternal(u); return { action: 'deny' }; });
  viewerWin.webContents.on('will-navigate', (e, u) => { if (!isMediaUrl(u)) { e.preventDefault(); openExternal(u); } });

  viewerWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'Escape') { viewerWin.close(); e.preventDefault(); }
    else if (ctrl && input.key.toLowerCase() === 's') { viewerWin.webContents.downloadURL(viewerWin.webContents.getURL()); e.preventDefault(); }
    else if (ctrl && (input.key === '=' || input.key === '+')) { viewerWin.webContents.setZoomLevel(viewerWin.webContents.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (ctrl && input.key === '-') { viewerWin.webContents.setZoomLevel(viewerWin.webContents.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (ctrl && input.key === '0') { viewerWin.webContents.setZoomLevel(0); e.preventDefault(); }
  });

  // Botão direito: salvar, copiar imagem, abrir no navegador
  viewerWin.webContents.on('context-menu', (_e, p) => {
    const current = viewerWin.webContents.getURL();
    const items = [];
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Copiar imagem', click: () => viewerWin.webContents.copyImageAt(p.x, p.y) });
    items.push(
      { label: 'Salvar arquivo…', click: () => viewerWin.webContents.downloadURL(p.srcURL || current) },
      { label: 'Abrir no navegador', enabled: /^https?:/.test(current), click: () => openExternal(current) },
      { type: 'separator' },
      { label: 'Fechar (Esc)', click: () => viewerWin.close() },
    );
    Menu.buildFromTemplate(items).popup({ window: viewerWin });
  });

  viewerWin.on('closed', () => { viewerWin = null; });
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
  win.webContents.on('did-finish-load', () => {
    if (updateStatus.state !== 'idle' && isPanelUrl(win.webContents.getURL())) win.webContents.send('pazi:update-status', { ...updateStatus, currentVersion: app.getVersion() });
  });

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
            backgroundThrottling: false,
          },
        },
      };
    }
    // Arquivo gerado na própria página (blob:): abre como janela filha, que enxerga o arquivo
    if (url.startsWith('blob:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100, height: 800, title: 'Visualizar — Pazi', icon: iconPath('atende'),
          backgroundColor: '#1f1f1f', autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true },
        },
      };
    }
    if (isMediaUrl(url)) { openMediaViewer(url, win); return { action: 'deny' }; }
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return; // tela "Sem conexão" do próprio app
    if (isPanelUrl(url)) return;
    e.preventDefault();
    if (isMediaUrl(url)) openMediaViewer(url, win);
    else openExternal(url);
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
    const media = (p.mediaType && p.mediaType !== 'none' && p.srcURL) ? p.srcURL : (p.linkURL && isMediaUrl(p.linkURL) ? p.linkURL : null);
    if (media) {
      items.push({ label: 'Abrir no visualizador', click: () => openMediaViewer(media, win) });
      items.push({ label: 'Salvar arquivo…', click: () => win.webContents.downloadURL(media) });
      if (p.mediaType === 'image') items.push({ label: 'Copiar imagem', click: () => win.webContents.copyImageAt(p.x, p.y) });
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
  return {
    isDesktop: true, version: app.getVersion(), platform: process.platform, window: kindOf(event.sender),
    // Recursos desta versão do app (o painel testa antes de usar)
    features: ['printHtml', 'printRaw', 'printerStatus', 'mediaViewer', 'updates'],
  };
});

// O Windows mantém a impressora "instalada" mesmo desligada/desconectada.
// Para saber se ela está de fato conectada, consulta o estado real no Windows.
// PrinterStatus do Win32_Printer: 3 pronta, 4 imprimindo, 5 aquecendo, 6 parada, 7 offline.
const VIRTUAL_PORTS = /^(PORTPROMPT:|nul:?|FILE:|SHRFAX:|XPSPort:|ONENOTE|WSD-?$)/i;
const VIRTUAL_NAMES = /(PDF|XPS|OneNote|Fax|Enviar para|Send To)/i;

function windowsPrinterStatus() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const cmd = 'Get-CimInstance Win32_Printer | Select-Object Name,WorkOffline,PrinterStatus,PortName,Network | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const raw = JSON.parse(stdout);
          const list = Array.isArray(raw) ? raw : [raw];
          const map = new Map();
          for (const p of list) if (p && p.Name) map.set(String(p.Name), p);
          resolve(map);
        } catch { resolve(null); }
      });
  });
}

ipcMain.handle('pazi:list-printers', async (event) => {
  assertFromPanel(event);
  const [list, status] = await Promise.all([event.sender.getPrintersAsync(), windowsPrinterStatus()]);
  return list.map((p) => {
    const st = status && status.get(p.name);
    const isVirtual = VIRTUAL_NAMES.test(p.name) || !!(st && VIRTUAL_PORTS.test(String(st.PortName || '')));
    // online: true = conectada · false = desconectada/desligada · null = não deu para saber
    let online = null;
    if (st) online = !st.WorkOffline && ![6, 7].includes(Number(st.PrinterStatus));
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      isVirtual,
      online,
      status: online === true ? 'online' : online === false ? 'offline' : 'unknown',
      port: st ? String(st.PortName || '') : '',
    };
  });
});

// ---------------------------------------------------------------------------
// Impressão nativa (ESC/POS) para térmicas: manda os bytes direto para a impressora
// pelo spooler do Windows (tipo RAW), sem transformar em imagem. Sai igual à prévia
// do painel: fonte da própria impressora, negrito real, colunas exatas e guilhotina.
// ---------------------------------------------------------------------------
const RAW_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class PaziRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "Impressora não encontrada (" + Marshal.GetLastWin32Error() + ")";
    try {
      var di = new DOCINFO { pDocName = "Pazi", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) return "Falha ao iniciar (" + Marshal.GetLastWin32Error() + ")";
      try {
        StartPagePrinter(h);
        int w; bool ok = WritePrinter(h, data, data.Length, out w);
        EndPagePrinter(h);
        if (!ok || w != data.Length) return "Falha ao enviar (" + Marshal.GetLastWin32Error() + ")";
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "ok";
  }
}
"@
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
[Console]::Out.Write([PaziRaw]::Send($env:PAZI_PRINTER, $bytes))
`;

// Comando codificado (UTF-16LE em base64): evita qualquer problema de aspas e quebras de linha
const RAW_PS_ENCODED = Buffer.from(RAW_PS, 'utf16le').toString('base64');
const printLogFile = () => path.join(app.getPath('userData'), 'pazi-impressao.log');
function logPrint(line) {
  try {
    const f = printLogFile();
    try { if (fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, ''); } catch { /* novo */ }
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* noop */ }
}

function sendRawToPrinter(deviceName, buffer) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Disponível só no Windows'));
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', RAW_PS_ENCODED],
      { timeout: 30000, windowsHide: true, env: { ...process.env, PAZI_PRINTER: deviceName }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (out.endsWith('ok')) { logPrint(`RAW ok "${deviceName}" ${buffer.length} bytes`); return resolve({ ok: true }); }
        const reason = out || String(stderr || '').trim().split('\n').slice(0, 3).join(' ') || (err && err.message) || 'Falha ao imprimir';
        logPrint(`RAW ERRO "${deviceName}": ${reason}`);
        reject(new Error(reason));
      });
    child.on('error', (e) => { logPrint(`RAW ERRO ao iniciar PowerShell: ${e.message}`); });
    child.stdin.on('error', () => { /* processo já saiu */ });
    child.stdin.end(buffer.toString('base64'));
  });
}

// Teste pelo menu do relógio: imprime um cupom curto em ESC/POS na impressora padrão
async function testRawPrint() {
  try {
    const win = windows.panel || BrowserWindow.getAllWindows()[0];
    const printers = win ? await win.webContents.getPrintersAsync() : [];
    const target = printers.find((p) => p.isDefault) || printers[0];
    if (!target) return notifyApp('Teste de impressão', 'Nenhuma impressora instalada no Windows.');
    const ESC = 0x1b, GS = 0x1d;
    const txt = (t) => Buffer.from(t, 'latin1');
    const bytes = Buffer.concat([
      Buffer.from([ESC, 0x40]), Buffer.from([ESC, 0x61, 1]),
      Buffer.from([ESC, 0x45, 1, GS, 0x21, 0x11]), txt('PAZI\n'),
      Buffer.from([GS, 0x21, 0x00, ESC, 0x45, 0]), txt('Teste de impressao direta\n'),
      txt('--------------------------------\n'),
      Buffer.from([ESC, 0x61, 0]), txt('Se voce le isto, a impressao\nnativa (ESC/POS) funciona.\n'),
      txt(`Impressora: ${target.name.slice(0, 40)}\n`),
      txt(`Versao do app: ${app.getVersion()}\n\n\n\n`),
      Buffer.from([GS, 0x56, 0x42, 0x00]),
    ]);
    await sendRawToPrinter(target.name, bytes);
    notifyApp('Teste de impressão', `Enviado para "${target.name}". Se não saiu nada, me avise.`);
  } catch (e) {
    notifyApp('Teste de impressão falhou', String(e.message || e).slice(0, 200), () => shell.showItemInFolder(printLogFile()));
  }
}

// data: Uint8Array/ArrayBuffer/number[] com os bytes ESC/POS, ou string base64
// options: { deviceName (obrigatório), copies? }
ipcMain.handle('pazi:print-raw', async (event, data, options = {}) => {
  assertFromPanel(event);
  let buf;
  if (typeof data === 'string') buf = Buffer.from(data, 'base64');
  else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
  else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (Array.isArray(data)) buf = Buffer.from(data);
  else throw new Error('Dados de impressão inválidos');
  if (!buf.length) throw new Error('Nada para imprimir');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Impressão muito grande');
  const deviceName = String(options.deviceName || '');
  if (!deviceName) throw new Error('Escolha a impressora');
  const printers = await event.sender.getPrintersAsync();
  if (!printers.some((p) => p.name === deviceName)) throw new Error('Impressora não encontrada');
  const copies = Math.max(1, Math.min(10, Number(options.copies) || 1));
  for (let i = 0; i < copies; i++) await sendRawToPrinter(deviceName, buf);
  return { ok: true };
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
      }, (success, reason) => {
        logPrint(`HTML ${success ? 'ok' : 'ERRO: ' + reason} "${options.deviceName || 'padrão'}"`);
        return success ? resolve({ ok: true }) : reject(new Error(reason || 'Falha ao imprimir'));
      });
    });
  } finally {
    if (!printWin.isDestroyed()) printWin.destroy();
  }
});

// Notificação do Windows. O SOM é tocado pelo painel (som escolhido nas configurações),
// por isso a notificação sai em silêncio.
// Guarda as notificações abertas: se o objeto for descartado da memória,
// o Windows mostra o aviso mas o CLIQUE não chega ao app.
const liveNotifications = new Set();

ipcMain.handle('pazi:notify', (event, payload = {}) => {
  assertFromPanel(event);
  const kind = payload.kind === 'message' ? 'atende' : kindOf(event.sender);
  const n = new Notification({
    title: String(payload.title || (kind === 'atende' ? 'Nova mensagem' : 'Novo pedido')).slice(0, 120),
    body: String(payload.body || '').slice(0, 300),
    icon: iconPath(kind),
    silent: true,
  });
  liveNotifications.add(n);
  const release = () => setTimeout(() => liveNotifications.delete(n), 60 * 60 * 1000);
  n.on('click', () => {
    liveNotifications.delete(n);
    const win = showWindow(kind);
    // Traz para a frente mesmo com outro programa em foco
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 300);
    if (payload.url) {
      try {
        const target = new URL(payload.url, cfg.PANEL_ORIGIN).href;
        if (isPanelUrl(target) && win.webContents.getURL() !== target) win.loadURL(target);
      } catch { /* url inválida: só abre a janela */ }
    }
  });
  n.on('close', release);
  n.on('failed', () => liveNotifications.delete(n));
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
    { label: 'Testar impressão direta (térmica)', click: () => testRawPrint() },
    { type: 'separator' },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { label: 'Sair do Pazi', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(iconPath());
  tray.setToolTip('Pazi');
  tray.on('click', () => showWindow('panel'));
  tray.on('double-click', () => showWindow('panel'));
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

// Estado da atualização, enviado ao painel para aparecer no sino
// state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
let updateStatus = { state: 'idle', currentVersion: null, version: null, percent: 0 };
function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch, currentVersion: app.getVersion() };
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed() && isPanelUrl(w.webContents.getURL())) w.webContents.send('pazi:update-status', updateStatus); } catch { /* noop */ }
  }
}

autoUpdater.on('checking-for-update', () => { if (updateStatus.state !== 'ready') setUpdateStatus({ state: 'checking' }); });
autoUpdater.on('update-available', (info) => setUpdateStatus({ state: 'downloading', version: info.version, percent: 0 }));
autoUpdater.on('update-not-available', () => { if (updateStatus.state !== 'ready') setUpdateStatus({ state: 'idle' }); });
autoUpdater.on('download-progress', (p) => setUpdateStatus({ state: 'downloading', percent: Math.round(p.percent || 0) }));
autoUpdater.on('error', () => { if (updateStatus.state !== 'ready') setUpdateStatus({ state: 'idle' }); });

ipcMain.handle('pazi:update-status', (event) => { assertFromPanel(event); return { ...updateStatus, currentVersion: app.getVersion() }; });
ipcMain.handle('pazi:install-update', (event) => {
  assertFromPanel(event);
  if (!updateReadyVersion) return false;
  setTimeout(installUpdateNow, 300);
  return true;
});
ipcMain.handle('pazi:check-update', (event) => { assertFromPanel(event); checkUpdates(false); return true; });

autoUpdater.autoDownload = true;
// Se a pessoa não reiniciar agora, a atualização instala sozinha quando o Pazi for fechado
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', (info) => {
  updateReadyVersion = info.version;
  setUpdateStatus({ state: 'ready', version: info.version, percent: 100 });
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
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({
      title: 'Salvar arquivo',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename() || 'arquivo'),
    });
    item.once('done', (_ev, state) => {
      if (state === 'completed') {
        const saved = item.getSavePath();
        notifyApp('Arquivo salvo', path.basename(saved), () => shell.showItemInFolder(saved));
      }
    });
  });

  createTray();
  createWindow('panel');
  if (process.argv.includes(cfg.ARG_ATENDE)) showWindow('atende');

  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
});

app.on('before-quit', () => { isQuitting = true; });
// Não encerra quando todas as janelas fecham: continua no relógio
app.on('window-all-closed', () => { /* fica rodando */ });
