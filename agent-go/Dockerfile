# Diting Agent (Go) - scratch 极简镜像（多阶段构建，零运行时依赖）
#
# 形态说明：
#   - 采集：容器内 /proc/{stat,meminfo,loadavg,uptime,net/dev} 天然反映宿主全局
#     （Docker 不隔离这些统计），DISK_PATH=/host + `-v /:/host:ro` 后容器
#     mount 命名空间中生成 /host 前缀条目，disk.go 的 diskList("/host") 据此
#     统计宿主多盘（与 Python 版 collector 口径一致）。
#   - 网络：必须 --network host，否则 /proc/net/dev 读到的是容器视角。
#   - 安全：scratch + USER 1000 + compose 里 cap_drop ALL + no-new-privileges。
#     纯 TCP 探测不需要 NET_RAW（不引 ICMP），比 Python 版（ping 需 NET_RAW）更小权限面。
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/diting-agent .

FROM scratch
# 运行环境变量（由 docker run -e 注入；占位默认值，启动前必须设置前三个）
ENV SERVER_URL="" \
    AGENT_ID="" \
    AGENT_TOKEN="" \
    INTERVAL=15 \
    DISK_PATH=/host \
    PROBE_TARGETS="CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8"

COPY --from=build /out/diting-agent /diting-agent

# 降权运行（scratch 无用户库，直接用数字 uid/gid = 1000）
USER 1000:1000

ENTRYPOINT ["/diting-agent"]
