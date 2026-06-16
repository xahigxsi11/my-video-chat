# 部署说明

## Render 部署

本项目通过 Render Free Web Service 运行。Render 自动从 GitHub 仓库部署。

### 环境变量设置

在 Render Dashboard → Environment 中设置以下变量：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `ROOM_SECRET` | 房间访问密钥（可选，不设则不校验） | `my-secret-2024` |
| `TURN_URLS` | TURN 服务器 URL，多个用英文逗号分隔 | `turn:free.expressturn.com:3478?transport=tcp,turn:free.expressturn.com:3478?transport=udp` |
| `TURN_USERNAME` | TURN 用户名 | `expressuser123` |
| `TURN_CREDENTIAL` | TURN 密码 | `your-password-here` |
| `PORT` | 端口（Render 自动设置，通常不需要手动设） | `8000` |

### 推荐的 TURN 配置

**免费 ExpressTURN（可能不稳定）：**
```
TURN_URLS=turn:free.expressturn.com:3478?transport=tcp,turn:free.expressturn.com:3478?transport=udp
TURN_USERNAME=（ExpressTURN 提供的用户名）
TURN_CREDENTIAL=（ExpressTURN 提供的密码）
```

**自建 coturn（更稳定，推荐）：**
```
TURN_URLS=turn:your-domain.com:3478?transport=tcp,turns:your-domain.com:443?transport=tcp
TURN_USERNAME=（coturn 配置的用户名）
TURN_CREDENTIAL=（coturn 配置的密码）
```

### 部署步骤

1. 推送代码到 GitHub 仓库
2. Render 自动检测更新并重新部署
3. 部署完成后访问 `https://你的服务.onrender.com/?room=888&token=你的密钥`

## 调试参数

在 URL 中添加以下参数进行调试：

| 参数 | 作用 |
|------|------|
| `?debug=webrtc` | 在 Console 输出详细的 WebRTC 诊断日志 |
| `?forceRelay=1` | 强制所有流量走 TURN relay（`iceTransportPolicy: "relay"`） |
| `?turnTcpOnly=1` | 只保留 TCP/TLS 协议的 TURN URL |

示例：
```
https://你的服务.onrender.com/?room=888&token=xxx&debug=webrtc
https://你的服务.onrender.com/?room=888&token=xxx&debug=webrtc&forceRelay=1
```

## 验证步骤

1. 打开 Chrome，访问你的 Render 地址（带 `?debug=webrtc`）
2. 按 F12 打开 Console
3. 用另一个浏览器 / 设备 / 隐身窗口打开同一地址
4. 观察 Console 日志：
   - `[webrtc:ice] connection state: checking` → connecting → connected
   - `=== Selected ICE candidate pair ===` 出现且状态为 succeeded
   - `[webrtc:stats] inbound-video` 的 framesDecoded > 0
5. 如果看到 `走 relay=true`，说明在走 TURN 中继
6. 如果看到 `走 host=true`，说明 P2P 直连成功

## 判断网络连通性

- **两个设备在同一局域网**：host 或 srflx 应该能连通
- **两个设备在不同网络**：需要 srflx (STUN) 或 relay (TURN)
- **移动网络 / 企业防火墙 / 对称 NAT**：通常只能 relay (TURN)

如果 Console 显示：
- 有 relay candidate、ICE state 一直 checking → TURN 服务器可能不可达或被防火墙拦截
- 只有 host/srflx、没有 relay → TURN 配置有问题，检查环境变量
- selected pair 出现但 bytesReceived 长期为 0 → 媒体流被拦截

## 自建 coturn 最小方案

如果免费 ExpressTURN 不稳定，建议自建 coturn：

### VPS 上安装 coturn

```bash
# Ubuntu/Debian
sudo apt install coturn

# 编辑 /etc/turnserver.conf
listening-port=3478
tls-listening-port=443
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=你的密钥
realm=你的域名
server-name=你的域名
cert=/etc/letsencrypt/live/你的域名/fullchain.pem
pkey=/etc/letsencrypt/live/你的域名/privkey.pem
```

### 防火墙开放端口

```
3478/tcp + udp  (TURN)
443/tcp + udp   (TURNS)
49152-65535/udp (TURN relay ports)
```

### 测试 TURN 是否可用

用 Trickle ICE 测试页面：https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

填入你的 TURN 服务器信息，点 "Add Server" → "Gather candidates"，看是否能拿到 relay 类型的 candidate。
