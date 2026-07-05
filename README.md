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


wrangler.toml(配置)

index.js(完整 Worker 代码，含登录面板+定时巡查+GitHub 触发逻辑)

部署顺序简单说一下：

wrangler kv namespace create TUNNEL_KV → 把返回的 id 填进 wrangler.toml

wrangler secret put DASHBOARD_PASSWORD → 设置面板登录密码

wrangler deploy → 部署上线

打开分配到的 *.workers.dev 地址,登录后在面板里填 Cloudflare Account ID / API Token,再逐条添加隧道(Tunnel ID、名称)和对应的 GitHub 仓库/workflow 文件/分支

核心检测逻辑是每 3 分钟(可在 wrangler.toml 里改 cron)调用一次 Cloudflare 的 Tunnel 详情接口拿 status 字段,只在"从正常变异常"这个跳变点触发一次对应的 GitHub Actions,避免隧道持续断线时被反复触发。

三项分别详细说明是:

1. Cloudflare Account ID

是什么:你的 Cloudflare 账号的唯一标识,用来告诉 API "查询哪个账号下面的隧道"。
怎么获取:

登录 Cloudflare 控制台
随便点开一个你的站点(域名)
在右侧栏往下拉,能看到 "Account ID" 一行,后面跟着一串字母数字,点击旁边的复制图标即可

如果你没有绑定域名,也可以在 Zero Trust 后台(one.dash.cloudflare.com)的地址栏里看,URL 通常长这样:
https://one.dash.cloudflare.com/<这一串就是Account ID>/...     

2. Cloudflare API Token
   
是什么:一个授权令牌,让 Worker 有权限通过 API 去读取你 Tunnel 的状态。不是你登录 Cloudflare 用的密码,是单独创建的、可以限定权限范围的令牌。
怎么获取:

打开 API Tokens 页面(路径:右上角头像 → My Profile → API Tokens)
点击 Create Token
选择 Create Custom Token(自定义令牌,而不是用预设模板)
权限(Permissions)里添加:

Account → Cloudflare Tunnel → Read


Account Resources 选你要监控的那个账号
点 Continue → Create Token,生成后立刻复制保存(这个页面关掉后就再也看不到完整值了,只能重新生成)

3. GitHub Token
   
是什么:授权 Worker 调用 GitHub API 去触发你仓库里的 Actions 工作流的令牌,和 GitHub 登录密码无关。
怎么获取(推荐用 Fine-grained token,权限更精细安全):

登录 GitHub → 右上角头像 → Settings
左侧最下面找到 Developer settings
选择 Personal access tokens → Fine-grained tokens
点击 Generate new token
填写:

Token name:随便起个名字,比如 tunnel-monitor
Expiration:建议设置有效期(比如 90 天或 1 年),到期需要重新生成替换
Repository access:选 "Only select repositories",勾选你要触发工作流的那个仓库(如 fnos9527/falixnodes--Run)


下拉到 Permissions → Repository permissions,找到 Actions,权限设置为 Read and write
点 Generate token,复制保存这串以 github_pat_ 开头的字符串


⚠️ 这三项都只会显示一次,生成后一定要马上复制粘贴到面板里保存,页面刷新后就看不到原文了,如果忘记复制,只能删掉重新生成一个。
