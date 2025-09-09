const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const timeout = require('connect-timeout');

const app = express();
const port = 3000;

// Configurar o timeout para 10 minutos
app.use(timeout('600s'));

// Configurar o multer para armazenar ficheiros em memória
const upload = multer({ storage: multer.memoryStorage() });

app.post('/convert', upload.single('epubFile'), (req, res) => {
    res.on('timeout', () => {
        console.error('Request timed out');
        if (req.timedout) {
            res.status(503).send('A conversão demorou demasiado tempo. Por favor, tente com um ficheiro mais pequeno.');
        }
    });

    if (!req.file) {
        console.error('Nenhum ficheiro foi carregado.');
        return res.status(400).send('Nenhum ficheiro foi carregado.');
    }

    const uniqueFileName = `temp-${Date.now()}.epub`;
    const inputPath = path.join(__dirname, 'uploads', uniqueFileName);
    const outputFileName = `${path.parse(req.file.originalname).name}.pdf`;
    const outputPath = path.join(__dirname, 'downloads', outputFileName);

    try {
        console.log(`A salvar ficheiro: ${inputPath}`);
        fs.writeFileSync(inputPath, req.file.buffer);

        console.log(`A iniciar a conversão do ficheiro ${inputPath} para ${outputPath}`);
        // ALTERAÇÃO AQUI: Usar o comando 'pandoc' em vez de 'ebook-convert'
        const command = `pandoc "${inputPath}" -o "${outputPath}"`;

        exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (fs.existsSync(inputPath)) {
                fs.unlinkSync(inputPath);
            }

            if (error) {
                console.error(`Erro na conversão: ${error.message}`);
                console.error(`Stderr: ${stderr}`);
                return res.status(500).send(`Erro na conversão: ${stderr}`);
            }

            if (!fs.existsSync(outputPath)) {
                console.error(`Erro: O ficheiro de saída não foi criado em ${outputPath}`);
                return res.status(500).send('Erro na conversão: o ficheiro de saída não foi gerado.');
            }

            console.log(`Conversão concluída. A enviar o ficheiro ${outputPath}`);
            res.download(outputPath, (err) => {
                if (err) {
                    console.error('Erro ao enviar o ficheiro:', err);
                }
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            });
        });
    } catch (err) {
        console.error('Erro interno do servidor:', err);
        res.status(500).send('Erro interno do servidor.');
    }
});

app.listen(port, () => {
    console.log(`Servidor de conversão a correr em http://localhost:${port}`);
});
