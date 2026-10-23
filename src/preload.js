// Ponte segura entre o painel (painel.pazi.app) e o app de Windows.
// O painel detecta o app com:  if (window.paziDesktop?.isDesktop) { ... }

const { contextBridge, ipcRenderer } = require('electron');

const PANEL_HOST = 'painel.pazi.app';

if (location.host === PANEL_HOST) {
  contextBridge.exposeInMainWorld('paziDesktop', {
    isDesktop: true,

    /** { isDesktop, version, platform, window: 'panel' | 'atende' } */
    info: () => ipcRenderer.invoke('pazi:info'),

    /** Lista as impressoras instaladas no Windows. */
    listPrinters: () => ipcRenderer.invoke('pazi:list-printers'),

    /**
     * Imprime HTML direto, sem janela de impressão.
     * options: { deviceName?, copies?, widthMm? (80 = térmica), heightMm?, landscape? }
     */
    printHtml: (html, options) => ipcRenderer.invoke('pazi:print-html', html, options || {}),

    /** Notificação do Windows (silenciosa: o som é tocado pelo painel). kind: 'order' | 'message' */
    notify: (payload) => ipcRenderer.invoke('pazi:notify', payload || {}),

    /** Número no ícone da barra de tarefas (0 apaga). */
    setBadge: (count) => ipcRenderer.invoke('pazi:set-badge', count),

    openAtende: () => ipcRenderer.invoke('pazi:open-atende'),
    openPanel: () => ipcRenderer.invoke('pazi:open-panel'),
    toggleFullscreen: () => ipcRenderer.invoke('pazi:toggle-fullscreen'),
  });
}
