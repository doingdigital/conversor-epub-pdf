FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc texlive-xetex texlive-latex-extra librsvg2-bin fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js index.html ./
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
