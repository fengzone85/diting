# Diting Agent — 极简镜像（仅依赖 Python 标准库，无需 pip 安装）
FROM python:3.11-slim
WORKDIR /app

# 安装 ping 使网络质量自测可用 ICMP（默认仅 TCP 443/80/53 回退；
# 部分运营商 DNS/探测点未开放这些端口，会被误判为"不可达"，如移动 211.136.192.6）。
# iputils-ping 的 /bin/ping 自带 cap_net_raw 文件能力，非 root 用户亦可发送 ICMP。
# 放在 COPY 之前作为独立层：改 agent 代码不会使 apt 层失效，离线/弱网环境可复用缓存。
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户（uid=1000，对齐宿主机首个普通用户，避免文件权限漂移）
RUN useradd -r -u 1000 -s /bin/false diting

COPY agent.py collector.py ./

# 运行环境变量（由 docker run -e 注入；默认值仅作占位，启动前必须设置）
ENV SERVER_URL="" \
    AGENT_ID="" \
    AGENT_TOKEN="" \
    INTERVAL=15 \
    DISK_PATH=/ \
    STATE_FILE=/data/state.json \
    PROBE_TARGETS="移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8"

# 月度流量计数状态落盘（建议挂卷持久化）；
# 目录在切用户前创建并 chown，保证 diting 用户可读写
RUN mkdir -p /data && chown diting:diting /data

# 降权运行：容器不再以 root 身份执行
USER diting

CMD ["python", "agent.py"]
