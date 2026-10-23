# Pazi para Windows

App de computador do Pazi. É uma "casca": abre o `painel.pazi.app` numa janela própria.
O sistema continua online — tudo que for publicado no Lovable aparece aqui sozinho.

## O que ele faz
- **Pazi** (painel) e **Pazi Atende** (WhatsApp) em janelas separadas, com dois atalhos no Windows.
- **Fechar a janela só esconde**: o Pazi fica no relógio do Windows e continua tocando o som de pedido e de mensagem.
- **Tela cheia**: F11 (ou pelo ícone no relógio). Lembra a escolha.
- **Iniciar com o Windows**: opção no ícone do relógio (abre escondido).
- **Impressão direta e notificações**: disponíveis para o painel pela ponte `window.paziDesktop` (ver abaixo).
- **Atualização automática** da casca a partir das versões publicadas em Releases.

Atalhos: F5 recarrega · Ctrl + / Ctrl - / Ctrl 0 zoom · F11 tela cheia · Ctrl+Shift+I ferramentas.

## Ponte para o painel (`window.paziDesktop`)
Só existe quando o painel está aberto dentro do app (em `painel.pazi.app`).

```js
if (window.paziDesktop?.isDesktop) {
  await window.paziDesktop.info();                    // { version, platform, window: 'panel' | 'atende' }
  await window.paziDesktop.listPrinters();            // [{ name, displayName, isDefault }]
  await window.paziDesktop.printHtml(html, {          // imprime sem janela de impressão
    deviceName: 'EPSON TM-T20', widthMm: 80, copies: 1,
  });
  await window.paziDesktop.notify({                   // notificação do Windows (silenciosa)
    kind: 'order', title: 'Novo pedido #123', body: 'Maria — R$ 99,00', url: '/orders/ID',
  });
  await window.paziDesktop.setBadge(3);               // bolinha no ícone da barra de tarefas
  await window.paziDesktop.openAtende();
  await window.paziDesktop.toggleFullscreen();
}
```

## Link fixo para baixar (sempre a versão mais recente)
https://github.com/Wellminari/pazi/releases/latest/download/Pazi-Setup.exe

## Como gerar o instalador
1. No GitHub: aba **Actions** > **Gerar instalador** > **Run workflow**.
2. Ao terminar, baixe o arquivo **Pazi-Setup** no fim da página da execução.

## Como lançar uma versão nova (atualiza os clientes sozinho)
1. Aumente `"version"` no `package.json` (ex.: 0.2.0 → 0.2.1).
2. Actions > **Gerar instalador** > Run workflow, marcando **publicar**.
3. Os apps instalados baixam sozinhos e avisam "Atualização do Pazi pronta" (instala ao reiniciar ou ao fechar o Pazi).

## Certificado do Windows
Sem certificado de assinatura, o Windows mostra "O Windows protegeu o computador" na instalação:
clique em **Mais informações > Executar assim mesmo**. Para distribuir a todos os clientes, assinar o instalador.

## Ícone
Se existir `build/icon.ico` no repositório, ele é usado. Senão, o GitHub baixa a logo do painel e gera o ícone.
