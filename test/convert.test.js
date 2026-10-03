const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'exemplo.epub'));
let server;
let base;

before(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(buffer, filename) {
    const form = new FormData();
    form.append('epubFile', new Blob([buffer]), filename);
    return fetch(`${base}/convert`, { method: 'POST', body: form });
}

function tempDirs() {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('epub-'));
}

test('converte um EPUB válido para PDF e limpa a pasta temporária', async () => {
    const res = await post(fixture, 'livro.epub');
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(tempDirs(), []);
});

test('nome de ficheiro malicioso não executa comandos', async () => {
    const marker = path.join(os.tmpdir(), `pwned-${process.pid}`);
    const res = await post(fixture, `$(touch ${marker}).epub`);
    assert.ok([200, 400].includes(res.status));
    assert.strictEqual(fs.existsSync(marker), false);
});

test('rejeita ficheiro que não é EPUB (extensão)', async () => {
    const res = await post(Buffer.from('texto'), 'nota.txt');
    assert.strictEqual(res.status, 400);
});

test('rejeita ficheiro .epub sem assinatura ZIP', async () => {
    const res = await post(Buffer.from('isto não é um zip'), 'falso.epub');
    assert.strictEqual(res.status, 400);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(tempDirs(), []);
});

test('pedido sem ficheiro devolve 400', async () => {
    const res = await fetch(`${base}/convert`, { method: 'POST', body: new FormData() });
    assert.strictEqual(res.status, 400);
});

test('dois pedidos simultâneos com o mesmo nome devolvem cada um o seu PDF', async () => {
    const [a, b] = await Promise.all([post(fixture, 'livro.epub'), post(fixture, 'livro.epub')]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
});

test('GET / serve a interface', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Converter/);
});
