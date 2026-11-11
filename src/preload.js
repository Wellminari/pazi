// Ponte segura entre o painel (painel.pazi.app) e o app de Windows.
// O painel detecta o app com:  if (window.paziDesktop?.isDesktop) { ... }

const { contextBridge, ipcRenderer } = require('electron');

const PANEL_HOST = 'painel.pazi.app';

if (location.host === PANEL_HOST) {
  contextBridge.exposeInMainWorld('paziDesktop', {
    isDesktop: true,

    /** { isDesktop, version, platform, window: 'panel' | 'atende', features: string[] } */
    info: () => ipcRenderer.invoke('pazi:info'),

    /** Lista as impressoras instaladas no Windows. */
    listPrinters: () => ipcRenderer.invoke('pazi:list-printers'),

    /**
     * Imprime HTML direto, sem janela de impressão.
     * options: { deviceName?, copies?, widthMm? (80 = térmica), heightMm?, landscape? }
     */
    printHtml: (html, options) => ipcRenderer.invoke('pazi:print-html', html, options || {}),

    /**
     * Impressão nativa para térmicas (ESC/POS): manda os bytes direto para a impressora,
     * sem virar imagem. data: Uint8Array | number[] | base64. options: { deviceName, copies? }
     */
    printRaw: (data, options) => ipcRenderer.invoke('pazi:print-raw', data, options || {}),

    /** Notificação do Windows (silenciosa: o som é tocado pelo painel). kind: 'order' | 'message' */
    notify: (payload) => ipcRenderer.invoke('pazi:notify', payload || {}),

    /** Número no ícone da barra de tarefas (0 apaga). */
    setBadge: (count) => ipcRenderer.invoke('pazi:set-badge', count),

    openAtende: () => ipcRenderer.invoke('pazi:open-atende'),
    openPanel: () => ipcRenderer.invoke('pazi:open-panel'),
    toggleFullscreen: () => ipcRenderer.invoke('pazi:toggle-fullscreen'),

    /**
     * Atualização do app (para mostrar no sino).
     * status: { state: 'idle'|'checking'|'downloading'|'ready', currentVersion, version, percent }
     */
    getUpdateStatus: () => ipcRenderer.invoke('pazi:update-status'),
    /** Avisa sempre que o estado muda. Devolve uma função para parar de ouvir. */
    onUpdateStatus: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_e, status) => { try { callback(status); } catch { /* noop */ } };
      ipcRenderer.on('pazi:update-status', handler);
      return () => ipcRenderer.removeListener('pazi:update-status', handler);
    },
    /** Reinicia o app e instala a versão baixada (só funciona com state === 'ready'). */
    installUpdate: () => ipcRenderer.invoke('pazi:install-update'),
    checkForUpdate: () => ipcRenderer.invoke('pazi:check-update'),

    /** Este PC é a estação de impressão do tenant? { isStation } */
    getStation: () => ipcRenderer.invoke('pazi:get-station'),
    setStation: (isStation) => ipcRenderer.invoke('pazi:set-station', !!isStation),
  });

  // Faixa no topo quando a internet cai: a tela continua com os últimos dados.
  // Some sozinha quando a conexão volta.
  const BANNER_ID = 'pazi-sem-internet';
  const showBanner = (online) => {
    const old = document.getElementById(BANNER_ID);
    if (online) { if (old) old.remove(); return; }
    if (old) return;
    const bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', 'status');
    bar.textContent = 'Sem internet: os dados podem estar desatualizados. O Pazi reconecta sozinho.';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 16px;background:#be185d;color:#fff;font:600 13px/1.4 system-ui,"Segoe UI",sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    (document.body || document.documentElement).appendChild(bar);
  };
  ipcRenderer.on('pazi:connection', (_e, state) => showBanner(!!(state && state.online)));
}
