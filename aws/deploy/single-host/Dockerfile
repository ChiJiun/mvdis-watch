# 單機部署用的映像：一次打包 worker、api、replay、scheduler（dispatcher＋janitor）。
# build context 必須是 repo 根目錄（要用到原型的 src/、public/ 與 aws/shared）：
#   docker build -f aws/deploy/single-host/Dockerfile -t mvdis-aws .
# 支援 amd64 與 arm64（Oracle A1）；打包產物是純 JS，不含原生模組。

FROM node:22-bookworm-slim AS build
WORKDIR /src

# 先只複製 lockfile 安裝相依，程式碼改動時可以沿用這層快取
COPY aws/app/package.json aws/app/package-lock.json aws/app/
COPY aws/api/package.json aws/api/package-lock.json aws/api/
COPY aws/replay/package.json aws/replay/package-lock.json aws/replay/
RUN cd aws/app && npm ci --no-audit --no-fund \
 && cd ../api && npm ci --no-audit --no-fund \
 && cd ../replay && npm ci --no-audit --no-fund

COPY src src
COPY public public
COPY aws/shared aws/shared
COPY aws/app aws/app
COPY aws/api aws/api
COPY aws/replay aws/replay
COPY aws/deploy/single-host/scheduler.ts aws/deploy/single-host/scheduler.ts

RUN cd aws/app && npm run build \
 && cd ../api && npm run build \
 && cd ../replay && npm run build

# scheduler.ts 在 aws/deploy/ 底下，相依套件從 aws/app/node_modules 解析
RUN cd aws/app && NODE_PATH=/src/aws/app/node_modules npx esbuild ../deploy/single-host/scheduler.ts \
      --bundle --platform=node --target=node22 --format=esm --minify --legal-comments=none \
      --external:pg-native \
      "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
      --outfile=dist/scheduler.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/aws/app/dist/worker.mjs /src/aws/app/dist/scheduler.mjs ./
COPY --from=build /src/aws/api/dist/api.mjs ./
COPY --from=build /src/aws/replay/dist/replay.mjs ./
USER node
# 各服務在 docker-compose.yml 用 command 指定要跑哪個檔案
CMD ["node", "api.mjs"]
