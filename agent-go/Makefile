.PHONY: build build-linux build-windows build-darwin tidy vet test clean

# 版本号来源唯一化（V.1）：优先 git tag（与 CI 的 ${GITHUB_REF_NAME#agent-go-} 同口径），
# 无 git 环境（如从源码包解构）才回落兜底值。原硬编码 1.0.0 会让本地 make 出来的
# 二进制自报 1.0.0、与 Release 产物不一致。
#
# 注意 --match 'agent-go-v*'：本仓库同时有服务端 tag（v1.0.1）与受控端 tag
# （agent-go-v1.1.3），不加 --match 时 git describe 可能命中服务端 tag，
# 让 agent 自报成服务端版本号。剥离 agent-go-v 前缀后与 CI 口径完全一致。
VERSION    := $(shell git describe --tags --abbrev=0 --match 'agent-go-v*' 2>/dev/null | sed -n 's/^agent-go-v//p')
ifeq ($(strip $(VERSION)),)
VERSION := 1.0.0
endif
BUILD_SHA  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS    := -s -w -X main.version=$(VERSION) -X main.buildSHA=$(BUILD_SHA) -X main.buildTime=$(BUILD_TIME)

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
