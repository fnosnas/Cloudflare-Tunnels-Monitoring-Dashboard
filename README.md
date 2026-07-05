# Cloudflare-Tunnels-Monitoring-Dashboard

Worker 定时(Cron Trigger)调用 Cloudflare API 检查每条 Tunnel 的状态
KV 存储:面板配置(账号信息、隧道列表、GitHub 触发参数)、隧道上次状态(用于判断"由正常变异常"这个跳变,避免重复触发)、操作日志
面板用密码登录,登录态用随机 token 存 KV(带过期时间)+ Cookie 维持
检测到某条隧道异常时,调用 GitHub API 触发对应仓库的 workflow

监控 Tunnel 需要的关键数据:

Cloudflare Account ID
Cloudflare API Token(至少要有 Cloudflare Tunnel:Read 权限)
Tunnel ID(每条隧道唯一,在 Zero Trust 后台的 Networks → Tunnels 里能看到)
Tunnel Name(仅用于面板展示,方便识别)

触发 GitHub Actions 需要:

目标仓库 owner/repo
workflow 文件名(如 deploy.yml)或 workflow ID
分支 ref(如 main)
一个有 workflow 权限的 GitHub Token(建议用 Fine-grained PAT)

现在开始写代码。The user prompt is empty, so I cannot determine the primary language. However, based on the thinking block alone, here is my summary:

Orchestrated deployment documentation composition in ChineseThe user prompt is empty, so I cannot determine the primary language. However, based on the thinking block alone, here is my summary:

Orchestrated deployment documentation composition in Chinese三个文件已经生成好了：wrangler.toml(配置)、src/index.js(完整 Worker 代码，含登录面板+定时巡查+GitHub 触发逻辑)、README.md(部署步骤和字段说明)。
部署顺序简单说一下：

wrangler kv namespace create TUNNEL_KV → 把返回的 id 填进 wrangler.toml
wrangler secret put DASHBOARD_PASSWORD → 设置面板登录密码
wrangler deploy → 部署上线
打开分配到的 *.workers.dev 地址,登录后在面板里填 Cloudflare Account ID / API Token,再逐条添加隧道(Tunnel ID、名称)和对应的 GitHub 仓库/workflow 文件/分支

核心检测逻辑是每 3 分钟(可在 wrangler.toml 里改 cron)调用一次 Cloudflare 的 Tunnel 详情接口拿 status 字段,只在"从正常变异常"这个跳变点触发一次对应的 GitHub Actions,避免隧道持续断线时被反复触发。
