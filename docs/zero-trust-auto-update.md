# 信任边界收敛到用户自身的自动更新方案

> 最后更新：2026-07-28
> 状态：设计阶段
> 定位：**可选的高级运维模式**，默认关闭

---

## 〇、与项目安全哲学的关系

### 本项目原有底线

`README_EN.md` 第 237-247 行：

> "agents self-update by fetching an install script from the server and running `bash -s install` as root ... Both are command channels"

**原底线**："Agent 不执行任何远程代码"

### 本方案对底线的重新界定

| 方案 | 底线 | 项目立场 |
|------|------|---------|
| 服务端推送更新 | 执行服务端下发的代码 | ❌ 拒绝 |
| Diting 官方推送 | 执行 Diting 官方代码 | ❌ 拒绝 |
| **用户 fork + 用户签名** | **只执行用户自己签名过的代码** | ✅ 允许 |

**核心区别**：

- 服务端/官方推送 = **信任第三方代码** → 第三方被入侵 = 全网 Agent 被控
- 用户 fork + 签名 = **只执行自己审核 + 签名的代码** → 信任边界收敛到用户自身

**底线的重新界定**：
> 从"Agent 不执行任何远程代码"演进为"Agent 只执行用户自己审核并签名的远程代码"。

这是可接受的设计演进，因为代码来源和签名密钥都完全由用户控制。

### 风险转移，不是消除

| 信任锚点 | 失陷后果 | 风险量级 |
|---------|---------|---------|
| Diting 服务端被控 | 所有 Agent 被控 | 高 |
| **用户私钥 + 账号失陷** | **所有 Agent 被控** | **同等高** |

**重要认知**：本方案把风险从"服务端安全"转移到"用户自身的安全卫生"（密钥管理、账号安全、CI 完整性），**风险没有消失，只是锚点变了**。

"信任自己"的准确理解：**把风险收敛到你自身的安全卫生上**，而不是消除了风险。

---

## 一、核心理念

**"Fork 即订阅，本地签名发布，签名即信任"**

| 原则 | 说明 |
|------|------|
| 不信任服务端 | Diting 服务端不发送任何指令 |
| 不信任客户端 | Agent 不执行任何未签名的远程代码 |
| 不信任 Diting 官方 | 代码开源但用户自行审核 |
| **只信任自己** | 用户 fork 仓库，本地签名发布 |

**信任边界**：收敛到用户自身。

| 组成部分 | 说明 |
|---------|------|
| 用户私有仓库 | 代码来源（外人无法修改） |
| 用户签名私钥 | 代码完整性验证（用户本地保管） |
| 用户 GitHub 账号 | 发布渠道（需妥善保护） |

---

## 二、架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户（唯一信任锚点）                        │
│                                                                 │
│   ┌───────────────────┐       ┌───────────────────┐             │
│   │ 用户 Git 仓库      │       │ 签名密钥对          │             │
│   │  ├─ diting-server │       │  ├─ private.pem   │             │
│   │  │   (fork)       │       │  │   (本地保管)    │             │
│   │  └─ diting-agent │       │  └─ public.pem    │             │
│   │      (fork)       │       │                   │             │
│   └─────────┬─────────┘       └─────────┬─────────┘             │
│             │ Release                    │ 签名（本地执行）       │
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
│  环境变量（禁止任何写凭证）：                                      │
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
│  环境变量（禁止任何写凭证）：                                      │
│  AUTO_UPDATE=1                                                  │
│  UPDATE_REPO=https://github.com/用户/diting-agent               │
│  SIGN_PUBKEY=用户公钥                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、真实攻击面（诚实版）

### 你以为的威胁 vs 真正的威胁

| 你以为的 | 真正的威胁 | 现实可能性 |
|---------|-----------|-----------|
| 外人改你私有仓库 | 极小 | 低 |
| ~~CI 供应链投毒~~ | ✅ 恶意 action、依赖混淆 | **高** |
| ~~账号被盗~~ | ✅ 无 2FA、钓鱼 | **高** |
| ~~本地构建机被控~~ | ✅ 恶意软件、键盘记录器 | **中高** |

### Agent 被控泄露面

| 凭证 | 泄露后果 | 风险 |
|------|---------|------|
| `SIGN_PUBKEY` | 公钥本就可公开 | ✅ 无风险 |
| `UPDATE_REPO` | 仓库 URL 是公开信息 | ✅ 无风险 |
| `AGENT_TOKEN` | 只能伪造本机数据，无法横向移动 | ✅ 项目已承认 |

### 新增出站依赖

| 依赖 | 用途 | 风险 |
|------|------|------|
| `api.github.com` | 检查新版本 | 只读 |
| `objects.githubusercontent.com` | 下载二进制 | 静态文件 |

**缓解**：服务端代理（推荐）/ 自托管 Forgejo / 错峰缓存

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

# ========== 2. 生成签名密钥（本地执行） ==========
openssl genpkey -algorithm Ed25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem
# 保管好 private.pem（推荐 YubiKey 或离线存储）
# public.pem 将配置到服务端和 Agent

# ========== 3. 部署服务端 ==========
export DITING_ADMIN_TOKEN=your-admin-token
curl -fsSL https://raw.githubusercontent.com/你的/diting-server/main/install.sh | bash -s \
  --update-repo https://github.com/你的/diting-server \
  --sign-pubkey "$(cat update-public.pem)"

# ========== 4. 批量部署 Agent ==========
export DITING_TOKEN=your-agent-token
pssh -h hosts.txt -i "curl -fsSL https://raw.githubusercontent.com/你的/diting-agent/main/install.sh | bash -s \
  --server https://monitor.example.com \
  --id {{host}} \
  --update-repo https://github.com/你的/diting-agent \
  --sign-pubkey '$(cat update-public.pem)'"
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

# 等待 GitHub Actions 构建完成（CI 不持有私钥，只编译）
gh release view v2.1.0

# 本地签名（私钥永不离开本机）
make sign  # 下载 CI 构建产物 → 本地签名 → 上传 .sig 到 Release

# → 所有服务端实例在 1 小时内自动更新
```

### 4.3 回滚

```bash
# 删除有问题的 Release
git push origin --delete v1.1.0
gh release delete v1.1.0
# → Agent 检测到 latest 变化，自动回滚到 v1.0.0
```

---

## 五、签名验证流程

### 5.1 签名算法

**Ed25519**：签名快、验证快、签名短（64 字节），无需预哈希。

### 5.2 签名生成（本地执行，私钥永不进 CI）

```bash
# 下载 CI 构建产物
gh release download v1.1.0 --pattern "dist/*" -D dist/

# 对每个二进制文件生成签名
for binary in dist/*; do
  openssl dgst -sha256 -sign update-private.pem \
    -out "${binary}.sig" "${binary}"
done

# 上传签名到 Release（不上传私钥）
gh release upload v1.1.0 dist/*.sig
```

**关键约束**：
- 私钥只在本地存在
- CI 只负责编译，不负责签名
- 签名在本地执行后上传到 Release

### 5.3 签名验证（Agent/服务端）

```go
// 关键：传原文，不要预哈希
func verifySignature(binary, signature []byte, publicKey ed25519.PublicKey) error {
    if !ed25519.Verify(publicKey, binary, signature) {
        return errors.New("signature verification failed")
    }
    return nil
}
```

**常见错误**（已修正）：
```go
// ❌ 错误：预哈希后传入
hash := sha256.Sum256(binary)
ed25519.Verify(publicKey, hash[:], signature)

// ✅ 正确：传入原文（Ed25519 内部处理哈希）
ed25519.Verify(publicKey, binary, signature)
```

---

## 六、GitHub Actions CI/CD

### 6.1 服务端 `.github/workflows/release.yml`

```yaml
name: Build

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }

      - name: Build
        run: |
          npm ci
          npm run build
          mkdir -p dist
          tar -czf dist/diting-server-linux-amd64.tar.gz -C build .

      - name: Upload Artifact
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create ${{ github.ref_name }} dist/* --generate-notes || \
          gh release upload ${{ github.ref_name }} dist/* --clobber
```

**注意**：CI 只做编译，**不做签名**。签名由用户在本地执行。

### 6.2 Agent `.github/workflows/release.yml`

```yaml
name: Build

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
          - { os: linux, arch: amd64 }
          - { os: linux, arch: arm64 }
          - { os: windows, arch: amd64 }
          - { os: darwin, arch: amd64 }
          - { os: darwin, arch: arm64 }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }

      - name: Build
        env:
          GOOS: ${{ matrix.os }}
          GOARCH: ${{ matrix.arch }}
        run: |
          output="dist/diting-agent-${{ matrix.os }}-${{ matrix.arch }}"
          [ "${{ matrix.os }}" = "windows" ] && output="${output}.exe"
          CGO_ENABLED=0 go build -ldflags="-s -w" -o "${output}" .

      - name: Upload Artifact
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release upload ${{ github.ref_name }} dist/* --clobber
```

**注意**：CI 只做编译，**不做签名**。

---

## 七、make sign（本地签名）

```makefile
# Makefile
VERSION := $(shell git describe --tags --always)
DIST_DIR := dist

.PHONY: build sign upload

## build: 编译所有平台（CI 执行）
build:
	@mkdir -p $(DIST_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o $(DIST_DIR)/diting-agent-linux-amd64 .
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o $(DIST_DIR)/diting-agent-linux-arm64 .
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o $(DIST_DIR)/diting-agent-windows-amd64.exe .
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o $(DIST_DIR)/diting-agent-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o $(DIST_DIR)/diting-agent-darwin-arm64 .

## sign: 本地签名（用户执行，私钥永不进 CI）
sign: build
	@if [ ! -f update-private.pem ]; then \
		echo "错误：update-private.pem 不存在。请妥善保管私钥，不要上传到任何地方。"; \
		exit 1; \
	fi
	@echo "签名所有二进制..."
	@for f in $(DIST_DIR)/diting-agent-*; do \
		[ -f "$$f" ] && openssl dgst -sha256 -sign update-private.pem -out "$$f.sig" "$$f"; \
	done
	@echo "签名完成。上传签名文件：make upload-sigs"

## upload-sigs: 上传 .sig 到当前 Release
upload-sigs:
	gh release upload $(VERSION) $(DIST_DIR)/*.sig --clobber
```

---

## 八、install.sh 一键部署脚本

### 8.1 脚本校验

```bash
# 用户首次使用时，先校验 install.sh 本身的完整性
curl -fsSL https://raw.githubusercontent.com/你的仓库/main/install.sh -o install.sh
echo "expected-sha256hash  install.sh" | sha256sum -c
bash install.sh ...
```

### 8.2 完整脚本

```bash
#!/bin/bash
set -euo pipefail

# ...（与之前版本相同，此处省略以节省篇幅）...
```

---

## 九、自动更新模块（Agent 侧）

### 9.1 更新检查器

```go
// updater/updater.go
// ...（与之前版本相同）...
```

### 9.2 服务端代理（推荐限速方案）

```javascript
// 服务端添加代理端点
app.get('/api/upgrades/:type', async (req, res) => {
  const { type } = req.params;
  const repo = await getUpdateRepo(type);
  const cached = await cache.get(`update:${type}`);
  if (cached) return res.json(cached);

  const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` }
  });
  const data = await resp.json();
  await cache.set(`update:${type}`, data, 3600);
  res.json(data);
});
```

Agent 请求 `https://monitor.example.com/api/upgrades/agent`，不直连 GitHub。

---

## 十、与现有 diting.sh 的关系

| 场景 | 推荐方式 |
|------|---------|
| 日常更新 | 自动更新（fork + 本地签名 + push Release） |
| 紧急回滚 | `diting.sh --update-agent` 手动通道 |
| 首次部署 | `install.sh` 一键脚本 |
| 离线环境 | `diting.sh --update-agent` 手动通道 |

**自动更新是补充，不是替代**。

---

## 十一、安全约束清单

| 约束 | 实现 |
|------|------|
| 默认关闭 | `AUTO_UPDATE=0` |
| 签名强制 | Ed25519，失败不更新 |
| 用户仓库 | 只监听用户指定的仓库 |
| 纯拉取 | 不执行远程代码（已签名除外） |
| 原子更新 | 失败自动回滚 |
| **私钥本地保管** | **永不上传 CI/GitHub/任何远程** |
| **CI 只编译不签名** | **签名由用户在本地执行** |
| **Agent 禁止写凭证** | **严禁 `GITHUB_TOKEN`/`PAT`** |
| Token 不进命令行 | 环境变量传入 |
| install.sh 校验 | SHA-256 checksum 先校验 |
| 错峰检查 | 随机 0-10 分钟偏移 |
| 服务端代理 | 限速问题由服务端解决 |

---

## 十二、总结

| 特性 | 实现方式 |
|------|---------|
| 部署 | fork + install.sh + 批量工具 |
| 更新 | push Release → 自动检测 |
| 安全 | 本地签名 + 原子更新 |
| 回滚 | 删除 tag / push 旧版本 |
| 信任 | **信任边界收敛到用户自身的密钥管理** |

**Fork = 订阅，本地签名 = 信任，Agent 只执行你签过的代码。**
