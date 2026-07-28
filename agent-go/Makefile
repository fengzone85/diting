.PHONY: build build-linux build-windows build-darwin tidy vet test clean

VERSION := 1.0.0
LDFLAGS := -s -w -X main.version=$(VERSION)

## build 编译当前平台
build:
	go build -ldflags="$(LDFLAGS)" -o dist/diting-agent .

## build-linux 编译 Linux amd64（主用）
build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o dist/diting-agent-linux-amd64 .
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o dist/diting-agent-linux-arm64 .

## build-windows 编译 Windows
build-windows:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o dist/diting-agent-windows-amd64.exe .

## build-darwin 编译 macOS
build-darwin:
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o dist/diting-agent-darwin-amd64 .
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o dist/diting-agent-darwin-arm64 .

## tidy 整理依赖
tidy:
	go mod tidy

## vet 静态检查
vet:
	go vet ./...

## test 运行测试
test:
	go test -v ./...

## clean 清理构建产物
clean:
	rm -rf dist/
