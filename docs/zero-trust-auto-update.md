# 信任边界收敛到用户自身的自动更新方案

> 最后更新：2026-07-28
> 状态：设计阶段
> 定位：**可选的高级运维模式**，默认关闭

---

## 〇、与项目安全哲学的关系

### 本项目拒绝什么

`README_EN.md` 第 237-247 行明确拒绝：

> "agents self-update by fetching an install script from the server and running `bash -s install` as root ... Both are command channels"

**拒绝的核心是"服务端推送"**——信任服务端 → 信任边界崩塌 → 服务端被入侵 = 所有 Agent 被控。

### 本方案允许什么

| 方案 | 信任锚点 | 项目立场 |
|------|---------|---------|
| 服务端推送更新 | Diting 服务端 | ❌ 拒绝 |
| Diting 官方推送 | Diting 官方仓库 | ❌ 拒绝 |
| **用户 fork + 用户签名** | **用户自己** | ✅ 允许 |

**关键区别**：

- 服务端/官方推送 = **信任第三方** → 一旦第三方被入侵，全网 Agent 被控
- 用户 fork + 签名 = **只信任自己** → 用户完全控制代码审核、签名、发布全流程

本方案把信任锚点从"Diting 服务端"转移到"用户自身"，**与项目"只信任自己"哲学一致**，不新增任何服务端→Agent 指令通道。

### 一句话总结

> 拒绝"服务端推送的 self-update"，允许"用户完全自托管的签名更新"。

---

## 一、核心理念

**"Fork 即订阅，Push 发布，签名即信任"**

| 原则 | 说明 |
|------|------|
| 不信任服务端 | Diting 服务端不发送任何指令 |
| 不信任客户端 | Agent 不执行任何远程代码 |
| 不信任 Diting 官方 | 代码开源但用户自行审核 |
| **只信任自己** | 用户 fork 仓库，自己签名发布 |

**信任边界**：收敛到用户自身（私有仓库 + 用户私钥）。

| 风险 | 等价场景 | 结论 |
|------|---------|------|
| 私有仓库被投毒 | GitHub 账号被盗 | 账号安全是通用风险，非本方案特有 |
| 私钥泄露 | 攻击者能签名发布 | 需妥善保管（推荐 YubiKey/硬件密钥） |
| GitHub 平台故障 | 无法检查更新 |  Agent 继续运行旧版本，不影响监控 |

**私有仓库 = 用户自己的数字空间**，被投毒的前提是账号被盗，这与其他场景（直接 push 代码、发布恶意 Release）等价。

---

## 二、架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户（唯一信任锚点）                        │
│                                                                 │
│   ┌───────────────────┐       ┌───────────────────┐             │
│   │ 用户 Git 仓库      │       │ 签名密钥对          │             │
│   │  ├─ diting-server │       │  ├─ private.pem   │             │
│   │  │   (fork)       │       │  └─ public.pem    │             │
│   │  └─ diting-agent  │       │                   │             │
│   │      (fork)       │       │                   │             │
│   └─────────┬─────────┘       └─────────┬─────────┘             │
│             │ Release                    │ 签名                  │
│             ▼                            ▼                       │
│   ┌─────────────────────────────────────────────────┐           │
│   │ GitHub/Gitea/Forgejo Release                    │           │
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
│  GITHUB_TOKEN=可选（提速率限制）                                  │
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
│  GITHUB_TOKEN=可选（提速率限制）                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、出站依赖与攻击面

### 新增出站依赖

| 依赖 | 用途 | 风险 |
|------|------|------|
| `api.github.com` | 检查新版本 | 返回 JSON 元数据（只读） |
| `objects.githubusercontent.com` | 下载二进制 | 静态文件（签名验证） |

**缓解**：
- 支持私有镜像 / 自托管 Forgejo（替换 GitHub）
- 错峰检查（随机 0-10 分钟偏移）
- `GITHUB_TOKEN` 提升速率限制（5000 次/小时）

### 私有仓库安全性

| 威胁 | 等价场景 | 说明 |
|------|---------|------|
| 仓库被投毒 | GitHub 账号被盗 | 非本方案特有，属账号安全范畴 |
| 私钥泄露 | 攻击者能签名发布 | 需妥善保管 |
| GitHub 故障 | 无法检查更新 | Agent 继续运行旧版本，不影响监控 |

**结论**：私有仓库 = 用户自己的数字空间，被投毒风险 ≈ 账号安全风险。

### 零入站保证

本方案**不新增任何入站端口**，保持 Agent 纯单向上报模型。

---

## 四、用户操作流程

### 4.1 首次部署（一次性）

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
# 通过环境变量传入 token（避免命令行泄露）
export DITING_ADMIN_TOKEN=your-admin-token
curl -fsSL https://raw.githubusercontent.com/你的/diting-server/main/install.sh | bash -s \
  --update-repo https://github.com/你的/diting-server \
  --sign-pubkey "$(cat update-public.pem)"

# ========== 4. 批量部署 Agent ==========
# 方式 A：pssh 批量（token 通过环境变量传入）
export DITING_TOKEN=your-agent-token
pssh -h hosts.txt -i "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s \
  --server https://monitor.example.com \
  --id {{host}} \
  --update-repo https://github.com/你的/diting-agent \
  --sign-pubkey '$(cat update-public.pem)'"

# 方式 B：Ansible
ansible all -m shell -a "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s \
  --server https://monitor.example.com \
  --id {{inventory_hostname}} \
  --update-repo https://github.com/你的/diting-agent \
  --sign-pubkey '{{ diting_sign_pubkey }}'"
# token 通过 Ansible vault 加密传输，不进命令行

# 方式 C：Terraform（云主机）
variable "diting_tokens" {
  type      = map(string)
  sensitive = true  # Terraform 自动隐藏
}
resource "null_resource" "diting_agent" {
  for_each = var.vps_ips
  connection { host = each.key }
  provisioner "remote-exec" {
    inline = [
      "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s",
      "  --server https://monitor.example.com",
      "  --id ${each.key}",
      "  --update-repo https://github.com/你的/diting-agent",
      "  --sign-pubkey '${var.diting_sign_pubkey}'",
    ]
    environment = {
      DITING_TOKEN = var.diting_tokens[each.key]  # 环境变量传入，不进 argv
    }
  }
}
```

### 4.2 日常更新（全自动）

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

### 4.3 回滚

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

## 五、签名验证流程

### 5.1 签名算法选择

**Ed25519**（推荐）：
- 签名快、验证快、签名短（64 字节）
- 无需预哈希（内部使用 SHA-512）
- OpenSSL 和 Go 实现一致

### 5.2 签名生成（发布时）

```bash
# 对每个二进制文件生成签名
for binary in dist/*; do
  openssl dgst -sha256 -sign update-private.pem \
    -out "${binary}.sig" "${binary}"
done

# 自测（仅验证签名格式正确）
openssl dgst -sha256 -verify update-public.pem \
  -signature diting-agent-linux-amd64.sig \
  diting-agent-linux-amd64
```

**注意**：OpenSSL 对 Ed25519 **忽略 `-sha256` 参数**，直接对文件原文签名（Ed25519 内部使用 SHA-512）。这与 Go 的 `ed25519.Verify` 行为一致。

### 5.3 签名验证（Agent/服务端）

```go
// 关键：传原文，不要预哈希
func verifySignature(binary, signature, publicKey []byte) error {
    // Ed25519 内部处理哈希，直接传原文
    if !ed25519.Verify(publicKey, binary, signature) {
        return errors.New("signature verification failed")
    }
    return nil
}
```

**常见错误**（本方案已修正）：
```go
// ❌ 错误：预哈希后传入
hash := sha256.Sum256(binary)
ed25519.Verify(publicKey, hash[:], signature)  // 永远失败

// ✅ 正确：传入原文
ed25519.Verify(publicKey, binary, signature)  // 正确
```

### 5.4 安全约束

| 约束 | 说明 |
|------|------|
| 签名算法 | Ed25519（快速、安全、签名短） |
| 公钥存储 | 环境变量或配置文件（不进仓库） |
| 私钥存储 | 用户本地（不进 CI/CD 环境变量） |
| 验证失败 | 不更新 + 日志告警 |
| 密钥轮换 | 重新签名所有版本 + 更新公钥 |

---

## 六、install.sh 一键部署脚本

### 6.1 脚本校验

```bash
# 用户首次使用时，先校验 install.sh 本身的完整性
curl -fsSL https://raw.githubusercontent.com/你的仓库/main/install.sh -o install.sh
echo "expected-sha256hash  install.sh" | sha256sum -c
bash install.sh ...
```

### 6.2 完整脚本

```bash
#!/bin/bash
# Diting Agent 一键安装脚本
# 用法：
#   export DITING_TOKEN=xxx
#   curl -fsSL https://.../install.sh | bash -s -- [选项]
#
# token 通过环境变量传入，避免暴露在 ps/shell 历史中

set -euo pipefail

# ========== 默认值 ==========
SERVER_URL=""
AGENT_ID=""
AGENT_TOKEN="${DITING_TOKEN:-}"  # 优先从环境变量读取
SERVER_HOST=""
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
    --token) AGENT_TOKEN="$2"; shift 2;;  # 兼容显式传参（不推荐）
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
  echo "错误：缺少 token（请设置 DITING_TOKEN 环境变量或通过 --token 传入）"
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

# ========== 下载二进制（修正 URL 构造） ==========
if [ -n "$UPDATE_REPO" ]; then
  # 修正：用 # 前缀剥离，不用 / 替换
  REPO_PATH="${UPDATE_REPO#https://github.com/}"
  DOWNLOAD_BASE="https://github.com/${REPO_PATH}/releases/latest/download"
else
  DOWNLOAD_BASE="https://github.com/fengzone85/diting-agent/releases/latest/download"
fi

DOWNLOAD_URL="${DOWNLOAD_BASE}/${BINARY_NAME}"
SIG_URL="${DOWNLOAD_BASE}/${BINARY_NAME}.sig"

echo "下载: $DOWNLOAD_URL"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/diting-agent"
chmod +x "$TMPDIR/diting-agent"

# ========== 验证签名 ==========
if [ -n "$SIGN_PUBKEY" ] && [ -n "$UPDATE_REPO" ]; then
  echo "验证签名..."
  curl -fsSL "$SIG_URL" -o "$TMPDIR/diting-agent.sig"
  echo "$SIGN_PUBKEY" > "$TMPDIR/pubkey.pem"

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

  # 构建环境变量文件（token 写入文件，不进命令行）
  {
    echo "SERVER_URL=$SERVER_URL"
    echo "AGENT_ID=$AGENT_ID"
    echo "AGENT_TOKEN=$AGENT_TOKEN"
    [ "$DISK_PATH" != "/" ] && echo "DISK_PATH=$DISK_PATH"
    [ -n "$PROBE_TARGETS" ] && echo "PROBE_TARGETS=$PROBE_TARGETS"
    [ "$DEBUG" = "1" ] && echo "DEBUG=1"
    [ "$GZIP" = "1" ] && echo "GZIP=1"
    if [ "$AUTO_UPDATE" = "1" ] && [ -n "$UPDATE_REPO" ]; then
      echo "AUTO_UPDATE=1"
      echo "UPDATE_REPO=$UPDATE_REPO"
      [ -n "$SIGN_PUBKEY" ] && echo "SIGN_PUBKEY=$SIGN_PUBKEY"
    fi
  } | sudo tee /etc/default/diting-agent > /dev/null

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
ReadWritePaths=$INSTALL_DIR $(dirname "$STATE_FILE")
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable diting-agent
  sudo systemctl start diting-agent

  echo "服务已启动：sudo systemctl status diting-agent"
else
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
    "encoding/json"
    "fmt"
    "io"
    "math/rand"
    "net/http"
    "os"
    "path/filepath"
    "runtime"
    "time"
)

const (
    checkMinInterval = time.Hour           // 最小检查间隔
    checkJitter      = 10 * time.Minute   // 随机偏移（错峰）
    httpClientTimeout = 30 * time.Second
)

// Updater 检查并应用更新。
type Updater struct {
    repoURL   string
    publicKey ed25519.PublicKey
    version   string
    token     string // GitHub PAT（可选，提速率限制）
    client    *http.Client
}

// NewUpdater 创建更新检查器。
func NewUpdater(repoURL, version, token string, publicKey []byte) (*Updater, error) {
    if len(publicKey) != ed25519.PublicKeySize {
        return nil, fmt.Errorf("invalid public key size: %d", len(publicKey))
    }
    return &Updater{
        repoURL:   repoURL,
        publicKey: ed25519.PublicKey(publicKey),
        version:   version,
        token:     token,
        client:    &http.Client{Timeout: httpClientTimeout},
    }
}

// Check 检查是否有新版本。返回新版本号，无更新返回空字符串。
func (u *Updater) Check(ctx context.Context) (string, error) {
    owner, repo, err := parseRepoURL(u.repoURL)
    if err != nil {
        return "", err
    }

    apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", owner, repo)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
    if err != nil {
        return "", err
    }
    req.Header.Set("Accept", "application/vnd.github+json")
    if u.token != "" {
        req.Header.Set("Authorization", "Bearer "+u.token)
    }

    resp, err := u.client.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusForbidden {
        return "", fmt.Errorf("GitHub API rate limit exceeded (add GITHUB_TOKEN)")
    }
    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("GitHub API status %d", resp.StatusCode)
    }

    var release struct {
        TagName string `json:"tag_name"`
        Prerelease bool `json:"prerelease"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
        return "", err
    }

    // 跳过 pre-release
    if release.Prerelease {
        return "", nil
    }

    // 比较版本（简单字符串比较，v 前缀）
    if release.TagName == u.version {
        return "", nil
    }

    return release.TagName, nil
}

// Update 下载并验证新版本。
func (u *Updater) Update(ctx context.Context, version string) error {
    owner, repo, err := parseRepoURL(u.repoURL)
    if err != nil {
        return err
    }

    os, arch := runtime.GOOS, runtime.GOARCH
    binaryName := fmt.Sprintf("diting-agent-%s-%s", os, arch)
    if os == "windows" {
        binaryName += ".exe"
    }

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

    if err := u.download(ctx, downloadURL, binaryPath); err != nil {
        return fmt.Errorf("download binary: %w", err)
    }
    if err := u.download(ctx, sigURL, sigPath); err != nil {
        return fmt.Errorf("download signature: %w", err)
    }

    // 验证签名（传原文，不预哈希）
    if err := u.verify(binaryPath, sigPath); err != nil {
        return fmt.Errorf("verify signature: %w", err)
    }

    if err := os.Chmod(binaryPath, 0o755); err != nil {
        return err
    }

    // 原子替换当前二进制
    execPath, err := os.Executable()
    if err != nil {
        return err
    }

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

// verify 验证二进制签名（Ed25519，传原文）。
func (u *Updater) verify(binaryPath, sigPath string) error {
    binary, err := os.ReadFile(binaryPath)
    if err != nil {
        return err
    }
    sig, err := os.ReadFile(sigPath)
    if err != nil {
        return err
    }
    // 关键：传原文，Ed25519 内部处理哈希
    if !ed25519.Verify(u.publicKey, binary, sig) {
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
    if u.token != "" {
        req.Header.Set("Authorization", "Bearer "+u.token)
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

// parseRepoURL 从 https://github.com/owner/repo 提取 owner/repo。
func parseRepoURL(raw string) (owner, repo string, err error) {
    // 支持 github.com 和自建 Gitea/Forgejo
    for _, prefix := range []string{
        "https://github.com/",
        "http://github.com/",
        "https://",
        "http://",
    } {
        if strings.HasPrefix(raw, raw) {
            s := raw[len(prefix):]
            s = strings.TrimSuffix(s, "/")
            s = strings.TrimSuffix(s, ".git")
            parts := strings.Split(s, "/")
            if len(parts) >= 2 {
                return parts[0], parts[1], nil
            }
        }
    }
    return "", "", fmt.Errorf("cannot parse repo URL: %s", raw)
}

// copyFile 复制文件。
func copyFile(src, dst string) error {
    data, err := os.ReadFile(src)
    if err != nil {
        return err
    }
    return os.WriteFile(dst, data, 0o755)
}
```

### 7.2 集成到 main.go

```go
// main.go 中添加自动更新
func runUpdater(ctx context.Context, u *Updater, onUpdate func()) {
    // 随机偏移，避免所有 Agent 同时请求 GitHub API
    jitter := time.Duration(rand.Int63n(int64(checkJitter)))
    time.Sleep(jitter)

    ticker := time.NewTicker(checkMinInterval)
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
                continue
            }

            log.Printf("[updater] new version: %s, updating...", newVersion)
            if err := u.Update(ctx, newVersion); err != nil {
                log.Printf("[updater] update failed: %v", err)
                continue
            }

            log.Printf("[updater] updated to %s, restarting...", newVersion)
            onUpdate()
            return
        }
    }
}
```

---

## 八、与现有 diting.sh 的关系

| 场景 | 推荐方式 |
|------|---------|
| 日常更新 | 自动更新（fork + push Release） |
| 紧急回滚 | `diting.sh --update-agent` 手动通道 |
| 首次部署 | `install.sh` 一键脚本 |
| 离线环境 | `diting.sh --update-agent` 手动通道 |

**自动更新是补充，不是替代**。`diting.sh` 的手动通道始终保留作为 fallback。

---

## 九、安全约束清单

| 约束 | 实现 |
|------|------|
| 默认关闭 | `AUTO_UPDATE=0` |
| 签名强制 | Ed25519，失败不更新 |
| 用户仓库 | 只监听用户指定的仓库 |
| 纯拉取 | 不执行远程代码 |
| 原子更新 | 失败自动回滚 |
| 版本锁定 | 可锁定到特定 tag |
| 私钥不进 CI | GitHub Secrets 注入 |
| 公钥不进仓库 | 环境变量配置 |
| Token 不进命令行 | 环境变量传入 |
| install.sh 校验 | SHA-256 checksum 先校验 |
| 错峰检查 | 随机 0-10 分钟偏移 |
| GitHub PAT | 可选，提速率限制 |

---

## 十、总结

| 特性 | 实现方式 |
|------|---------|
| 部署 | fork + install.sh + 批量工具 |
| 更新 | push Release → 自动检测 |
| 安全 | 签名验证 + 原子更新 |
| 回滚 | 删除 tag / push 旧版本 |
| 信任 | **信任边界收敛到用户自身** |

**Fork = 订阅，Push = 发布，签名 = 信任。**
