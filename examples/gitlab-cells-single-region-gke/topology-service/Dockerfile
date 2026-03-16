FROM --platform=linux/amd64 golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod main.go ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o topology-service .

FROM --platform=linux/amd64 alpine:3.19
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /build/topology-service /usr/local/bin/topology-service
RUN ln -s /usr/local/bin/topology-service /usr/local/bin/topology-cli
USER app
EXPOSE 8080
ENTRYPOINT ["topology-service"]
