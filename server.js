const express = require('express');
const multer = require('multer');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const MAX_FILE_BYTES = 300 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS) || 120 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_MAX) || 30;
const PANDOC = process.env.PANDOC_BIN || 'pandoc';

function createApp() {
    const app = express();
    app.disable('x-powered-by');

    let running = 0;
    const hits = new Map();

    // Limite de pedidos por IP, em memória (janela fixa de 1 minuto).
    function rateLimit(req, res, next) {
        const now = Date.now();
        const key = req.ip;
        const entry = hits.get(key);
        if (!entry || now - entry.start > RATE_WINDOW_MS) {
            hits.set(key, { start: now, count: 1 });
            return next();
        }
        entry.count += 1;
        if (entry.count > RATE_MAX) {
            return res.status(429).send('Demasiados pedidos. Tente novamente dentro de um minuto.');
        }
        next();
    }

    // Um diretório temporário por pedido; entrada e saída têm nomes fixos gerados pelo servidor.
    const storage = multer.diskStorage({
        destination(req, file, cb) {
            fs.promises.mkdtemp(path.join(os.tmpdir(), 'epub-'))
                .then((dir) => {
                    req.workDir = dir;
                    cb(null, dir);
                })
                .catch(cb);
        },
        filename(req, file, cb) {
            cb(null, 'in.epub');
        },
    });

    const upload = multer({
        storage,
        limits: { fileSize: MAX_FILE_BYTES, files: 1 },
        fileFilter(req, file, cb) {
            if (!/\.epub$/i.test(file.originalname)) {
                return cb(new Error('EXTENSAO_INVALIDA'));
            }
            cb(null, true);
        },
    });

    async function cleanup(dir) {
        if (dir) {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async function hasZipSignature(file) {
        const fh = await fs.promises.open(file, 'r');
        try {
            const buf = Buffer.alloc(4);
            await fh.read(buf, 0, 4, 0);
            return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        } finally {
            await fh.close();
        }
    }

    function safeDownloadName(original) {
        const base = path.parse(original).name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'livro';
        return `${base}.pdf`;
    }

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.post('/convert', rateLimit, (req, res, next) => {
        if (running >= MAX_CONCURRENT) {
            return res.status(503).send('Servidor ocupado. Tente novamente dentro de instantes.');
        }
        upload.single('epubFile')(req, res, (err) => {
            if (err) {
                cleanup(req.workDir);
                return next(err);
            }
            handleConvert(req, res);
        });
    });

    async function handleConvert(req, res) {
        const requestId = crypto.randomUUID();
        res.on('close', () => cleanup(req.workDir));

        if (!req.file) {
            return res.status(400).send('Nenhum ficheiro foi carregado.');
        }
        if (!(await hasZipSignature(req.file.path))) {
            return res.status(400).send('O ficheiro não é um EPUB válido.');
        }

        const inputPath = req.file.path;
        const outputPath = path.join(req.workDir, 'out.pdf');
        running += 1;
        let child;
        let finished = false;
        const done = () => {
            if (!finished) {
                finished = true;
                running -= 1;
            }
        };

        // Se o cliente desligar antes do fim, interrompe o pandoc.
        res.on('close', () => {
            if (child && child.exitCode === null && !child.killed) {
                child.kill('SIGKILL');
            }
        });

        child = execFile(
            PANDOC,
            [inputPath, '-o', outputPath, '--pdf-engine=xelatex'],
            { timeout: CONVERT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 50 * 1024 * 1024 },
            (error, stdout, stderr) => {
                done();
                if (res.headersSent || res.writableEnded) {
                    return;
                }
                if (error) {
                    console.error(`[${requestId}] Erro na conversão: ${error.message}\n${stderr}`);
                    if (error.killed) {
                        return res.status(503).send(`A conversão demorou demasiado tempo (pedido ${requestId}).`);
                    }
                    return res.status(500).send(`Erro na conversão. Verifique se o ficheiro EPUB é válido (pedido ${requestId}).`);
                }
                res.download(outputPath, safeDownloadName(req.file.originalname), (sendErr) => {
                    if (sendErr) {
                        console.error(`[${requestId}] Erro ao enviar o ficheiro:`, sendErr.message);
                    }
                });
            }
        );
    }

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).send('O ficheiro excede o limite de 300 MB.');
            }
            return res.status(400).send('Pedido inválido.');
        }
        if (err && err.message === 'EXTENSAO_INVALIDA') {
            return res.status(400).send('O ficheiro não é um EPUB válido.');
        }
        console.error('Erro interno do servidor:', err);
        if (!res.headersSent) {
            res.status(500).send('Erro interno do servidor.');
        }
    });

    return app;
}

function checkPrerequisites() {
    for (const [cmd, args] of [[PANDOC, ['--version']], ['xelatex', ['--version']]]) {
        try {
            execFileSync(cmd, args, { stdio: 'ignore' });
        } catch (e) {
            console.error(`Pré-requisito em falta: "${cmd}" não está instalado ou não corre.`);
            process.exit(1);
        }
    }
}

if (require.main === module) {
    checkPrerequisites();
    const port = process.env.PORT || 3000;
    const server = createApp().listen(port, () => {
        console.log(`Servidor de conversão a correr em http://localhost:${port}`);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createApp };
