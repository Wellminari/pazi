// Configurações fixas da casca do Pazi para Windows.
// O sistema em si continua online: a casca só abre o painel numa janela própria.

const PANEL_ORIGIN = 'https://painel.pazi.app';

module.exports = {
  PANEL_ORIGIN,
  PANEL_HOST: new URL(PANEL_ORIGIN).host,
  PANEL_URL: `${PANEL_ORIGIN}/`,
  ATENDE_URL: `${PANEL_ORIGIN}/whatsapp-chat`,

  // Ids do Windows (barra de tarefas e notificações). Cada janela tem o seu,
  // assim o Pazi Atende aparece separado na barra de tarefas.
  APP_ID_PANEL: 'app.pazi.desktop',
  APP_ID_ATENDE: 'app.pazi.desktop.atende',

  // Argumento usado pelo atalho "Pazi Atende" criado pelo instalador.
  ARG_ATENDE: '--atende',
  // Argumento usado ao iniciar com o Windows (abre escondido no relógio).
  ARG_HIDDEN: '--hidden',
};
