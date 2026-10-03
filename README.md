# conversor-epub-pdf

Converte ficheiros EPUB em PDF. Servidor Express que chama o `pandoc` (motor `xelatex`) e interface web servida em `/`.

## Requisitos

- Node.js 20 ou superior
- `pandoc` e `xelatex` (pacotes `pandoc` e `texlive-xetex` em Debian/Ubuntu)

## Uso local

```
npm ci
npm start
```

Abrir `http://localhost:3000/`. O servidor termina no arranque se `pandoc` ou `xelatex` faltarem.

## Docker

```
docker build -t conversor-epub-pdf .
docker run -p 3000:3000 conversor-epub-pdf
```

## Configuração

| Variável | Predefinição | Efeito |
|---|---|---|
| `PORT` | 3000 | Porta de escuta |
| `CONVERT_TIMEOUT_MS` | 120000 | Tempo máximo por conversão |
| `MAX_CONCURRENT` | 2 | Conversões em simultâneo; acima disto devolve 503 |
| `RATE_MAX` | 30 | Pedidos por IP e por minuto; acima disto devolve 429 |

## Limites

Um ficheiro por pedido, até 300 MB, com extensão `.epub` e assinatura ZIP. Sem autenticação: não expor à internet sem proxy ou rede privada.

## Testes

```
npm test
```

Precisa de `pandoc` e `xelatex` instalados.

## Alojamento

O Vercel não serve este projeto (sem `pandoc`/LaTeX no runtime). Usar o Dockerfile num serviço com processos persistentes.
