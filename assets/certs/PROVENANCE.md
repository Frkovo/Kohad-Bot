# maimai NET 中间证书（公开数据）

`maimai-net-intermediates.pem` 含两张公开中间 CA 证书，仅用于 Bot 对 maimaidx.jp / maimaidx-eng.com / 国际服网关的 NET 请求（见 `src/multiserver/transport.ts`）。

- 来源：gekichumai/dxrating，commit `301fed158b621b060de2e3460f544fd7634959f7`，文件 `apps/backend/src/lib/functions/client.ts`，导出 `MAIMAI_NET_INTERMEDIATE_CERTIFICATES`。
  - 原始 URL：https://raw.githubusercontent.com/gekichumai/dxrating/301fed158b621b060de2e3460f544fd7634959f7/apps/backend/src/lib/functions/client.ts
- 原项目许可与归属见 `assets/data/dxrating-LICENSE`。
- 证书（按 PEM 顺序）：
  1. GlobalSign RSA OV SSL CA 2018，有效期 2018-11-21 至 2028-11-21，SHA-256 `B6:76:FF:A3:17:9E:88:12:09:3A:1B:5E:AF:EE:87:6A:E7:A6:AA:F2:31:07:8D:AD:1B:FB:21:CD:28:93:76:4A`
  2. GlobalSign GCC R46 OV TLS CA 2025，有效期 2025-09-17 至 2029-06-23，SHA-256 `D1:60:E2:DE:4E:56:CB:10:B6:6C:1C:B0:AD:CB:79:CF:93:C7:8D:CD:9D:B3:0C:20:18:22:02:62:C0:40:63:F9`
- 校验：两张证书 `basicConstraints CA=true`；颁发者与 Node 内置根证书（`tls.rootCertificates`）匹配且签名验证通过；指纹与上表一致。
- 使用策略：
  - 证书只添加到 NET 专用 undici Agent 的 `connect.ca`，与 Node 默认根证书合并，不改变系统信任库，不设置全局 dispatcher。
  - 不设置 `rejectUnauthorized: false`，不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不在用户登录过程中动态下载或信任任何证书。
  - 更新证书须人工重新核对上述来源、指纹和有效期，并同步更新本文件与测试中的指纹常量。
