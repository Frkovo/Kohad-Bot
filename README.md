# SDGB Tools Discord Bot

当前启用个人默认成绩服务器 cn / jp / intl。国服保留 :8788 扫码与水鱼／落雪；JP、国际服增加服务端 NET 登录与本地 B50。MuNET 和 Missless 暂时旁路，保留适配代码和旧数据，但不提供选择、绑定、查询或同步入口。手机与桌面都使用 Discord 原生弹窗、选卡和按钮。

新增登录、加密存储、缓存和旁路规则见 [多服务器接入说明](MULTI_SERVER.md)。旧私服默认值在读取时回退国服，原偏好记录、绑定和快照保留。

## 命令

| 命令 | 行为 |
|---|---|
| `/server [server]` | 查看或更换个人默认成绩服务器 |
| `/bind [server]` | 国服二维码弹窗；JP / 国际服填写 SEGA ID 并选卡 |
| `/sync [server]` | 国服弹窗填新二维码；远程服后台刷新 |
| `/unbind [server]` | 确认后删除远程服登录信息，保留该服成绩缓存 |
| `/upload sgwcmaid:<二维码或链接>` | 统一读取、保存本地成绩 / 次数 / 玩家资料，并自动同步水鱼和落雪，无需按钮确认 |
| `/b50 [server] [source] [refresh] [sgwcmaid] [public]` | 使用所选服曲库与规则生成 B35 + B15；server 仅覆盖当次查询；未指定时依次使用已保存的默认、数据库中唯一有数据的服务器，都无法确定则弹出选择菜单；图片默认仅自己可见，`public:true` 才发到频道；带 sgwcmaid 时图片先发出，水鱼/落雪同步结果随后私密通知 |
| `/nb50 [server] [source] [refresh] [sgwcmaid] [public]` | 国服使用水鱼 `chart_stats.fit_diff`；其他服缺可靠拟合数据时明确拒绝；图片可见性同 `/b50` |
| `/pc50 [server] [source] [refresh] [sgwcmaid] [public]` | 国服本地全库累计次数 Top50（含宴谱）；NET 缺完整次数；图片可见性同 `/b50` |
| `/binddf` | DC-only 国服二维码入口与已有水鱼绑定说明；不再发起网页绑定 |
| `/bindlx [method]` | Discord 内输入 **15 位好友码**；支持换绑、解绑 |
| `/getuserall sgwcmaid:<二维码或链接>` | 导出完整迁移包，同时保存本地资料并自动同步两边查分器 |
| `/tomunet sgwcmaid:<二维码或链接>` | 导出官方 UserMusicDetailList，同时保存本地资料并自动同步两边查分器 |
| `/help` | 显示同风格的公开命令帮助图 |

所有成功的 SGWCMAID 拉取都会更新本地账户，并独立同步水鱼与落雪：包括 `/upload`、附二维码的三种成绩图和两个导出命令。用户已明确授权每次读取后自动同步，不再保留预览 / 二次确认流程。先提交本地事务，再同步；任何一边失败不影响另一边，也不回滚本地资料。未配置 / 未绑定 / 缺写权限会明确报告原因；水鱼自动同步需要有效 OAuth 写权限。

二维码一次性，刷新成绩时需要新的二维码；查询已有本地数据无需扫码。15 分钟内的重复二维码共用一次拉取、保存与同步结果；只在内存保存二维码摘要与临时结果，不保存原二维码。正在扫描时，同一用户的另一张二维码会立即提示忙；本地成绩查询与帮助仍可使用。旧 `/import` 合并进 `/upload`，旧 `/fitb50` 改为 `/nb50`，不再注册旧名；Discord 尚未刷新的旧命令会转入新流程。

国服没有任何可读数据时（既没扫过码，也没绑定水鱼 / 落雪，连 Import-Token 都没有），`/b50`、`/nb50`、`/pc50` 不再直接报错，而是私密回复「你没有绑定任何数据，请选择以下三种方案导入：」并给出 **落雪**（好友码 / OAuth）、**水鱼**（Import-Token）和 **MAID**（国服二维码）三个按钮，各自进入原有的绑定流程。

可选 sgwcmaid 一旦填写，优先使用本次导入的本地成绩。自动 B50 数据源顺序为水鱼完整成绩 → 落雪 → 本地数据库。

所有扫码参数均支持：完整 84 位 `SGWCMAID…`、去掉 SGWC 的 80 位 `MAID…`、去掉完整前缀的时间戳 + 64 位十六进制内容，以及 `https://wq.wahlap.net/qrcode/req/MAID….html?...` 华立二维码链接（包括 Markdown 链接形式）。程序只在本地解析路径，忽略链接查询参数，不访问或提前消费二维码链接。

`/b50`、`/nb50`、`/pc50` 的成绩图默认仅调用者可见，加 `public:true` 才会发到频道；`/help` 仍对频道所有人可见；`/upload` 与账号绑定仅调用者可见。命令白名单保持原有配置。

## 并发与响应

Bot 收到命令先确认交互，再排队读取 / 绘图。机台读取默认最多 3 个同时执行，待处理总数最多 9；读取结束即释放槽位，水鱼和落雪同步不占机台队列。排队 / 同一用户忙 / 队列满都有回复。冷却只影响新扫码，重复二维码以及不附二维码的本地查图不受扫码冷却阻挡。

迁移服务使用 `MIGRATE_CONCURRENCY`（默认 3，允许 1–6），每次请求有独立 Cookie 上下文，不继承、覆盖或清理其他用户的 JSESSIONID。解析出游戏账号后加锁，同一游戏账号不能同时启动两次机台会话。超时取消尚未完成的读取，登出使用同一 Cookie 且不受读取取消信号影响。迁移会话和 Cookie 仅在内存持有，不进入旧的会话 / Cookie 落盘逻辑。

B50 与帮助图通过最多 2 个后台线程生成，主线程能继续接收 Discord 交互；图片队列上限 12。并发测试在生成两张完整 B50 时仍能确认第二条命令。需要同时更新 Bot 和迁移服务才能启用完整并发隔离。

## 计算与曲库

国服 ROM **1.56.00** 对应公共曲库的 **25500 舞萌DX 2026** 内容系列，次版本包含 25501 / 25502。ROM 版本和公共 API 版本编号不同，不应请求 `version=25600`。B15 按**谱面首次出现版本**筛选 25500–25999；B35 是此前版本，宴谱不参与 Rating。

- 所有成绩来源重新计算 Rating，不沿用过期的 `ra` / `dx_rating` / 平台总分。
- 达成率按 100.5% 封顶，使用官方阈值倍率，最后向下取整。
- 普通 DX 谱面的游戏 / 水鱼 ID 带 +10000；落雪使用共享歌曲 ID。例如 `11842` 对应落雪 `1842` 的 DX 谱面，不会误用 SD 定数。
- 落雪提供谱面版本、物量；水鱼提供当前定数；本机 SDGB1.56 的 Music.xml 快照补齐缺失谱面。
- 公共数据在线刷新并缓存，网络失败时使用 `assets/data/` 快照。新增曲绘在线拉取后缓存，随附 1681 张原项目曲绘。
- 拟合 B50 使用 `fit_diff` 的**原始精度**计算，仅显示时保留两位小数；缺少有效拟合定数的谱面明确标记并排除，不混入官方定数。
- PC50 按单个谱面的 playCount 排序；次数相同时以 Rating、达成率和歌曲 ID 稳定排序。图上分成 35 / 15 张仅为了复用布局，标题显示第 1–35 / 36–50 名。
- 落雪开发者 API 的完整列表是简化成绩，不含达成率。因此好友码模式只能从缓存 B50 和 Selection 候选重新计算；需要完整重新筛选时，使用落雪 OAuth、水鱼完整成绩或 `source:local`。

## 玩家资料与绘图

采用 [Yuri-YuzuChaN/maimaiDX](https://github.com/Yuri-YuzuChaN/maimaiDX) 的实际原图素材和 1400×1600 五列布局，保留作者署名及 MIT 许可。参考 [EasyMai](https://github.com/Lista233/EasyMai) 的拟合数据用法。

从迁移包 `data.pull.userData.userData` 读取 `userName` / `iconId` / `plateId`（兼容单元素数组、对象和 nameplateId 形态）。详细资料使用 plateId，登录预览使用 nameplateId；迁移服务会把预览资料的有效编号补到 source。空值 / 无效值不会挡住其他有效来源。落雪来源同时读取 `player.icon.id` / `player.name_plate.id`，补充本地缺少的头像与姓名框。B50、拟合 B50、PC50 优先显示当前 Discord 用户最近一次导入的游戏资料。素材暂时不可用时使用默认素材，后续请求会重试。

国服图上版本区域显示 CN；远程服显示服务器与底部版本／规则来源。B35 / B15 分区标题显示实际单曲 Rating 的和：`B35 Σ =…` / `B15 Σ =…`；PC 分区显示对应游玩次数之和。作者署名保留。

昵称下方 Rating 汇总条与昵称框同宽（272 px），按原图 276×36 的比例缩放，文字单独居中，不再拉伸成 350×27。

图片包括：曲绘、难度、谱面类型、达成率、定数、单曲 Rating、DX 分数 / 满分、FC / FS、DX 星级。PC50 的主要数值显示游玩次数，拟合 B50 显示拟合定数。

## 已有水鱼 OAuth 兼容

1. 在 [水鱼控制台](https://auth.diving-fish.com/console) 登记「由你自己部署运行」应用，生成 client_secret，配置 `DF_CLIENT_ID` / `DF_CLIENT_SECRET`。
2. 已有绑定继续按 `prober.records.read / prober.records.write` 的实际授权查询和同步。缺写权限时明确报告，保留本地导入并继续落雪同步。
3. DC-only 流程不发起新的水鱼网页授权；`/binddf` 改为国服二维码弹窗入口。旧绑定的短期 token 仍在内存缓存，并发请求共用一次换票。

[OAuth 快速接入文档](https://maimai.diving-fish.com/manual/docs/developer/oauth-quickstart/) · [水鱼开发者 API](https://maimai.diving-fish.com/manual/docs/developer/zh-api-document/)

## 落雪接入

好友码模式：填写 `LX_DEV_TOKEN`，执行 `/bindlx method:friend_code`。输入游戏 NET「好友」页的 **15 位好友码**，不是 Aime 卡号、玩家 ID 或 SGWCMAID。全角数字和空格自动归一，前导零保留，12 位 / 16 位不接受。对应玩家需要已在落雪同步，应用需要读取玩家 / 成绩和写入数据权限。

网页 OAuth 模式：在落雪开发者面板创建 OAuth 应用并登记回调地址，然后填写 `LX_CLIENT_ID`、`LX_CLIENT_SECRET`；回调默认 `${OAUTH_PUBLIC_BASE}/oauth-callback/lxns`，必须与面板登记地址完全一致，且由反向代理转发到 Bot 的 `OAUTH_PORT`。**只填 `LX_DEV_TOKEN` 时 `/bindlx` 只有好友码弹窗，不会出现 OAuth 授权按钮**——这是没配 OAuth 应用时最容易误解的地方。

开发者密钥请求使用 `Authorization: <密钥>` 和 `/api/v0/maimai/player/{friend_code}`；用户 OAuth 使用 `Authorization: Bearer <token>` 和 `/api/v0/user/maimai/player`，两者不会混用。

上传每批最多 500 条；429 / 5xx 退避重试一次；水鱼和落雪独立执行。OAuth 成绩上传后完整回读核对；落雪好友码模式抽查最多 3 条，并明确显示「抽查」。回读不可用或尚未同步时报告「上传已接受，尚未核实」，不把提交成功当成核对通过。

曲库未知的谱面不会静默丢弃：水鱼按本地曲库快照（`assets/data/sdgb-156-charts.json`）补歌曲名后照常提交，并报告水鱼实际匹配了多少条（它不认识歌名时会忽略）；落雪按 `id ≥ 10000 → DX(id-10000)` 的规则换算后照常提交，已知谱面排在前面的批次，只有真正无效的数据（0 分、难度越界、无 ID）才计入跳过。

[落雪开发者文档](https://maimai.lxns.net/docs/developer-guide) · [OAuth 文档](https://maimai.lxns.net/docs/oauth-guide) · [舞萌 DX API](https://maimai.lxns.net/docs/api/maimai)

## 数据存储：MySQL + Redis

玩家数据全部存 MySQL（`mysql:8.4`），Redis（`redis:7`）只放可丢失的短时状态。两者都由 `compose.yaml` 随 Bot 一起启动，不再使用内置 SQLite 或任何本地数据库文件。

- **MySQL**：`accounts` / `scores` 保存国服导入的成绩、次数和玩家资料；`server_preferences` / `server_bindings` / `server_snapshots` 保存多服务器偏好、绑定与快照；`df_bindings` / `df_import_tokens` / `lxns_bindings` 保存水鱼与落雪的凭据。表结构在启动时按 `CREATE TABLE IF NOT EXISTS` 幂等创建。
- 按 Discord 用户隔离，成绩主键为用户 / 游戏谱面 ID / 难度。重复拉取以累计 playCount 最大值保存，不做加法；保留最佳达成率、DX 分数、FC 和 FS。换绑到另一游戏账户时替换该 Discord 用户的旧成绩和资料，避免混号。
- 国服成绩表仅保存游戏账户 ID、昵称、头像 / 姓名框编号、导入时间、成绩和次数，不保存扫码凭据或原始迁移包。确认后的 SEGA 凭据、Cookie／私服访问凭据按 AES-256-GCM 加密后写入 `server_bindings.encrypted_auth`，详见 [多服务器接入说明](MULTI_SERVER.md)。
- **Redis**：扫码去重（同一张二维码 15 分钟内只拉取一次）、每用户扫码冷却、水鱼访问令牌缓存。丢了 Redis 只会多一次登录 / 扫码，不会丢玩家数据。
- 渲染缓存与排障日志在 `B50_DATA_DIR`（容器内 `/app/.data`，宿主机 `./data`），可以随时删除；玩家数据不在其中。

备份：`docker compose exec mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" > kohad.sql`，并单独保存 `B50_AUTH_KEY`（或 `binding-master.key`）——没有原密钥，已加密的远程服凭据无法解密。移机需携带 `assets/`、数据库导出、原密钥和独立保存的 `.env`。

## maimai NET 证书（JP / 国际服传输）

- 本机匿名请求日本站 `maimaidx.jp` 时，Node 因无法补全中间证书链报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；加入下面的公开中间证书后，Bot 请求链路可正常读取登录表单。
- 处理方式：`assets/certs/maimai-net-intermediates.pem` 内置两张公开中间 CA（GlobalSign RSA OV SSL CA 2018、GlobalSign GCC R46 OV TLS CA 2025），来源、指纹和有效期见 `assets/certs/PROVENANCE.md`。
- 仅 NET 专用 undici Agent 使用：CA 列表 = Node 默认根证书 + 上述两张中间证书；NET 请求经 `src/multiserver/transport.ts` 的 `netFetch` 发出（使用 `undici` 包自带的 fetch 与 Agent，二者版本配套）。
- 不做的事：不关闭 TLS 校验，不设置 `rejectUnauthorized: false`，不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不设置全局 dispatcher，不修改系统信任库，不在登录时动态下载或信任任何证书，不影响 Bot 其他 HTTPS 请求。
- 更新证书须人工重新核对原始来源、指纹和有效期，并同步更新 `PROVENANCE.md` 与 `test/transport.test.ts` 中的指纹常量。

## 排障日志与文案

- 失败回复会附带排查编号（如 `B50-1A2B3C4D`），同一编号也写入控制台 `[bot-debug]` 与日志文件，可直接搜索。
- 绑定、首次同步、主动刷新和自动刷新失败均报告具体阶段。已保存绑定而首次同步失败时可 `/sync` 重试；自动刷新失败但有缓存时仍发送缓存成绩图，并私密发送失败详情。国服迁移失败也有排查编号；迁移服务的自由文本错误不会回显到 Discord。
- 日志文件：`B50_DATA_DIR/logs/bot-debug.jsonl`（容器内即 `/app/.data/logs/`，宿主机 `./data/logs/`）。记录操作阶段、耗时、HTTP 状态、Cookie 数量、页面结构计数、难度与记录数，以及固定路由名和允许的域名。不会记录账号、密码、Cookie 值、Token、请求体、完整 URL（含跳转参数）、响应 HTML 或原始异常堆栈。
- 轮转：单个文件达到 5 MB 时改名为 `bot-debug.jsonl.1` 并新建文件，只保留一个备份，总占用约 10 MB 以内。
- 关闭文件日志：在 `.env` 设置 `B50_DEBUG_LOG=off`（控制台仍输出安全元数据）；改用其他路径：`B50_DEBUG_LOG=<路径>`。
- 文案统一在根目录 `keys.json`。`keys.json` 是部署文件之一，需与 `.env`、`assets/`、`.data/` 一起保留。修改后必须重启 Bot（程序不会自动重启）；缺失的 key 或占位参数会直接报错，避免发出残缺文字。
- `keys.json` 使用扁平的语义 key，例如 `bind.field.password`、`progress.readingDifficulty`、`diagnostic.details`；只修改右侧文字，保留 `{server}`、`{count}` 等占位参数。范围包含命令描述和选项、回复、按钮/弹窗、帮助图、B50 图上的文字及错误提示。歌曲名、玩家名和服务器返回的数值作为参数传入。
- 密码框限制：Discord 原生 TextInput 只有 Short / Paragraph 两种样式，没有密码类型，无法遮罩。密码框标题已注明“此输入框不遮罩”，输入内容不会回显到回复或日志中。

## 启动：Docker Compose

运行时只需要 Docker（Compose v2）；MySQL 与 Redis 由 compose 一并启动，Bot 镜像里没有 Node 运行时以外的构建工具。数据库要求 **MySQL ≥ 8.0.19**（`compose.yaml` 固定 `mysql:8.4` LTS）。

1. 复制 `.env.example` 到 `.env`，填写 `DISCORD_TOKEN`、`MIGRATE_URL`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD` 和所需查分器凭据。
2. 在 Discord Developer Portal 创建机器人，邀请权限包含 Send Messages、Embed Links、Attach Files 和 applications.commands。
3. `assets/` 不随仓库分发（曲绘、字体与第三方数据的版权原因），把现有的 `assets/` 放在项目根目录；compose 会只读挂载到 `/app/assets`。
4. 启动并查看日志：

```powershell
docker compose up -d --build
docker compose logs -f bot
```

`bot` 会等 MySQL 与 Redis 健康后启动，启动时幂等建表并差量注册 13 个命令。代码改动后重新 `docker compose up -d --build` 即可；容器收到 `SIGTERM` 会先关闭 MySQL 连接池与 Redis。

OAuth 回调监听在容器内 `0.0.0.0:3729`，compose 默认只映射到宿主机 `127.0.0.1:3729`，由反向代理转发 `https://<域名>/oauth-callback/*`；`OAUTH_PORT` 可改宿主机端口，`OAUTH_PUBLIC_BASE` 必须与查分器面板登记的回调一致。

数据卷：`mysql-data`、`redis-data` 由 Docker 管理，`./data` 只存渲染缓存与轮转日志。`docker compose down` 保留数据卷；`down -v` 会连同 MySQL 数据一起删除。

### 远程部署（SSH + Docker，无需镜像仓库）

`npm run deploy` 把当前 checkout 打包（源码、compose、keys.json、assets/data、certs、fonts）通过 tar-over-ssh 送到服务器，再执行 `docker compose up -d --build`。artwork 默认只在远端不完整时上传，避免每次都传 400 MB。

```dotenv
DEPLOY_HOST=your-server.example     # 必填
DEPLOY_USER=root
DEPLOY_DIR=/opt/kohad-bot
DEPLOY_KEY=C:\Users\you\.ssh\deploy-key
# DEPLOY_PASSWORD=...               # 没有密钥时使用
# DEPLOY_FULL_ASSETS=1              # 强制重新上传 assets/maimaiDX
```

脚本会先比对本地与远端的 `assets` 文件数（cover / pic / fonts / data），部署后再比对一次并打印差异——「远端缺歌」会直接显示成缺多少文件，而不是等用户发现图不对。服务器上的 `.env` 与 `compose.baota.yaml` 不会被覆盖；后者存在时会自动叠加为 `-f compose.yaml -f compose.baota.yaml`。

### 从旧版（SQLite + JSON）迁移数据

旧部署的 `.data/scores.sqlite`、`df-bindings.json`、`df-import-tokens.json`、`lxns-bindings.json` 不会自动进入 MySQL。`npm run migrate:legacy` 读取这些文件并写入 MySQL，可重复执行：

```powershell
# 先干跑：只解析与校验，不写数据库
node scripts/migrate-legacy.mjs --data-dir <旧 .data> --new-key-file <新 binding-master.key> --dry-run
# 正式写入（B50_AUTH_KEY / MYSQL_URL 与 Bot 使用同一套环境变量）
node scripts/migrate-legacy.mjs --data-dir <旧 .data> --new-key-file <新 binding-master.key>
```

- 账号与成绩按运行时同样的规则合并（playCount / 达成率 / FC / FS 取最优，换游戏账号则替换旧成绩），不会覆盖目标库更新的数据。
- 远程服凭据会用旧密钥解密、再用目标密钥重新加密（AAD 仍为 user/server/revision）；目标库已存在的同键绑定保留目标版本。
- 水鱼 / 落雪绑定在目标库已存在时保留目标版本；输出只打印数量，不打印任何令牌。
- 缺少密钥、旧库结构不对时会直接失败，不会写入半套数据。

### 本地开发

不必每次都重建镜像：装好 Node.js ≥22.13 与可访问的 MySQL / Redis（可用 `docker compose up -d mysql redis`），设置好 `.env` 后运行 `npm run dev`。`npm run build && npm start` 等价于容器内启动。

```powershell
npm install
npm test
npm run preview
```

`npm run check:sql` 用 SQL 解析器静态检查 `src/store` 里的 MySQL 语句，不需要数据库。测试默认使用内存实现，不需要数据库；要验证真实 SQL，把 `MYSQL_URL` 指向一个可随意写的库后运行 `npm test`，`test/store.test.ts` 的 MySQL 契约用例会真正执行（否则自动跳过）。预览仅使用公开曲库和演示成绩，生成 `B50_DATA_DIR/previews/` 下的预览图，不会写入玩家数据库。

迁移服务的 `server/dist/` 也需要同步并重启（本仓库只包含 Bot）。已导入的旧账户若没有姓名框编号，需要重新扫码导入一次。二维码链接在 bot 内转换为标准文本，输入格式也兼容旧迁移服务；旧服务仍只支持串行读取。

## 配置

| 变量 | 说明 |
|---|---|
| DISCORD_TOKEN / DISCORD_APP_ID | 必填：机器人凭据 |
| DISCORD_GUILD_ID | 开发期建议填写，Guild 命令立即生效；为空注册全局命令 |
| MIGRATE_URL / MIGRATE_API_KEY | :8788 服务地址与配套 x-api-key |
| ALLOWED_USER_IDS | 逗号或空格分隔白名单；空值允许所有人 |
| EPHEMERAL | 默认 true，控制导出回复；成绩图与帮助公开，upload / 绑定始终私密 |
| CALL_TIMEOUT_MS | 迁移服务总超时，默认 240000 |
| COOLDOWN_SECONDS | 每用户新扫码冷却，默认 30；不限制本地查图 / 帮助 / 重复二维码 |
| PULL_CONCURRENCY / MAX_PENDING_READS | Bot 机台读取并发默认 3 / 总待处理默认 9；与服务端并发配置协调 |
| MAX_ATTACHMENT_MB | 导出附件阈值，默认 7MB，超限压缩 / 分片 |
| MYSQL_URL 或 MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD | 玩家数据库；`MYSQL_URL` 优先 |
| MYSQL_POOL_SIZE | 连接池上限，默认 5（2–10） |
| REDIS_URL | 扫码去重 / 冷却 / 令牌缓存，默认 `redis://127.0.0.1:6379/0` |
| B50_DATA_DIR | 渲染缓存与日志目录，默认 `<项目>/.data` |
| B50_AUTH_KEY / B50_AUTH_KEY_FILE | 远程服凭据加密密钥（32 字节 Base64 或密钥文件）；务必单独备份 |
| DF_CLIENT_ID / DF_CLIENT_SECRET | 水鱼 OAuth 应用凭据 |
| DF_AUTH_URL / DF_SCOPE | 默认水鱼鉴权地址；scope 默认 prober.records.read prober.records.write |
| LX_DEV_TOKEN / LX_API_BASE | 落雪开发者密钥；默认 https://maimai.lxns.net |
| LX_CLIENT_ID / LX_CLIENT_SECRET / LX_REDIRECT_URI | 落雪 OAuth 应用与回调配置 |
| B50_NEW_VERSION | 当前内容系列默认 25500，国服 ROM 1.56.00 |

服务端 `MIGRATE_CONCURRENCY` 配置在 `server/.env` 或其进程环境，默认 3。首次上线仍需真实多人扫码验收上游机台行为；自动测试使用模拟请求，不消耗真实二维码。

## 素材与许可

`assets/maimaiDX/` 为参考项目实际绘图素材与曲绘；项目 MIT 许可见 `assets/maimaiDX/LICENSE`，图片内保留设计者署名。EasyMai 许可见 `assets/EasyMai-LICENSE.txt`。原始下载和参考源码保留在 `reference/`，不参与运行。曲绘和游戏素材的权利仍归原作者及各版权方。

NET 地区曲库来源为 [gekichumai/dxrating](https://github.com/gekichumai/dxrating)，固定提交见 `assets/data/dxdata-source.json`，MIT 许可见 `assets/data/dxrating-LICENSE`。封面 hash 的公开 URL 取自该提交的 SongHeader 实现。
