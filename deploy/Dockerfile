# 可选：用 Docker 部署后端
#   docker build -t shamingai-server .
#   docker run -d --name shamingai-server -p 8787:8787 --env-file .env \
#     -v /srv/blog.db:/data/blog.db -v ~/jekyll/shamingai.github.io:/srv/site \
#     shamingai-server
# 记得在 .env 里写 DB_PATH=/data/blog.db、SITE_REPO_DIR=/srv/site、HOST=0.0.0.0。
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY migrations ./migrations
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--no-warnings", "src/cli.js", "serve"]
