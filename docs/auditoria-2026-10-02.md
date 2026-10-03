# Auditoria 2026-10-02: conversor-epub-pdf

Auditoria de teste (Vaga 0 das sessões cloud do Claude Cockpit). Nenhum código foi alterado. Ficheiros lidos por inteiro: `server.js`, `index.html`, `package.json`, `vercel.json`. Foram ainda consultados `package-lock.json` (apenas versões), o histórico git e o resultado de `npm audit --omit=dev`. O código de `node_modules/` não foi auditado.

## 1. O que o projeto faz e como se usa

Aplicação web minimalista que converte ficheiros EPUB em PDF. Tem duas peças:

- **Servidor** (`server.js`, Express 5 e multer 2): expõe um único endpoint, `POST /convert`, que recebe um ficheiro no campo `epubFile`, guarda-o temporariamente em `uploads/`, chama o `pandoc` por linha de comandos para gerar um PDF em `downloads/`, devolve o PDF como download e apaga os ficheiros temporários. Escuta na porta 3000.
- **Interface** (`index.html`, Tailwind via CDN): página estática em português com seletor de ficheiros (até 100 ficheiros, 300 MB cada, validados no cliente), lista com barras de progresso e botão "Converter Ficheiros". Envia os ficheiros um a um para `http://localhost:3000/convert` e descarrega cada PDF no navegador.

Uso local, tal como o código o permite hoje: instalar `pandoc` e um motor LaTeX (o `pandoc` precisa de um, por exemplo `xelatex`, para gerar PDF), executar `npm install` e `npm start`, criar manualmente a pasta `downloads/` (ver risco 2.2) e abrir o `index.html`. Não existe README nem documentação no repositório, pelo que esta descrição foi inferida do código.

O `vercel.json` indica a intenção de publicar no Vercel, mas a configuração não é viável (ver 2.5).

## 2. Riscos e dívida técnica

### 2.1 Injeção de comandos de shell (crítico)

- `server.js:32-33` e `server.js:41`: o nome do PDF de saída deriva de `req.file.originalname`, controlado pelo cliente, e é interpolado numa string passada a `exec` (shell) dentro de aspas duplas. Um nome de ficheiro com `"`, `$(...)` ou crases executa comandos arbitrários no servidor. O multer remove componentes de caminho, mas não neutraliza caracteres de shell.
- Alternativa segura: `execFile('pandoc', [inputPath, '-o', outputPath])` (sem shell) e nome de saída gerado pelo servidor.

### 2.2 A pasta `downloads/` não existe (a conversão falha de origem)

- `server.js:33` escreve em `downloads/`, mas essa pasta não está no repositório nem é criada no arranque. Num clone limpo, o `pandoc` falha na primeira conversão e o utilizador recebe um erro 500. A pasta `uploads/` só existe porque contém um `.DS_Store` versionado (`uploads/.DS_Store`).

### 2.3 A interface não é servida e depende de `localhost:3000`

- `server.js` não regista `express.static` nem rota `GET /`; `index.html` tem de ser aberto à parte.
- `index.html:162` tem o URL `http://localhost:3000/convert` fixo. Ao abrir o ficheiro por `file://` ou a partir de outra origem, o pedido é cross-origin e o servidor não envia cabeçalhos CORS, pelo que o navegador bloqueia-o. Em produção, o URL não funcionaria de todo. Deve usar-se `fetch('/convert')` e servir a página pelo mesmo servidor.

### 2.4 Ausência de limites e proteção contra abuso

- `server.js:15`: o multer usa `memoryStorage()` sem `limits`. A interface anuncia 300 MB por ficheiro, mas essa validação existe só no cliente (`index.html:69-70`, `130-133`) e é contornável. Um ficheiro grande ou vários em simultâneo esgotam a memória.
- Sem autenticação, sem limite de pedidos e sem validação do conteúdo (tipo MIME ou assinatura ZIP/EPUB) no servidor. O endpoint é um conversor aberto que lança processos pesados (`pandoc` com LaTeX).
- `server.js:12`: o timeout de 600 s é muito longo para um endpoint aberto, e `connect-timeout` apenas assinala o timeout, não interrompe o processo `pandoc` em curso. Depois de enviar o 503 (`server.js:21`), o `exec` continua, e o handler pode tentar responder outra vez ("headers already sent").

### 2.5 Configuração do Vercel inviável

- `vercel.json:3`: referencia `api/convert.js`, que não existe.
- `vercel.json:7-12`: mistura `functions` e `builds`, o que o Vercel rejeita, segundo o comportamento documentado da plataforma (não foi possível testar o deploy aqui).
- `vercel.json:13`: `installCommand` usa `sudo apt-get install pandoc texlive-*`. Os ambientes de build do Vercel não permitem `sudo` e o runtime serverless não inclui `pandoc` nem LaTeX; o sistema de ficheiros é só de leitura fora de `/tmp`. O histórico mostra cinco commits seguidos a tentar acertar este ficheiro. Este alvo de alojamento não serve este projeto; um contentor (Docker) num serviço com processos persistentes é a escolha adequada.
- `vercel.json` está indentado com 4 espaços e termina com linhas em branco (apenas estilo).

### 2.6 Concorrência e nomes de ficheiros temporários

- `server.js:30`: `temp-${Date.now()}.epub` pode colidir quando dois pedidos chegam no mesmo milissegundo.
- `server.js:33`: o PDF de saída usa o nome original do utilizador. Dois utilizadores a converter `livro.epub` ao mesmo tempo sobrepõem-se, e um deles pode receber o PDF do outro, que é depois apagado em `server.js:65`. Usar um identificador único (por exemplo `crypto.randomUUID()`) e um diretório temporário por pedido.
- Se o cliente abortar, ou se o `exec` falhar a meio, o PDF parcial em `downloads/` não é limpo (`server.js:48-52` só remove o ficheiro de entrada).
- Operações síncronas (`writeFileSync`, `existsSync`, `unlinkSync`) bloqueiam o event loop.

### 2.7 Segurança do front-end

- `index.html:103`: `${file.name}` é inserido em `innerHTML` sem escape. Um nome de ficheiro com HTML ou script é executado no navegador do próprio utilizador (XSS por nome de ficheiro; impacto limitado porque o ficheiro vem do utilizador, mas é má prática).
- `index.html:7`: Tailwind carregado de `cdn.tailwindcss.com` em runtime, sem versão fixa nem SRI. O próprio fornecedor desaconselha o uso em produção.

### 2.8 Defeitos funcionais da interface

- O texto "Arraste e solte ficheiros aqui" (`index.html:43`) promete drag and drop, mas não há handlers `dragover`/`drop`. Largar um ficheiro fora do `input` faz o navegador abri-lo.
- `index.html:146-152`: ao escolher ficheiros de novo, a lista anterior é substituída, não acumulada, e se todos forem inválidos a lista antiga mantém-se.
- `index.html:176`: `file.name.replace('.epub', '.pdf')` é sensível a maiúsculas (`.EPUB` não é substituído) e substitui a primeira ocorrência, não a extensão final.
- A barra de progresso é fictícia (20%, 60%, 100% fixos em `index.html:156,167,171`); o progresso real do upload e da conversão não é medido.
- `index.html:195-207`: cada mensagem substitui a anterior, pelo que os erros de ficheiros intermédios desaparecem; só se vê o resumo final. A mensagem final diz "concluída" em verde mesmo que todos tenham falhado.
- A conversão é sequencial e dispara até 100 descarregamentos seguidos, que muitos navegadores bloqueiam após o primeiro.
- Mensagem de erro do servidor (`server.js:51`) devolve o `stderr` do `pandoc` ao cliente, expondo caminhos internos do servidor.

### 2.9 Dependências e higiene do repositório

- `npm audit --omit=dev` (executado nesta sessão) reporta 4 vulnerabilidades (2 altas, 2 moderadas) nas versões instaladas: `multer` 2.0.2 (vários avisos de negação de serviço, GHSA-xf7r-hgr6-v32p e outros), `path-to-regexp` 8.x (ReDoS, GHSA-j3q9-mxjg-w52f), `body-parser` e `qs` (DoS). O próprio `npm audit` indica que `npm audit fix` resolve. Os números reportados dependem da base de dados de avisos no momento da execução.
- `node_modules/` está versionado (844 ficheiros) e não existe `.gitignore`. Isto incha o repositório e impede atualizações limpas. `.DS_Store` também está versionado (`.DS_Store`, `uploads/.DS_Store`).
- `package.json`: `description` e `author` vazios, `test` é o placeholder do npm, sem campo `engines`, sem `.nvmrc`. `vercel.json:5` pede `nodejs18.x`, versão já fora de suporte.
- Sem testes, sem CI, sem linting, sem README, sem licença explícita no repositório (apesar de `"license": "ISC"` em `package.json`).
- `server.js:9`: porta fixa 3000, em vez de `process.env.PORT`.
- Não há `process.on('SIGTERM')` nem verificação, no arranque, de que o `pandoc` e o motor LaTeX estão instalados.
- Comentário em `server.js:40` ("ALTERAÇÃO AQUI") é um resto de edição, e a mensagem de log ao utilizador mistura erros internos com respostas HTTP.

## 3. Melhorias por prioridade

### Alta

1. Eliminar a injeção de shell: substituir `exec` por `execFile` com array de argumentos e gerar o nome de saída no servidor (`server.js:32-41`).
2. Criar `downloads/` e `uploads/` no arranque (`fs.mkdirSync(..., { recursive: true })`) ou, melhor, usar `fs.mkdtemp` por pedido na pasta temporária do sistema.
3. Definir `limits` no multer (`fileSize`, `files`) em linha com o que a interface promete, e validar o tipo no servidor.
4. Atualizar dependências com `npm audit fix` e confirmar que o servidor arranca.
5. Remover `node_modules/` e `.DS_Store` do controlo de versões e acrescentar `.gitignore`.
6. Servir `index.html` a partir do próprio servidor (`express.static`) e usar `fetch('/convert')`.

### Média

1. Nomes únicos por pedido (`crypto.randomUUID()`) e limpeza garantida (bloco `finally`, evento `close` da resposta), com versões assíncronas das operações de ficheiros.
2. Cancelar o processo `pandoc` quando o pedido expira ou o cliente desliga, e reduzir o timeout para um valor realista.
3. Escapar `file.name` no `index.html` (usar `textContent`) e implementar drag and drop real.
4. Decidir o alojamento: remover o `vercel.json` atual e criar um `Dockerfile` com `pandoc` e LaTeX, ou trocar o motor de PDF por uma alternativa mais leve; documentar a escolha.
5. Escrever um README com requisitos (pandoc, motor LaTeX), instruções de arranque e limites.
6. Não devolver o `stderr` bruto ao cliente; registar no servidor e devolver uma mensagem genérica.
7. Autenticação ou limite de pedidos (por exemplo `express-rate-limit`) se for exposto na internet.

### Baixa

1. Progresso real de upload (`XMLHttpRequest` ou `fetch` com streams) e, se possível, processamento em paralelo limitado.
2. Entregar vários PDFs num único ZIP em vez de dezenas de descarregamentos.
3. Compilar o CSS do Tailwind em vez de usar o CDN em runtime; fixar versões e SRI.
4. Preencher `package.json` (descrição, `engines`, scripts `lint` e `test`), usar `process.env.PORT`.
5. Testes de integração com um EPUB de exemplo e CI no GitHub Actions.
6. Acumular ficheiros em seleções sucessivas, mostrar erros por ficheiro e corrigir o estado final ("concluída" só quando houver sucessos).
7. Tratar a extensão com expressão regular `/\.epub$/i`.

## 4. O que não foi possível verificar

- **Execução ponta a ponta.** Embora o `pandoc` 3.1.3 e o `xelatex` estejam instalados neste ambiente, não foi executada uma conversão real nem foi iniciado o servidor, porque a tarefa pedia leitura e não alteração; as conclusões sobre a falta de `downloads/`, o CORS e a injeção resultam da leitura do código, não de reprodução.
- **Qualidade do PDF.** Não foi avaliado o resultado visual do `pandoc` com EPUB reais (imagens, capas, índices, tipos de letra, EPUB com DRM).
- **Comportamento no Vercel.** O deploy não foi tentado; as afirmações sobre `sudo`, sistema de ficheiros e combinação `functions`/`builds` baseiam-se no conhecimento da plataforma e não foram confirmadas contra a documentação atual nesta sessão.
- **Estado real do alojamento.** Desconhece-se se existe uma instalação em produção e como está configurada.
- **Código de `node_modules/`.** Não foi auditado; apenas as versões e o relatório do `npm audit`.
- **Responsividade e acessibilidade.** A interface não foi aberta num navegador; não foram testados leitores de ecrã, contraste, nem o comportamento em telemóvel.
- **Origem do ficheiro, licenças e requisitos de negócio.** Não há documentação que diga quem usa a aplicação, volumes esperados ou requisitos legais.
