# 多服务器 B50 与 Discord 内登录

2026-10-08。源码已实现；未用真实 SEGA 账号或私服卡片验证登录，也未启动 Bot 注册新命令。自动测试使用模拟网站和临时数据库。

**当前版本只启用 cn / jp / intl；MuNET 和 Missless 暂时旁路。** 两项从所有服务器菜单移除，旧命令、按钮、弹窗、查询及同步请求都会在访问接口前被拒绝。即使配置了私服接口也不会启用。旧私服默认值在读取时回退 cn，原偏好记录、绑定凭据和快照保留。

新增处理全部在 discord-bot 进程：SEGA 登录、加密存储、NET 同步、B50 计算与绘图。国服扫码仍调用原有 :8788 迁移服务；本次没有修改或部署远端服务。

玩家在手机或桌面 Discord 中执行命令、填写弹窗、选择卡片并确认绑定。流程不要求打开网页、复制 Cookie、安装插件或使用书签脚本。Bot 后台的 HTTP 请求不属于玩家交互。

## 可用范围

| 服务器 | B50 路径 | 拟合 B50 / nb50 | PC50 | 当前验证边界 |
|---|---|---|---|---|
| cn | 保留扫码、本地、水鱼和落雪 | 保留水鱼拟合定数计算 | 保留本地累计次数，含宴谱 | 原有自动测试继续通过 |
| jp | JP 表单登录 → 选卡 → 五个难度的 NET 成绩页 → 日服曲库计算 | 缺可靠地区拟合数据，明确拒绝 | NET 全曲最佳页缺完整累计次数，明确拒绝 | 模拟测试通过；待真实账号验证 |
| intl | Gateway 登录与 302/Cookie 链 → 选卡 → NET 成绩页 → 国际服曲库计算 | 同上 | 同上 | 同上 |
| mumur | 已旁路；适配代码保留 | 不开放 | 不开放 | 后续接入延期 |
| missless | 已旁路；适配代码保留 | 不开放 | 不开放 | 后续接入延期 |

当前只提供三服选择。私服的通用适配契约仅保留为后续开发资料，不作为当前产品入口，不要求玩家打开浏览器或填写私服凭据。

公开的 Missless 登录页提供 /discord/login。Discord Bot 收到某人的命令，不能因此获得此人在 Missless 网站上的登录 Cookie。网页 OAuth 不能直接满足 DC-only 要求；需要站点提供可信 Bot 的只读接入，或核对该服确实接受的卡片认证与游戏 API。已观察到的网页成绩和 Play Count 只说明数据存在，不能证明 Bot 已有读取权限。

## 玩家命令

```text
/server server:intl
/bind
→ 私人弹窗填写 SEGA ID 与密码
→ 私人菜单选择 Aime 卡片
→ 显示玩家名，点击确认绑定
→ 首次同步，后续可直接查询

/b50
/b50 server:jp
/b50 source:local
/b50 refresh:true
/b50 refresh:false
/sync
/unbind
```

- /server 不带参数查看个人默认服务器；带参数保存偏好，跨 Discord 群组生效。
- /bind、/sync、/unbind 和三个成绩图命令均使用“当次 server → 个人默认 → cn”的顺序。
- 成绩命令的 server 参数只改变当次查询，不改变默认值。
- /bind server:cn 与 /sync server:cn 打开二维码输入弹窗，导入仍走原有迁移服务。
- /upload、/getuserall、/tomunet 固定为国服扫码，不随个人默认服务器改变。/tomunet 仍是国服导出，与查询 MuNET 成绩的 server:mumur 不同。
- 国服二维码不能用于其他服；水鱼、落雪只作为国服来源，source:net 只用于日服／国际服。
- /bindlx 使用 Discord 的 15 位好友码弹窗。新的水鱼和落雪网页 OAuth 绑定入口已停用；已有绑定的查询、上传与续期代码保留。
- 成绩图和帮助图公开；默认服、绑定、选卡、同步、解绑和详细错误私密。后台同步的提供方错误不会原样写入日志。

Slash Command 的 choices 显示中文名称，当前内部值为 cn / jp / intl。

## NET 登录与同步

JP 获取登录表单 token，提交 segaId / password / save_cookie / token。国际服提交 Gateway 的 sid / password / retention 并跟随 302。Cookie 使用独立 CookieJar，按域、路径和有效期发送；登录跳转仅允许已确认的三个 SEGA/NET 主机，TLS 校验保留。

两种登录共用成绩解析和选卡交互，不共用登录表单。不会默认选择 idx=0。确认前的凭据仅在内存持有，10 分钟后过期；确认后加密保存账号、密码、Cookie、卡片索引及玩家名，用于后续同步。卡片列表索引可能变化，玩家名与确认时不一致时要求重新选卡；游戏内改名也会触发确认。此检查不等同于取得不可变卡片 ID。

Discord 原生 TextInput 没有密码遮罩功能（只有 Short / Paragraph 两种样式），密码输入框明确注明“不遮罩”。提交内容会经过 Discord；本地加密只保护 Bot 保存的数据。

JP / 国际服请求使用随 Bot 内置的两张公开中间证书（provenance 见 `assets/certs/PROVENANCE.md`），仅作用于 NET 专用 Agent；证书校验保持开启，不会关闭 TLS，也不会修改系统信任库。HTTP 状态错误（如 503）只显示状态码，不会触发重新登录。

失败时回复中的排查编号与 `.data/logs/bot-debug.jsonl` 中的 `id` 一致。日志只含阶段、状态码、耗时、计数和固定路由名，单文件 5 MB 后轮转为一个 `.1` 备份；`B50_DEBUG_LOG=off` 可关闭文件日志，或指定其他路径。所有回复文案来自根目录 `keys.json`，修改后需重启 Bot（不会自动重启）。详见 README“排障日志与文案”。

每次同步请求 genre=99&diff=0..4 的完整最佳成绩页，解析达成率、DX 分数、SD/DX 类型及 FC/FS 标记。宴谱不参与官方服 B50。读取任一页失败、维护、重定向到登录或页面结构异常时，不提交部分快照，不覆盖旧成绩。

NET 会话失效后尝试重新登录一次并选择原卡片。额外验证、验证码或站点结构变动会明确停止；当前没有实现额外验证交互。

远程服查询使用 15 分钟缓存：

- source:auto：新缓存直接绘图；缓存过期且仍绑定时尝试同步。自动同步失败可使用同账号上次缓存并显示提示。
- source:local 或 refresh:false：只查该服缓存。
- refresh:true 或 source:net：请求在线读取，失败时报告错误，不伪装刷新成功。
- 每个用户、每个服同步间隔至少 1 分钟，同一绑定的同时请求共用一次读取。
- 换绑／解绑会取消在途更新，并通过绑定 revision 再次拒绝旧请求的保存。显式刷新已解绑的账户会要求重新绑定。
- 自动更新由查询触发，当前没有定时轮询所有绑定账号。

## 曲库、Rating 与绘图

国服继续使用原有曲库和计算逻辑。日服／国际服使用 assets/data/dxdata.json，来源、固定提交和下载时间见 dxdata-source.json，许可见 dxrating-LICENSE。

按地区可用性、歌曲名、SD/DX 和难度寻找谱面；重复且有歧义的标题不随意匹配。每个谱面使用独立 key，不应用国服 +10000 编号规则。定数取所选版本的 multiver 值，并排除未来版本。CiRCLE 起 B15 使用当前及上一发行版本，B35 使用更早版本。

NET_JP_VERSION、NET_INTL_VERSION 可分别固定实际版本，名称必须匹配曲库；不填写时根据该地区标记为可用的谱面推断。该默认值来自曲库，不能替代真实机台版本核对。计算使用 DXRating 兼容的 NET 细分达成率倍率和 AP/AP+1 规则，与国服计算策略分开。

官方服曲绘使用 DXRating 的明确 SHA256 封面引用和公开 CDN，缓存按封面 hash 保存，不靠国服歌曲编号匹配。私服未提供经核对的曲绘映射时使用占位素材。图片显示服务器、计算版本和规则来源；缺失谱面数量在 Discord 摘要中提示。

## 存储与加密

原有 accounts / scores 保留为国服数据。增加同一 SQLite 中的 server_preferences / server_bindings / server_snapshots；远程绑定和快照主键包含 Discord user ID 与 server。

登录信息使用 AES-256-GCM，每次随机 IV；用户、服务器和绑定 revision 作为附加认证数据，防止密文在不同绑定间被替换。快照仅保存计算需要的字段，不保存原始 HTML、二维码或私服原始响应。绑定到另一账户时仅清除该用户该服旧快照，保留其他服的数据。

优先使用 B50_AUTH_KEY（32 字节的 Base64）；否则读取 B50_AUTH_KEY_FILE，未指定时首次绑定自动创建数据库同目录的 binding-master.key。发现已有加密凭据而原密钥文件缺失时，不自动生成替代密钥。

备份时停止 Bot 并复制 SQLite、WAL 所需文件及原密钥；密钥和 .data 不进入版本管理。移机必须保留原密钥。解绑逻辑删除当前凭据并保留成绩；历史备份和 SQLite 的历史页面不在此逻辑的物理擦除范围内。

## 私服适配接口契约（延期保留，当前不启用）

MUMUR_SCORE_ENDPOINT / MISSLESS_SCORE_ENDPOINT 是维护者设置的 HTTPS 只读适配服务地址。不能直接用首页代替接口。没有已验证的私服游戏地址、卡片认证、分页格式和本服曲库，当前不能完成真实 MuNET／Missless 读取。

Bot 发送以下 JSON；不做游戏协议 AES 加密。HTTPS 传输和本地凭据加密保留。可配置 *_ADAPTER_TOKEN，用于 Bot 到适配服务的管理员鉴权：

```http
POST <configured HTTPS endpoint>
Content-Type: application/json
Authorization: Bearer <adapter token, when configured>

{"accessCode":"<user-provided credential>"}
```

响应示例（演示值）：

```json
{
  "authenticated": true,
  "complete": true,
  "countsComplete": true,
  "version": "server-specific version",
  "account": {"id": "stable-provider-account-id", "name": "Player", "rating": 15000},
  "records": [{
    "title": "Song",
    "musicId": 123,
    "type": "DX",
    "level": 3,
    "achievement": 1005000,
    "dxScore": 2900,
    "maxDxScore": 3000,
    "fc": "app",
    "fs": "fsdp",
    "playCount": 17,
    "ds": 14.8,
    "version": 25,
    "isNew": true
  }]
}
```

适配服务必须验证卡片／凭据归属，只返回本人的完整最佳成绩，禁止注册新玩家、上传、登出其他机台或写回成绩。account.id 必须稳定。complete 只能在分页全部完成后为 true；countsComplete 只能在当前榜单支持范围内的所有谱面均有真实累计次数时为 true。当前契约支持普通五个难度的 SD/DX 谱面，不包含私服宴谱；不得把该范围外的次数称为全游戏完整 PC50。

达成率使用整数单位，100.5000% = 1005000。FC 为空 / fc / fcp / ap / app；FS 为空 / sync / fs / fsp / fsd / fsdp。ds、version、isNew 必须由本服经过核对的曲库和规则提供，不从国服猜定数。Bot 只保存白名单字段，失败或不完整响应保留旧快照。

维护者必须核对该服 Rating 规则并设置 MUMUR_RATING_POLICY / MISSLESS_RATING_POLICY 为 cn 或 net。支持独立新旧曲池，但暂不支持其他自定义单曲 Rating 公式。如果私服规则不同，需要先新增对应策略。

## 验证与启用

```powershell
npm install
npm run build
npm test
npm run preview:multiserver
```

预览只使用公开曲库与演示成绩，输出 .data/previews/intl-b50-preview.png 和 help-preview.png，不登录、不连接 Discord，也不写入玩家数据库。

Bot 启动后差量注册 13 个命令，所有 server 选项仅包含 cn / jp / intl。代码通过构建／模拟测试不代表真实登录和手机交互验收已完成。启用前需要真实 JP/国际服账号验证选卡与额外验证行为；两私服后续另行接入，配置接口地址不会绕过当前旁路。
