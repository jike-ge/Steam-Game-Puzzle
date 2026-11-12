# 用 1Panel 部署 Playtime Panorama

这个项目是零依赖的纯 Node 服务，不需要 `npm install`，也不需要数据库。
在 1Panel 上有两条路，**推荐第一条（Docker 编排）**，最省心：

| 方案 | 适合 | 用到的 1Panel 模块 |
|---|---|---|
| A. Docker 编排 | 大多数情况，一条命令搞定 | 「终端」+「网站」 |
| B. Node 运行环境 | 不想自己写 compose | 「网站 → 运行环境」+「网站」 |
| C. 直接用 systemd/pm2 | 不想用 Docker | 「终端」 |

不管走哪条，都要先准备两样东西：

- 一个 **Steam Web API 密钥**：<https://steamcommunity.com/dev/apikey>（免费，「域名」随便填）
- 服务器能访问 `api.steampowered.com`。**境外服务器直连即可**；国内服务器需要自己的代理，见下面「国内服务器」。

---

## 方案 A：Docker 编排（推荐）

### 1. 把代码放到服务器

1Panel 左侧「主机 → 文件」，进到 `/opt`，点「上传」把项目压缩包传上去，然后「解压」。
或者用「主机 → 终端」直接：

```bash
cd /opt
git clone https://你的仓库/playtime-panorama.git
cd playtime-panorama
```

没有仓库就上传 zip，解压后确认目录里有 `server.mjs`、`Dockerfile`、`docker-compose.yml`。

### 2. 写配置

在项目目录里新建 `.env`（把示例复制一份再改）：

```bash
cp .env.example .env
vi .env
```

最小可用内容：

```env
STEAM_API_KEY=你的32位密钥
HOST=0.0.0.0
PORT=8787
STEAM_PROXY=
DEMO_STEAM_ID=76561198000000000
```

> `.env` 只要放在项目目录，`docker compose` 会自动读它做变量替换，
> 直接 `node server.mjs` 跑也会读它。

### 3. 构建并启动

在「主机 → 终端」里：

```bash
cd /opt/playtime-panorama
docker compose up -d --build
```

第一次会拉 `node:22-alpine` 并构建，大概一两分钟。看到 `Started` 后自检：

```bash
curl -s http://127.0.0.1:8787/api/health
```

正常会返回类似：

```json
{
  "ok": true,
  "version": "1.4.0",
  "build": "6e8317e0",
  "configured": true,
  "proxy": { "enabled": false, "url": "", "source": "直连" },
  "demoSteamID": "76561198000000000",
  "coverSource": "auto",
  "covers": 0,
  "trackedGames": 0,
  "missingCovers": [],
  "cachedProfiles": 0
}
```

`configured: true` 说明密钥读到了。`covers: 0` 是正常的，封面会在第一次打开页面时自动缓存。
`build` 是当前代码的指纹，更新后拿它跟 `docker compose logs` 第一行对一下就知道有没有生效。

看日志：

```bash
docker logs -f playtime-panorama
```

### 4. 在 1Panel 里建站点 + 反向代理

左侧「网站 → 网站 → 创建网站」：

- 类型：**反向代理**
- 域名：填你的域名（例如 `panorama.example.com`），没有域名可以先填服务器 IP
- 代理地址：`http://127.0.0.1:8787`

创建后打开这个站点的「配置 → 反向代理」，确认上游是 `127.0.0.1:8787`，保存。

> **如果访问出现 502**：说明 OpenResty 到容器的路不通。
> 打开项目里的 `docker-compose.yml`，把端口改成 `"8787:8787"`（监听所有地址），
> 然后 `docker compose up -d`，反代地址改成 `http://<服务器内网IP>:8787` 即可。
> 这种写法请务必在「主机 → 防火墙」里**不要**放行 8787，只让反代访问。

### 5. 上 HTTPS

站点详情 →「HTTPS」→「创建证书」→ 选 Let's Encrypt → 申请，成功后打开「强制 HTTPS」。
用的是 1Panel 自带的 ACME，域名要先解析到这台服务器。

### 6. 防火墙

- 走反向代理：只需要放行 **80 / 443**
- 1Panel 默认面板端口别动
- **8787 不要对公网开放**（compose 里已经绑定在 127.0.0.1）

到这里 `https://你的域名/` 就能用了。

---

## 方案 B：1Panel「运行环境」（不用自己写 compose）

1Panel 的运行环境本质也是 Docker，只是帮你把启动命令和端口管起来。

### 1. 上传代码

同方案 A 第 1 步，记住目录，例如 `/opt/playtime-panorama`。

### 2. 创建 Node 运行环境

左侧「网站 → 运行环境 → 创建运行环境」（不同版本按钮名称略有差异）：

| 字段 | 填什么 |
|---|---|
| 名称 | `panorama` |
| 应用类型 | `Node.js` |
| Node 版本 | `22` 或 `20` |
| 源码目录 | `/opt/playtime-panorama` |
| 启动命令 | `node server.mjs` |
| 端口 | `8787` |
| 外部访问 | 不建议开，交给反代 |

创建后 1Panel 会用 `node` 镜像把这个目录挂进去跑起来，状态变成「运行中」即可。

### 3. 写 .env

「主机 → 文件」进入 `/opt/playtime-panorama`，新建 `.env`（内容同方案 A 第 2 步）。

> 运行环境里改完 `.env` 要**重启**一下这个 Node 运行环境才生效。

### 4. 建网站 + 反向代理

「网站 → 网站 → 创建网站」→ 类型选「反向代理」→ 代理地址 `http://127.0.0.1:8787`。
如果 502，把代理地址换成 `http://<服务器内网IP>:8787`。

后面 HTTPS、防火墙同方案 A 的第 5、6 步。

---

## 方案 C：直接 systemd（不用 Docker）

```bash
# /etc/systemd/system/panorama.service
[Unit]
Description=Playtime Panorama
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/playtime-panorama
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now panorama
```

`.env` 一样放在项目目录里，会自己读。

也可以用 1Panel「计划任务」里建一个自启脚本，或者用 pm2：`pm2 start server.mjs --name panorama`。

---

## 环境变量说明

| 变量 | 默认 | 说明 |
|---|---|---|
| `STEAM_API_KEY` | 空 | **必填**，否则读不到游戏库 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 容器/反代场景必须 `0.0.0.0` |
| `STEAM_PROXY` | 自动探测 | 连不上 Steam 时用，例如 `http://127.0.0.1:7890` |
| `STEAM_API_BASE` | `https://api.steampowered.com` | 换接口地址（一般不用动） |
| `STEAM_COMMUNITY_BASE` | `https://steamcommunity.com` | 同上 |
| `DEMO_STEAM_ID` | 空 | `/demo` 用哪个账号，留空则用自带示例 |
| `CACHE_DIR` / `COVER_DIR` | `./data/cache` / `./data/covers` | 缓存目录，compose 已挂到宿主机 |

---

## 国内服务器

服务器本身连不上 Steam 时，有三种解法：

1. **把服务放在境外机器上**（最省事，1Panel 的海外 VPS 都可以）
2. **服务器上跑一个代理**（Clash/V2Ray/sing-box），然后：
   - 直接 `node` 跑：`STEAM_PROXY=http://127.0.0.1:7890`
   - Docker 里跑：`STEAM_PROXY=http://host.docker.internal:7890`
     （compose 里已经加了 `host.docker.internal:host-gateway`）
3. **给容器配 HTTP 代理**：在 compose 的 `environment` 里加 `HTTP_PROXY`/`HTTPS_PROXY`

启动日志会打印当前用的什么：

```
Steam 代理：http://host.docker.internal:7890（STEAM_PROXY）
Steam API 密钥：已从环境变量读取
示例档案：76561198000000000
```

---

## 常见问题

**打开是 502 / 连不上**
- `docker ps` 看容器是不是 `Up`
- `curl http://127.0.0.1:8787/api/health` 在服务器本机能通吗？不通就是容器没起来或 `HOST` 不是 `0.0.0.0`
- 反代地址换 `http://<内网IP>:8787` 再试

**页面能开，但墙是空的 / 一直转圈**
- 看 `/api/health` 的 `configured` 是不是 `true`，`false` 就是没读到密钥
- 打开 `/demo`，页面底部会弹出具体原因（密钥缺失 / 被拒绝 / 游戏详情私密 / 连不上 Steam）
- 如果是 `private`：这个账号的「游戏详情」没公开
- 如果是 `unreachable`：服务器连不上 Steam，见上面「国内服务器」

**封面全是灰块**
- 服务器访问不了 `cdn.cloudflare.steamstatic.com`，或者写不进 `data/covers`
- 进容器看一眼：`docker exec -it playtime-panorama ls /app/data/covers`

**改了代码怎么更新**

```bash
cd /opt/playtime-panorama
git pull            # 或重新上传文件
docker compose up -d --build
```

确认线上跑的是哪一版：

```bash
curl -s http://127.0.0.1:8787/api/health | grep -o '"version":"[^"]*"'
```

启动日志第一行也会打印 `Playtime Panorama v1.2.0`。

> 更新后页面还是旧样子，先 **Ctrl+F5** 强刷。
> HTML 是 `no-cache`，但 CSS/JS 会被浏览器缓存 120 秒。
> 如果强刷后还带着已经删掉的界面元素，说明文件根本没传上去——
> 在服务器上 `grep -c "示例档案还没同步" public/profile.html` 应该是 `0`。

**备份什么**

只需要 `data/` 目录（`data/cache` 是时长缓存，`data/covers` 是封面）。
可以直接在 1Panel「计划任务 → 备份」里对项目目录打包。

**内存/磁盘占用**

常驻内存约 40–60 MB；封面每张 20–40 KB，一千款游戏大约 30 MB。

---

## 安全提醒

- 8787 只监听 127.0.0.1，公网只开 80/443，走 1Panel 的反向代理
- 密钥放 `.env`，别提交到 git（`.gitignore` 已忽略）
- 容器内以 root 运行（方便直接写挂载目录）。要收紧的话，在 `Dockerfile` 里加 `USER node`，
  并在宿主机执行 `chown -R 1000:1000 data/`
