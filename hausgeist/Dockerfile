ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm libstdc++ libgcc tzdata
ENV TZ=Europe/Berlin

WORKDIR /app
COPY app/package.json app/package-lock.json ./
# --ignore-scripts: ssh2/cpu-features würden sonst C++ unter ARM-Emulation kompilieren (sehr langsam); SSH läuft auch ohne
RUN npm ci --ignore-scripts

COPY app/tsconfig.json ./
COPY app/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

CMD ["node", "/app/dist/index.js"]
