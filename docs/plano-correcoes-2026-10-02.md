# Plano de correções 2026-10-02: conversor-epub-pdf

Plano derivado de `docs/auditoria-2026-10-02.md` (branch `claude/auditoria-2026-10-02`, PR #1). Base: `main` no commit `cb280f0`. Nenhum código foi alterado por este documento.

**Estado de verificação.** Confirmado por leitura de `server.js`, `index.html`, `package.json` e `vercel.json` nesta sessão: as linhas citadas abaixo correspondem ao código em `main`, e `node_modules/` tem 844 ficheiros versionados em `main` (`git ls-tree`). Não confirmado: execução do servidor, resultado de `npm audit` (vem da auditoria), comportamento do Vercel. Os testes propostos não foram corridos; são o critério de aceitação de cada correção.

**Ordem de execução.** P0 antes de qualquer exposição em rede. P1 antes de publicar. P2 e P3 conforme capacidade. Cada item é um commit independente, na ordem indicada, porque alguns dependem de anteriores (assinalado).

## P0 - Bloqueadores de segurança e de arranque

### P0.1 Injeção de comandos de shell (auditoria 2.1)

- Ficheiro e linhas: `server.js:3`, `server.js:32-33`, `server.js:41-43`.
- Alteração: importar `execFile` em vez de `exec`; chamar `execFile('pandoc', [inputPath, '-o', outputPath, '--pdf-engine=xelatex'], { maxBuffer: ... }, cb)`, sem shell. Gerar `outputPath` no servidor (ver P1.1) e usar `req.file.originalname` apenas para o nome de descarga, sanitizado (`res.download(outputPath, safeName)`, com `safeName` limitado a `[A-Za-z0-9._ -]`). Remover o comentário residual de `server.js:40`.
- Teste de verificação: enviar um EPUB válido com o nome `x"; touch /tmp/pwned; ".epub` (e outro com `$(touch /tmp/pwned2).epub`) por `curl -F 'epubFile=@livro.epub;filename=...' localhost:3000/convert`. Esperado: `/tmp/pwned` e `/tmp/pwned2` não existem; a resposta é um PDF ou um erro limpo. Antes da correção, o mesmo teste deve criar os ficheiros (reproduz o defeito).

### P0.2 Pastas `uploads/` e `downloads/` inexistentes (auditoria 2.2)

- Ficheiro e linhas: `server.js:30-33`, `server.js:75`.
- Alteração: substituir as pastas fixas por `fs.promises.mkdtemp(path.join(os.tmpdir(), 'epub-'))` por pedido, onde se escrevem entrada e saída (ver P1.1). Se se mantiverem pastas fixas, `fs.mkdirSync(..., { recursive: true })` no arranque, antes de `app.listen`.
- Teste de verificação: `git clone` limpo, `npm ci`, `npm start`, converter um EPUB de exemplo. Esperado: HTTP 200 e PDF válido (`file saida.pdf` indica "PDF document"), sem criar pastas à mão. Ao terminar, a pasta temporária do pedido já não existe.

### P0.3 Limites e validação no servidor (auditoria 2.4)

- Ficheiro e linhas: `server.js:15`; cliente em `index.html:69-70`, `130-133`.
- Alteração: `multer({ storage: multer.diskStorage(...) /* ou pasta temporária */, limits: { fileSize: 300 * 1024 * 1024, files: 1 }, fileFilter })`, com `fileFilter` a aceitar apenas extensão `.epub` (comparação sem distinção de maiúsculas). Após a gravação, verificar a assinatura ZIP (`PK\x03\x04`) nos primeiros 4 bytes. Tratar `MulterError` com HTTP 413 e mensagem fixa. Passar de `memoryStorage` para disco evita 300 MB por pedido em RAM.
- Teste de verificação: (a) enviar ficheiro de 301 MB, esperado 413; (b) enviar um `.txt` renomeado `.epub`, esperado 400 antes de lançar o `pandoc` (confirmar nos logs que o `pandoc` não foi chamado); (c) enviar dois ficheiros no mesmo pedido, esperado erro de limite.

### P0.4 Dependências vulneráveis (auditoria 2.9)

- Ficheiro: `package.json:34-38`, `package-lock.json`.
- Alteração: `npm audit fix`, rever o diff do `package-lock.json`, e fixar as versões resultantes. Não usar `--force` sem rever o impacto.
- Teste de verificação: `npm audit --omit=dev` sem avisos altos; `npm start` arranca; repetir o teste de P0.2.

### P0.5 Higiene do repositório (auditoria 2.9)

- Ficheiros: raiz do repositório (falta `.gitignore`), `node_modules/` (844 ficheiros), `.DS_Store`, `uploads/.DS_Store`.
- Alteração: criar `.gitignore` com `node_modules/`, `.DS_Store`, `uploads/`, `downloads/`, `.env`; executar `git rm -r --cached node_modules .DS_Store uploads/.DS_Store`. Fazer num commit separado (ruído grande no diff). Não reescrever histórico.
- Teste de verificação: `git ls-files | grep -c node_modules` devolve 0; num clone novo, `npm ci` recria a pasta e o servidor arranca. Como `git rm --cached` apaga `node_modules/` das cópias de trabalho de quem faça `pull`, avisar antes quem trabalhe no repositório.

## P1 - Corretude e robustez antes de publicar

### P1.1 Nomes únicos e limpeza garantida (auditoria 2.6)

- Ficheiro e linhas: `server.js:30-33`, `43-52`, `60-67`.
- Alteração: um diretório temporário por pedido (`mkdtemp`), nomes `in.epub` e `out.pdf` lá dentro, e `fs.promises.rm(dir, { recursive: true, force: true })` num `finally` e no evento `res.on('close')`. Trocar `writeFileSync`, `existsSync` e `unlinkSync` por equivalentes assíncronos. Depende de P0.1 e P0.2 (resolve-os em conjunto).
- Teste de verificação: lançar dois pedidos simultâneos com ficheiros diferentes mas o mesmo nome (`livro.epub`) e confirmar que cada resposta é o PDF do seu próprio ficheiro (comparar `pdftotext` com o conteúdo de cada EPUB). Abortar um pedido a meio (`curl --max-time 1`) e confirmar que `os.tmpdir()` não fica com pastas `epub-*` órfãs.

### P1.2 Timeout que interrompe o `pandoc` (auditoria 2.4)

- Ficheiro e linhas: `server.js:12`, `18-23`, `43`.
- Alteração: guardar o `ChildProcess` devolvido por `execFile` e chamar `child.kill('SIGKILL')` quando o pedido expira ou `res` fecha antes de terminar. Usar a opção `timeout` do `execFile` (valor sugerido: 120 s, a ajustar após medir o EPUB típico). Proteger as respostas com `if (res.headersSent) return;` para evitar "headers already sent" após o 503. Reduzir `timeout('600s')`.
- Teste de verificação: com um EPUB grande (ou `pandoc` substituído por `sleep 300` numa variável de ambiente de teste), confirmar que ao fim do timeout o cliente recebe 503, `pgrep pandoc` não devolve nada e o log não mostra "headers already sent".

### P1.3 Servir a interface e usar URL relativo (auditoria 2.3)

- Ficheiro e linhas: `server.js` (falta registo estático, junto a `server.js:12`); `index.html:162`.
- Alteração: mover `index.html` para `public/index.html` e acrescentar `app.use(express.static(path.join(__dirname, 'public')))`; em `index.html:162` trocar `'http://localhost:3000/convert'` por `'/convert'`.
- Teste de verificação: abrir `http://localhost:3000/` no navegador, converter um EPUB e descarregar o PDF sem erros CORS na consola. Abrir pelo IP da rede local de outra máquina e confirmar que também funciona (URL deixou de ser fixo).

### P1.4 Não expor `stderr` do `pandoc` ao cliente (auditoria 2.8)

- Ficheiro e linhas: `server.js:51`.
- Alteração: registar `stderr` no servidor e devolver `'Erro na conversão. Verifique se o ficheiro EPUB é válido.'` com um identificador de pedido (`crypto.randomUUID()`) que também vai para o log.
- Teste de verificação: enviar um `.epub` corrompido (ZIP válido mas sem estrutura EPUB) e confirmar que a resposta não contém caminhos do servidor (`grep -c '/home\|/tmp'` na resposta devolve 0) e que o log contém o `stderr`.

### P1.5 Decisão de alojamento e `vercel.json` (auditoria 2.5)

- Ficheiro e linhas: `vercel.json:1-20` (inteiro).
- Alteração: decisão a tomar pelo responsável do projeto (ver "Decisões pendentes"). Recomendação: remover `vercel.json` e criar um `Dockerfile` (imagem Node LTS com `pandoc`, `texlive-xetex`, `librsvg2-bin`) para um serviço com processos persistentes. Se se mantiver o Vercel, o ficheiro tem de ser reescrito de raiz, e nada garante que o `pandoc` e o LaTeX possam correr lá (não verificado nesta sessão).
- Teste de verificação: `docker build` e `docker run -p 3000:3000`, repetir o teste de P0.2 contra o contentor. Esperado: PDF válido.

## P2 - Front-end e operação

### P2.1 XSS por nome de ficheiro e uso de `innerHTML` (auditoria 2.7)

- Ficheiro e linhas: `index.html:94-103` (e `index.html:81`, `86`, que só limpam o contentor).
- Alteração: construir os nós com `document.createElement` e atribuir `file.name` por `textContent`; manter `innerHTML` apenas para estrutura estática sem dados do utilizador.
- Teste de verificação: selecionar um ficheiro chamado `<img src=x onerror=alert(1)>.epub` (criado no sistema de ficheiros); esperado: o nome aparece como texto e nenhum `alert` dispara.

### P2.2 Drag and drop real (auditoria 2.8)

- Ficheiro e linhas: `index.html:43` (texto), `index.html:145-152` (listener `change`).
- Alteração: acrescentar listeners `dragover` (com `preventDefault`) e `drop` na zona de seleção, encaminhando `event.dataTransfer.files` para `validateFiles`. Ou, alternativa mínima, remover do texto a promessa "Arraste e solte".
- Teste de verificação: arrastar dois EPUB para a zona e confirmar que aparecem na lista; arrastar um EPUB para fora da zona e confirmar que o navegador não o abre.

### P2.3 Estado final e mensagens por ficheiro (auditoria 2.8)

- Ficheiro e linhas: `index.html:73-83` (`showMessage` substitui), `195-209`.
- Alteração: acumular mensagens (acrescentar em vez de limpar), mostrar o estado por ficheiro na própria linha da lista, e na mensagem final usar tipo `success` só se `successfulConversions > 0`, `error` se for 0, e texto explícito "X de Y".
- Teste de verificação: com o servidor parado, converter 2 ficheiros: esperado mensagem final vermelha "0 de 2", não verde "concluída". Com um ficheiro válido e um inválido: ambas as mensagens individuais visíveis no fim.

### P2.4 Acumular seleções e extensão por expressão regular (auditoria 2.8)

- Ficheiro e linhas: `index.html:146-152` (substitui a lista), `index.html:176`.
- Alteração: no `change`, concatenar os válidos novos a `filesToConvert` respeitando `MAX_FILES`, e se nenhum for válido manter a lista mas com a mensagem de erro; em `index.html:176` usar `file.name.replace(/\.epub$/i, '.pdf')`.
- Teste de verificação: selecionar `a.epub`, depois `b.epub`: lista com 2. Converter `Livro.EPUB`: o descarregado chama-se `Livro.pdf`. Selecionar 101 ficheiros no total: o 101.º é recusado com mensagem.

### P2.5 Limite de pedidos (auditoria 2.4)

- Ficheiro e linhas: `server.js`, antes da rota `/convert` (por volta de `server.js:17`); `package.json` (nova dependência `express-rate-limit`).
- Alteração: limitar por IP (valores iniciais a validar com o uso real) e, se o serviço for exposto, autenticação por chave ou por proxy. Limitar o número de conversões simultâneas (fila simples ou contador) porque cada uma lança `pandoc` com LaTeX.
- Teste de verificação: 20 pedidos em paralelo com `xargs -P 20 curl ...`; esperado: parte recebe 429 ou espera em fila, e o consumo de CPU e memória não excede o limite definido.

### P2.6 Verificação de pré-requisitos no arranque e porta por ambiente (auditoria 2.9)

- Ficheiro e linhas: `server.js:9`, `server.js:75-77`.
- Alteração: `const port = process.env.PORT || 3000`; no arranque, executar `pandoc --version` e `xelatex --version` com `execFile`, e terminar com mensagem clara se faltarem. Tratar `SIGTERM` com `server.close()`.
- Teste de verificação: `PORT=4000 npm start` escuta em 4000; num ambiente sem `pandoc` o processo termina com código diferente de zero e mensagem a indicar o que falta.

## P3 - Qualidade e manutenção

- **P3.1 Tailwind sem CDN em runtime** (`index.html:7`, auditoria 2.7): compilar o CSS (CLI do Tailwind) para `public/`, ou fixar versão e SRI. Teste: a página carrega sem pedidos a `cdn.tailwindcss.com` (separador Rede do navegador).
- **P3.2 `package.json`** (`package.json:4-33`, auditoria 2.9): preencher `description`, `author`, `engines` (Node LTS suportado), scripts `test` e `lint`. Substituir o `nodejs18.x` de `vercel.json:5` só se o ficheiro se mantiver. Teste: `npm test` deixa de ser o placeholder e termina com código 0.
- **P3.3 README e licença**: documentar requisitos (`pandoc`, `xelatex`), arranque, limites e decisão de alojamento; acrescentar ficheiro `LICENSE` coerente com `"license": "ISC"`. Teste: seguir o README num clone limpo sem ajuda externa.
- **P3.4 Testes de integração e CI**: um EPUB de exemplo em `test/fixtures/`, teste com `node --test` (ou equivalente) que chama `/convert` e valida a assinatura `%PDF`, e um workflow GitHub Actions que instala `pandoc` e `texlive-xetex`. Inclui os casos de P0.1 (nomes maliciosos) e P0.3 (limites). Teste: o workflow passa em verde num PR.
- **P3.5 Progresso real e entrega em ZIP** (`index.html:156,167,171`, auditoria 2.8): `XMLHttpRequest` com `upload.onprogress`, ou `fetch` com streams; entregar vários PDFs num ZIP único em vez de até 100 descarregamentos. Teste: a barra acompanha o envio de um ficheiro de 100 MB; 10 conversões resultam num único descarregamento.
- **P3.6 Conversão paralela limitada** (`index.html:197-206`): processar 2 a 3 ficheiros em simultâneo, respeitando o limite do servidor de P2.5. Teste: tempo total de 6 ficheiros inferior ao sequencial, sem 429 nem erros.

## Decisões pendentes (do responsável do projeto)

1. **Alojamento.** Pergunta: onde correr o serviço. Contexto: o `vercel.json` atual é inviável (auditoria 2.5) e a escolha condiciona P1.5, P2.5 e P3.4. Opções: (a) contentor Docker num serviço com processos persistentes; (b) apenas uso local, removendo `vercel.json`. Recomendação: (a) se o serviço for aberto a terceiros; (b) se for ferramenta pessoal, porque evita custo fixo e superfície de ataque.
2. **Exposição pública.** Pergunta: o endpoint é aberto na internet. Contexto: define se P2.5 (limites e autenticação) é obrigatório. Opções: uso privado atrás de autenticação ou rede interna; público com limite de pedidos. Recomendação: privado, porque cada pedido lança LaTeX e é caro.
3. **Reescrita do histórico para remover `node_modules/`.** Pergunta: apenas deixar de versionar, ou limpar também o histórico. Contexto: P0.5 faz só a primeira; a segunda exige reescrita e força quem tem clones a refazê-los. Recomendação: só deixar de versionar.

## Não verificado neste plano

- Nenhum teste proposto foi executado; os valores numéricos (timeout de 120 s, limites de pedidos) são ponto de partida a medir, não resultado de medição.
- A conversão real com `pandoc` e `xelatex` não foi corrida nesta sessão; a correção `--pdf-engine=xelatex` em P0.1 assume que o motor por defeito (`pdflatex`) pode falhar com Unicode, o que é uma hipótese a confirmar.
- Comportamento do Vercel não confirmado contra a documentação atual.
