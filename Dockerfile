FROM golang:1.27.3-bookworm AS tools
RUN CGO_ENABLED=0 GOBIN=/tools go install github.com/jackc/tern/v2@v2.4.3
RUN CGO_ENABLED=0 GOBIN=/tools go install github.com/go-task/task/v3/cmd/task@v3.53.1

FROM node:22.22.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=tools /tools/tern ./bin/tern
COPY --from=tools /tools/task /usr/local/bin/task
COPY Taskfile.yml tsconfig.json ./
COPY infra/database ./infra/database
COPY scripts/database ./scripts/database
CMD ["task", "check-integration"]
