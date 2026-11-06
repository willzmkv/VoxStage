# Changelog

## Novidades da 2.1.0

- **Sincronização Automática com IA Local (Whisper AI)**:
  - Alinhamento automático inteligente de letras com precisão no nível de palavras (*word-level timing*), sem depender do MVSEP e 100% offline.
  - Modelo Whisper neural integrado localmente com resolução acústica fonema por fonema.
  - Barra de progresso visual em tempo real integrada à interface com estilo monocromático nativo.
  - Suporte completo a músicas personalizadas, geradas por IA (Suno, Udio) ou sem correspondência no catálogo online.
- **Retorno de Voz em Tempo Real com Efeitos de Estúdio**:
  - Novo recurso de monitoramento vocal para ouvir a própria voz ao cantar.
  - Processador de áudio com Reverb de estúdio (convolução estéreo), Delay/Eco sutil e presença vocal (equalização paramétrica e compressão).
  - Controle de volume independente do microfone e botão de alternância rápida na HUD do palco.
- **Correções Críticas**:
  - Correção do travamento de mouse no Windows em tela cheia na sincronização manual.
  - Correção na resolução de URLs de mídia para evitar erros de leitura de áudio.
  - Resolução definitiva de erros de propriedades indefinidas de tempos de versos no reprodutor.

## Novidades da 2.0

- Interface renovada para cada plataforma: biblioteca e fila lateral no PC, navegação inferior no Android e menus adaptados ao controle remoto na TV. Adição de músicas guiada, configurações reorganizadas e pareamento com mais espaço.
- Editor com Voz 1, Voz 2 e Backing independentes: editar ou sincronizar uma voz preserva as demais. Letras com () e [] podem ser separadas automaticamente entre as vozes.
- Duetos com uma única linha e ponto em gradiente nas palavras compartilhadas. Falas diferentes da segunda voz ficam separadas, sem deslocar a letra principal.
- Sincronização manual com início e fim das frases, intervalos entre trechos, marcação de palavras com hífen e cancelamento que preserva os tempos existentes. Censura organizada por voz.
- Capas pelo Apple/iTunes, Cover Art Archive sob demanda e miniaturas do YouTube. Busca pelo título, reaproveitamento de resultados e aplicação automática da miniatura da música escolhida, preservando capas manuais.
- Exportação de músicas individuais ou da biblioteca em .voxstage.zip, com áudio, imagens, letras e sincronização. Importação com prévia e restauração opcional de preferências.
- Fila editável e continuação pela ordem da biblioteca; filtros de letras prontas, favoritas e músicas ocultas. Opção de baixar o vídeo junto da música e remoção de anexos adicionados por engano.
- Palco com controles compactos, fontes e cores personalizáveis, ocultamento manual independente do mouse e cursor oculto após cinco segundos de inatividade. Na TV, navegação por setas revisada, retorno de foco ao fechar menus e play direto no palco.
- Introdução guiada e Guia de uso com ajuda sobre sincronização, pontuação, conexão entre aparelhos e erros comuns. A TV abre diretamente na conexão com o celular.
- O processamento local de separação e alinhamento foi removido. A separação usa MVSEP; músicas completas e faixas já separadas continuam funcionando sem processamento.

O YouTube ainda pode exigir confirmação de robô em algumas redes. Na pontuação, fones de ouvido ajudam a evitar que o som da música encubra a voz ou seja contado como canto.

## Novidades da 1.1.2

- Busca de capas com recuperação de falhas de conexão, cache, proteção contra buscas duplicadas e espera indicada quando o serviço estiver indisponível.
- Extrator do YouTube atualizado no Windows, Android e Google TV para acompanhar as mudanças do serviço.
- Menos consultas repetidas: artista e álbum vêm da busca do YouTube Music, sem abrir cada resultado; pesquisas recentes são reaproveitadas e o download começa sem uma consulta extra de metadados.
- Requisições espaçadas e pausa temporária quando o YouTube pede confirmação de robô, evitando tentativas em sequência. Alguns bloqueios por rede ainda podem exigir aguardar, trocar de rede ou importar o áudio de outra forma.

Se não houverem mais bugs críticos, essa será a última versão do app. Ele já tem todas as features que minha mente queria que tivesse, e na medida do possível, está estavel para uso em todas as frentes (as que eu pude testar, que não incluiam processamento local no PC como exemplo).

## Novidades da 1.1.1

- Pontuação mais compacta no Android em paisagem, com controles ocultos ao começar e acesso rápido para mostrá-los novamente. Tocar na letra com os controles ocultos pausa ou continua a música.
- Motor JavaScript integrado no Android/Google TV para os desafios do YouTube, com recuperação de falhas e tentativas alternativas. Bloqueios por aparelho ou rede ainda podem exigir importar o áudio de outra forma.
- Filtro do microfone de −80 a −6 dB, ajustável durante o canto, com indicação do nível captado e recomendação de fones para reduzir o vazamento da música.

**Sobre a experiência no celular:** peço desculpas pelas dificuldades com a pontuação. Estes ajustes ajudaram, mas ainda não posso garantir uma experiência tão boa quanto no PC/TV. Recomendo fones de ouvido; o som dos alto-falantes pode encobrir sua voz ou contar como canto.

## Novidades da 1.1

- Pontuação de canto com notas sustentadas, microfone local, referências por ambos os vocais ou pelas três trilhas, início automático da música e histórico local.
- Pontos cumulativos: 1.000 por nota acertada, sem perder pontos. Estrelas em 9/18/27/36/45%; cinco estrelas douradas em 55%.
- Velocidade de 0,75× a 1,25× e tom de −4 a +4 semitons em tempo real, com letras e pontuação acompanhando os ajustes.
- Celular conectado como microfone do PC/TV, além da captura nativa no Android. Essa integração ainda precisa de avaliação em aparelhos físicos.
- Faixa de notas adaptada ao Android vertical/horizontal e à TV, com letras opcionais e controles compactos.
- Preenchimento automático pelo YouTube, correções de metadados do YouTube Music, melhor reconhecimento do instrumental no MVSEP e botão Acoplar arquivos.
- Busca automática de letras com recuperação de falhas temporárias; pausas instrumentais preservam o texto e respeitam a sincronização dos trechos cantados.
- Aba Sobre com logo, versão, autor, inspiração e atribuições; links abrem o navegador e as configurações ficam mais organizadas.

## 1.0.2

Primeira versão pública para Windows, Android e Google TV.

- Controles rápidos para sair e ocultar a apresentação; melhorias na censura em tela cheia.
- Aceitação automática de músicas disponíveis e transferência entre celular, PC e TV.
- Tela de envios em andamento e notificações de processamento no Android.
- Configurações em abas verticais e melhorias no pareamento, na biblioteca e nos textos da interface.
