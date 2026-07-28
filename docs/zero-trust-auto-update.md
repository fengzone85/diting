# 零信任自动更新方案

> 最后更新：2026-07-28
> 状态：设计阶段

---

## 一、核心理念

**"Fork 即订阅，Push 发布，签名即信任"**

| 原则 | 说明 |
|------|------|
| 不信任服务端 | Diting 服务端不发送任何指令 |
| 不信任客户端 | Agent 不执行任何远程代码 |
| 不信任 Diting 官方 | 代码开源但用户自行审核 |
| **只信任自己** | 用户 fork 仓库，自己签名发布 |

---

## 二、架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户（唯一信任锚点）                        │
│                                                                 │
│   ┌───────────────────┐       ┌───────────────────┐             │
│   │ GitHub 账户        │       │ 签名密钥对          │             │
│   │  ├─ diting-server │       │  ├─ private.pem   │             │
│   │  │   (fork)       │       │  └─ public.pem    │             │
│   │  └─ diting-agent  │       │                   │             │
│   │      (fork)       │       │                   │             │
│   └─────────┬─────────┘       └─────────┬─────────┘             │
│             │ Release                    │ 签名                  │
│             ▼                            ▼                       │
│   ┌─────────────────────────────────────────────────┐           │
│   │ GitHub Release                                  │           │
│   │  ├─ diting-server-linux-amd64                  │           │
│   │  ├─ diting-agent-linux-amd64                   │           │
│   │  ├─ diting-agent-linux-arm64                   │           │
│   │  ├─ diting-agent-windows-amd64.exe             │           │
│   │  └─ *.sig (Ed25519 签名)                       │           │
│   └─────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ 每小时拉取（只读）
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Diting 服务端（用户 VPS）                                        │
│                                                                 │
│  1. 检查 UPDATE_REPO 的 latest release                          │
│  2. 下载二进制 + 签名                                            │
│  3. 用 SIGN_PUBKEY 验证签名                                      │
│  4. 通过 → 滚动更新（零停机）                                    │
│  5. 失败 → 告警 + 保持旧版本                                     │
│                                                                 │
│  环境变量：                                                      │
│  AUTO_UPDATE=1                                                  │
│  UPDATE_REPO=https://github.com/用户/diting-server              │
│  SIGN_PUBKEY=用户公钥                                            │
└─────────────────────────────────────────────────────────────────┘
                           │
                           │ 上报监控数据（单向）
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Diting Agent（用户 VPS）                                        │
│                                                                 │
│  1. 检查 UPDATE_REPO 的 latest release                          │
│  2. 下载二进制 + 签名                                            │
│  3. 用 SIGN_PUBKEY 验证签名                                      │
│  4. 通过 → 原子替换 + 重启                                       │
│  5. 失败 → 告警 + 保持旧版本                                     │
│                                                                 │
│  环境变量：                                                      │
│  AUTO_UPDATE=1                                                  │
│  UPDATE_REPO=https://github.com/用户/diting-agent               │
│  SIGN_PUBKEY=用户公钥                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、用户操作流程

### 3.1 首次部署（一次性）

```bash
# ========== 1. Fork 仓库 ==========
# 在 GitHub 上 fork 两个仓库：
#   - https://github.com/fengzone85/diting-server → 你的/diting-server
#   - https://github.com/fengzone85/diting-agent → 你的/diting-agent

# ========== 2. 生成签名密钥 ==========
openssl genpkey -algorithm Ed25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem
# 保管好 private.pem（用于签名发布）
# public.pem 将配置到服务端和 Agent

# ========== 3. 部署服务端 ==========
curl -fsSL https://raw.githubusercontent.com/你的/diting-server/main/install.sh | bash -s \
  --update-repo https://github.com/你的/diting-server \
  --sign-pubkey "$(cat update-public.pem)"

# ========== 4. 批量部署 Agent ==========
# 方式 A：pssh 批量
pssh -h hosts.txt -i "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s \
  --server https://monitor.example.com \
  --id {{host}} \
  --token {{token}} \
  --update-repo https://github.com/你的/diting-agent \
  --sign-pubkey '$(cat update-public.pem)'"

# 方式 B：Ansible
ansible all -m shell -a "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s \
  --server https://monitor.example.com \
  --id {{inventory_hostname}} \
  --token {{diting_token}} \
  --update-repo https://github.com/你的/diting-agent \
  --sign-pubkey '{{ diting_sign_pubkey }}'"

# 方式 C：Terraform（云主机）
resource "null_resource" "diting_agent" {
  count = length(var.vps_ips)
  connection {
    host = var.vps_ips[count.index]
  }
  provisioner "remote-exec" {
    inline = [
      "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s",
      "  --server https://monitor.example.com",
      "  --id ${var.vps_ids[count.index]}",
      "  --token ${var.vps_tokens[count.index]}",
      "  --update-repo https://github.com/你的/diting-agent",
      "  --sign-pubkey '${var.diting_sign_pubkey}'",
    ]
  }
}
```

### 3.2 日常更新（全自动）

```bash
# ========== 服务端更新 ==========
cd ~/projects/diting-server-fork

# 合并上游更新
git remote add upstream https://github.com/fengzone85/diting-server 2>/dev/null || true
git fetch upstream
git merge upstream/main

# 审核代码
git diff HEAD~1
# ... 仔细检查每一行 ...

# 发布新版本
git tag v2.1.0
git push origin v2.1.0

# 构建 + 签名 + 上传（GitHub Actions 自动执行）
# → 所有服务端实例在 1 小时内自动更新

# ========== Agent 更新 ==========
cd ~/projects/diting-agent-fork

git fetch upstream
git merge upstream/main
git diff HEAD~1
# ... 审核 ...

git tag v1.1.0
git push origin v1.1.0
# → 所有 Agent 在 1 小时内自动更新
```

### 3.3 回滚

```bash
# 方式 A：删除有问题的 Release
cd ~/projects/diting-agent-fork
git push origin --delete v1.1.0      # 删除 tag
gh release delete v1.1.0            # 删除 Release
# → Agent 检测到 latest 变化，自动回滚到 v1.0.0

# 方式 B：发布修复版本
git tag v1.1.1
git push origin v1.1.1
# → Agent 自动更新到 v1.1.1
```

---

## 四、签名验证流程

### 4.1 签名生成（发布时）

```bash
# 对每个二进制文件生成签名
for binary in dist/*; do
  openssl dgst -sha256 -sign update-private.pem \
    -out "${binary}.sig" "${binary}"
done

# 验证签名（测试）
openssl dgst -sha256 -verify update-public.pem \
  -signature diting-agent-linux-amd64.sig \
  diting-agent-linux-amd64
```

### 4.2 签名验证（Agent/服务端）

```go
// 伪代码
func verifySignature(binary, signature, publicKey []byte) error {
    // 1. 计算 binary 的 SHA-256 哈希
    hash := sha256.Sum256(binary)

    // 2. 用 Ed25519 验证签名
    if !ed25519.Verify(publicKey, hash[:], signature) {
        return errors.New("signature verification failed")
    }
    return nil
}
```

### 4.3 安全约束

| 约束 | 说明 |
|------|------|
| 签名算法 | Ed25519（快速、安全、签名短） |
| 公钥存储 | 环境变量或配置文件（不进仓库） |
| 私钥存储 | 用户本地（不进 CI/CD 环境变量） |
| 验证失败 | 不更新 + 日志告警 |
| 密钥轮换 | 重新签名所有版本 + 更新公钥 |

---

## 五、GitHub Actions CI/CD

### 5.1 服务端 `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build
        run: |
          npm ci
          npm run build
          tar -czf diting-server-linux-amd64.tar.gz -C dist .

      - name: Sign
        env:
          PRIVATE_KEY: ${{ secrets.UPDATE_PRIVATE_KEY }}
        run: |
          echo "$PRIVATE_KEY" > /tmp/private.pem
          openssl dgst -sha256 -sign /tmp/private.pem \
            -out diting-server-linux-amd64.tar.gz.sig \
            diting-server-linux-amd64.tar.gz
          rm /tmp/private.pem

      - name: Create Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create ${{ github.ref_name }} \
            diting-server-linux-amd64.tar.gz \
            diting-server-linux-amd64.tar.gz.sig \
            --generate-notes
```

### 5.2 Agent `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: linux
            arch: amd64
          - os: linux
            arch: arm64
          - os: windows
            arch: amd64
          - os: darwin
            arch: amd64
          - os: darwin
            arch: arm64
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Build
        env:
          GOOS: ${{ matrix.os }}
          GOARCH: ${{ matrix.arch }}
        run: |
          output="diting-agent-${{ matrix.os }}-${{ matrix.arch }}"
          if [ "${{ matrix.os }}" = "windows" ]; then
            output="${output}.exe"
          fi
          CGO_ENABLED=0 go build -ldflags="-s -w" -o "dist/${output}" .

      - name: Sign
        env:
          PRIVATE_KEY: ${{ secrets.UPDATE_PRIVATE_KEY }}
        run: |
          echo "$PRIVATE_KEY" > /tmp/private.pem
          for f in dist/*; do
            [ -f "$f" ] && openssl dgst -sha256 -sign /tmp/private.pem \
              -out "${f}.sig" "$f"
          done
          rm /tmp/private.pem

      - name: Upload to Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release upload ${{ github.ref_name }} dist/* --clobber
```

---

## 六、install.sh 一键部署脚本

```bash
#!/bin/bash
# Diting Agent 一键安装脚本
# 用法：curl -fsSL https://.../install.sh | bash -s -- [选项]

set -euo pipefail

# ========== 默认值 ==========
SERVER_URL=""
AGENT_ID=""
AGENT_TOKEN=""
SERVER_HOST=""  # 用于生成 Agent ID
DISK_PATH="/"
STATE_FILE="/data/state.json"
PROBE_TARGETS=""
DEBUG=0
GZIP=0
AUTO_UPDATE=0
UPDATE_REPO=""
SIGN_PUBKEY=""
INSTALL_DIR="/opt/diting"
SYSTEMD_SERVICE="/etc/systemd/system/diting-agent.service"

# ========== 解析参数 ==========
while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER_URL="$2"; shift 2;;
    --id) AGENT_ID="$2"; shift 2;;
    --token) AGENT_TOKEN="$2"; shift 2;;
    --host) SERVER_HOST="$2"; shift 2;;
    --disk) DISK_PATH="$2"; shift 2;;
    --state) STATE_FILE="$2"; shift 2;;
    --probes) PROBE_TARGETS="$2"; shift 2;;
    --debug) DEBUG=1; shift;;
    --gzip) GZIP=1; shift;;
    --auto-update) AUTO_UPDATE=1; shift;;
    --update-repo) UPDATE_REPO="$2"; shift 2;;
    --sign-pubkey) SIGN_PUBKEY="$2"; shift 2;;
    --install-dir) INSTALL_DIR="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

# ========== 校验必填 ==========
if [ -z "$SERVER_URL" ]; then
  echo "错误：缺少 --server"
  exit 1
fi

# 自动生成 Agent ID（基于主机名 + server host 的 hash）
if [ -z "$AGENT_ID" ]; then
  if [ -n "$SERVER_HOST" ]; then
    AGENT_ID="agt_$(echo "${SERVER_HOST}-$(hostname)" | sha256sum | head -c 12)"
  else
    HOST=$(echo "$SERVER_URL" | sed 's|https\?://||; s|/.*||; s|:.*||')
    AGENT_ID="agt_$(echo "${HOST}-$(hostname)" | sha256sum | head -c 12)"
  fi
  echo "自动生成 Agent ID: $AGENT_ID"
fi

if [ -z "$AGENT_TOKEN" ]; then
  echo "错误：缺少 --token（请先在服务端创建 Agent 获取 Token）"
  exit 1
fi

# ========== 检测系统 ==========
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case $ARCH in
  x86_64)  ARCH="amd64";;
  aarch64) ARCH="arm64";;
  armv7l)  ARCH="arm";;
esac

BINARY_NAME="diting-agent-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
  BINARY_NAME="${BINARY_NAME}.exe"
fi

# ========== 下载二进制 ==========
DOWNLOAD_BASE="${UPDATE_REPO/https:\/\/github.com\/}/releases/latest/download"
if [ -n "$UPDATE_REPO" ]; then
  DOWNLOAD_URL="${DOWNLOAD_BASE}/${BINARY_NAME}"
  SIG_URL="${DOWNLOAD_BASE}/${BINARY_NAME}.sig"
else
  DOWNLOAD_URL="https://github.com/fengzone85/diting-agent/releases/latest/download/${BINARY_NAME}"
  SIG_URL="${DOWNLOAD_URL}.sig"
fi

echo "下载: $DOWNLOAD_URL"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/diting-agent"
chmod +x "$TMPDIR/diting-agent"

# ========== 验证签名 ==========
if [ -n "$SIGN_PUBKEY" ] && [ -n "$UPDATE_REPO" ]; then
  echo "验证签名..."
  curl -fsSL "$SIG_URL" -o "$TMPDIR/diting-agent.sig"

  # 将公钥写入临时文件
  echo "$SIGN_PUBKEY" > "$TMPDIR/pubkey.pem"

  # 验证
  if ! openssl dgst -sha256 -verify "$TMPDIR/pubkey.pem" \
       -signature "$TMPDIR/diting-agent.sig" \
       "$TMPDIR/diting-agent" 2>/dev/null; then
    echo "错误：签名验证失败！"
    exit 1
  fi
  echo "签名验证通过"
fi

# ========== 安装 ==========
echo "安装到 $INSTALL_DIR"
sudo mkdir -p "$INSTALL_DIR"
sudo cp "$TMPDIR/diting-agent" "$INSTALL_DIR/diting-agent"
sudo chmod 755 "$INSTALL_DIR/diting-agent"

# 创建数据目录
sudo mkdir -p "$(dirname "$STATE_FILE")"

# ========== 创建 systemd 服务 ==========
if command -v systemctl &>/dev/null && [ "$OS" = "linux" ]; then
  echo "创建 systemd 服务..."

  # 构建环境变量
  ENV_VARS="SERVER_URL=$SERVER_URL\nAGENT_ID=$AGENT_ID\nAGENT_TOKEN=$AGENT_TOKEN"
  [ "$DISK_PATH" != "/" ] && ENV_VARS="$ENV_VARS\nDISK_PATH=$DISK_PATH"
  [ -n "$PROBE_TARGETS" ] && ENV_VARS="$ENV_VARS\nPROBE_TARGETS=$PROBE_TARGETS"
  [ "$DEBUG" = "1" ] && ENV_VARS="$ENV_VARS\nDEBUG=1"
  [ "$GZIP" = "1" ] && ENV_VARS="$ENV_VARS\nGZIP=1"
  if [ "$AUTO_UPDATE" = "1" ] && [ -n "$UPDATE_REPO" ]; then
    ENV_VARS="$ENV_VARS\nAUTO_UPDATE=1\nUPDATE_REPO=$UPDATE_REPO"
    [ -n "$SIGN_PUBKEY" ] && ENV_VARS="$ENV_VARS\nSIGN_PUBKEY=$SIGN_PUBKEY"
  fi

  sudo tee "$SYSTEMD_SERVICE" > /dev/null <<EOF
[Unit]
Description=Diting Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/diting-agent
Restart=always
RestartSec=5
EnvironmentFile=-/etc/default/diting-agent

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$(dirname "$STATE_FILE")
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # 写入环境变量
  echo "写入环境变量到 /etc/default/diting-agent"
  echo -e "$ENV_VARS" | sudo tee /etc/default/diting-agent > /dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable diting-agent
  sudo systemctl start diting-agent

  echo "服务已启动：sudo systemctl status diting-agent"
else
  # 非 systemd 系统，直接运行
  echo "未检测到 systemd，直接启动..."
  export SERVER_URL AGENT_ID AGENT_TOKEN DISK_PATH PROBE_TARGETS DEBUG GZIP AUTO_UPDATE UPDATE_REPO SIGN_PUBKEY
  sudo -E "$INSTALL_DIR/diting-agent" &
  echo "Agent 已启动（后台运行）"
fi

echo ""
echo "========================================"
echo "部署完成！"
echo "  Agent ID: $AGENT_ID"
echo "  Server:   $SERVER_URL"
echo "  状态文件: $STATE_FILE"
if [ "$AUTO_UPDATE" = "1" ]; then
  echo "  自动更新: 已启用（监听 $UPDATE_REPO）"
fi
echo "========================================"
```

---

## 七、自动更新模块（Agent 侧）

### 7.1 更新检查器

```go
// updater/updater.go
package updater

import (
    "context"
    "crypto/ed25519"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "time"
)

const (
    checkInterval = time.Hour // 每小时检查一次
    httpClientTimeout = 30 * time.Second
)

// Updater 检查并应用更新。
type Updater struct {
    repoURL   string        // 用户仓库 URL
    publicKey ed25519.PublicKey
    version   string        // 当前版本
    client    *http.Client
}

// NewUpdater 创建更新检查器。
func NewUpdater(repoURL, version string, publicKey []byte) (*Updater, error) {
    if len(publicKey) != ed25519.PublicKeySize {
        return nil, fmt.Errorf("invalid public key size: %d", len(publicKey))
    }
    return &Updater{
        repoURL:   repoURL,
        publicKey: ed25519.PublicKey(publicKey),
        version:   version,
        client:    &http.Client{Timeout: httpClientTimeout},
    }
}

// Check 检查是否有新版本。返回新版本号，无更新返回空字符串。
func (u *Updater) Check(ctx context.Context) (string, error) {
    // 解析仓库 URL 获取 owner/repo
    owner, repo, err := parseGitHubURL(u.repoURL)
    if err != nil {
        return "", err
    }

    // 调用 GitHub API 获取 latest release
    apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", owner, repo)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
    if err != nil {
        return "", err
    }
    req.Header.Set("Accept", "application/vnd.github+json")

    resp, err := u.client.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("GitHub API status %d", resp.StatusCode)
    }

    // 解析 JSON 获取 tag_name
    var release struct {
        TagName string `json:"tag_name"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
        return "", err
    }

    // 比较版本
    if release.TagName == u.version {
        return "", nil // 已是最新
    }

    return release.TagName, nil
}

// Update 下载并验证新版本。
func (u *Updater) Update(ctx context.Context, version string) error {
    owner, repo, err := parseGitHubURL(u.repoURL)
    if err != nil {
        return err
    }

    // 检测当前平台
    os, arch := runtime.GOOS, runtime.GOARCH
    binaryName := fmt.Sprintf("diting-agent-%s-%s", os, arch)
    if os == "windows" {
        binaryName += ".exe"
    }

    // 下载二进制
    downloadURL := fmt.Sprintf("https://github.com/%s/%s/releases/download/%s/%s",
        owner, repo, version, binaryName)
    sigURL := downloadURL + ".sig"

    tmpDir, err := os.MkdirTemp("", "diting-update-*")
    if err != nil {
        return err
    }
    defer os.RemoveAll(tmpDir)

    binaryPath := filepath.Join(tmpDir, "diting-agent")
    sigPath := binaryPath + ".sig"

    // 下载二进制
    if err := u.download(ctx, downloadURL, binaryPath); err != nil {
        return fmt.Errorf("download binary: %w", err)
    }

    // 下载签名
    if err := u.download(ctx, sigURL, sigPath); err != nil {
        return fmt.Errorf("download signature: %w", err)
    }

    // 验证签名
    if err := u.verify(binaryPath, sigPath); err != nil {
        return fmt.Errorf("verify signature: %w", err)
    }

    // 设置可执行权限
    if err := os.Chmod(binaryPath, 0o755); err != nil {
        return err
    }

    // 原子替换当前二进制
    execPath, err := os.Executable()
    if err != nil {
        return err
    }

    // 写入 .tmp 然后 rename（原子操作）
    tmpTarget := execPath + ".tmp"
    if err := copyFile(binaryPath, tmpTarget); err != nil {
        return err
    }
    if err := os.Rename(tmpTarget, execPath); err != nil {
        os.Remove(tmpTarget)
        return err
    }

    return nil
}

// verify 验证二进制签名。
func (u *Updater) verify(binaryPath, sigPath string) error {
    // 读取二进制
    binary, err := os.ReadFile(binaryPath)
    if err != nil {
        return err
    }

    // 读取签名
    sig, err := os.ReadFile(sigPath)
    if err != nil {
        return err
    }

    // 计算 SHA-256 哈希
    hash := sha256.Sum256(binary)

    // Ed25519 验证
    if !ed25519.Verify(u.publicKey, hash[:], sig) {
        return fmt.Errorf("signature verification failed")
    }

    return nil
}

// download 下载 URL 到本地文件。
func (u *Updater) download(ctx context.Context, url, dest string) error {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return err
    }

    resp, err := u.client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("download status %d", resp.StatusCode)
    }

    f, err := os.Create(dest)
    if err != nil {
        return err
    }
    defer f.Close()

    _, err = io.Copy(f, resp.Body)
    return err
}
```

### 7.2 集成到 main.go

```go
// main.go 中添加自动更新
func runUpdater(ctx context.Context, u *Updater, onUpdate func()) {
    ticker := time.NewTicker(checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            newVersion, err := u.Check(ctx)
            if err != nil {
                log.Printf("[updater] check failed: %v", err)
                continue
            }
            if newVersion == "" {
                continue // 已是最新
            }

            log.Printf("[updater] new version available: %s", newVersion)
            if err := u.Update(ctx, newVersion); err != nil {
                log.Printf("[updater] update failed: %v", err)
                continue
            }

            log.Printf("[updater] updated to %s, restarting...", newVersion)
            onUpdate() // 触发重启
            return
        }
    }
}
```

---

## 八、安全约束清单

| 约束 | 实现 |
|------|------|
| 默认关闭自动更新 | `AUTO_UPDATE=0` |
| 签名强制验证 | Ed25519，失败不更新 |
| 用户仓库 | 只监听用户指定的仓库 |
| 纯拉取 | 不执行远程代码 |
| 原子更新 | 失败自动回滚 |
| 版本锁定 | 可锁定到特定 tag |
| 私钥不进 CI | GitHub Secrets 注入 |
| 公钥不进仓库 | 环境变量配置 |

---

## 九、总结

| 特性 | 实现方式 |
|------|---------|
| 部署 | fork + install.sh + 批量工具 |
| 更新 | push Release → 自动检测 |
| 安全 | 签名验证 + 原子更新 |
| 回滚 | 删除 tag / push 旧版本 |
| 信任 | **只信任自己** |

**Fork = 订阅，Push = 发布，签名 = 信任。**
