from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
import os
import json
import logging

app = FastAPI()
logging.basicConfig(level=logging.INFO)

BASE_DIR = Path(__file__).resolve().parent
ROOM_SECRET = os.environ.get("ROOM_SECRET", "").strip()

# 你的 TURN 配置建议放在 Render 的 Environment Variables 里：
# TURN_URLS=turn:your-domain.com:3478?transport=udp,turn:your-domain.com:3478?transport=tcp,turns:your-domain.com:5349?transport=tcp
# TURN_USERNAME=your_username
# TURN_CREDENTIAL=your_password
TURN_URLS = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
TURN_USERNAME = os.environ.get("TURN_USERNAME", "").strip()
TURN_CREDENTIAL = os.environ.get("TURN_CREDENTIAL", "").strip()

# room_id -> list[WebSocket]
rooms: dict[str, list[WebSocket]] = {}


@app.get("/")
async def get_index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/main.js")
async def get_js():
    return FileResponse(BASE_DIR / "main.js", media_type="application/javascript")


@app.get("/config")
async def get_config():
    """
    前端启动时读取 ICE 配置。
    注意：WebRTC TURN 的 username/credential 会暴露给浏览器，这是正常现象。
    更安全的做法是以后改成短期临时 TURN credentials。
    """
    ice_servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]

    if TURN_URLS and TURN_USERNAME and TURN_CREDENTIAL:
        ice_servers.append({
            "urls": TURN_URLS,
            "username": TURN_USERNAME,
            "credential": TURN_CREDENTIAL,
        })

    return JSONResponse({
        "iceServers": ice_servers,
        "hasTurn": bool(TURN_URLS and TURN_USERNAME and TURN_CREDENTIAL),
        "roomSecretEnabled": bool(ROOM_SECRET),
    })


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/{file_path:path}")
async def get_static_file(file_path: str):
    """
    只允许读取当前目录下真实存在的普通文件，避免 ../ 路径穿越。
    """
    requested = (BASE_DIR / file_path).resolve()

    if not str(requested).startswith(str(BASE_DIR)):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    if requested.exists() and requested.is_file():
        return FileResponse(requested)

    return JSONResponse({"error": "file not found"}, status_code=404)


async def safe_send(ws: WebSocket, payload: dict | str) -> bool:
    try:
        if isinstance(payload, str):
            await ws.send_text(payload)
        else:
            await ws.send_text(json.dumps(payload))
        return True
    except Exception as e:
        logging.warning("Failed to send websocket message: %s", e)
        return False


async def remove_socket(room_id: str, websocket: WebSocket):
    room = rooms.get(room_id)
    if not room:
        return

    if websocket in room:
        room.remove(websocket)

    # 通知剩下的人：对方离开了
    for client in list(room):
        ok = await safe_send(client, {"type": "peer-left"})
        if not ok and client in room:
            room.remove(client)

    if not room:
        rooms.pop(room_id, None)


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    """
    只做信令转发，不承载音视频流。
    音视频仍然走 WebRTC：直连成功则 P2P，失败则走 TURN 中继。
    """
    await websocket.accept()

    # 如果你在 Render 环境变量里设置了 ROOM_SECRET，则 URL 必须带 ?token=xxx
    # 没设置 ROOM_SECRET 时不强制校验，方便你本地测试。
    if ROOM_SECRET:
        token = websocket.query_params.get("token", "")
        if token != ROOM_SECRET:
            await safe_send(websocket, {"type": "auth-failed"})
            await websocket.close(code=1008)
            return

    room = rooms.setdefault(room_id, [])

    # 清掉已经失效但没被移除的连接
    alive_room = []
    for client in list(room):
        ok = await safe_send(client, {"type": "server-ping"})
        if ok:
            alive_room.append(client)
    rooms[room_id] = room = alive_room

    if len(room) >= 2:
        await safe_send(websocket, {"type": "room-full"})
        await websocket.close(code=1008)
        return

    room.append(websocket)
    role = "caller" if len(room) == 1 else "callee"

    await safe_send(websocket, {
        "type": "joined",
        "role": role,
        "peers": len(room),
    })

    # 第二个人进入时，通知第一个人可以开始创建 offer
    if len(room) == 2:
        for client in list(room):
            if client is not websocket:
                await safe_send(client, {"type": "peer-joined"})

    logging.info("WebSocket joined room=%s peers=%s role=%s", room_id, len(room), role)

    try:
        while True:
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                await safe_send(websocket, {"type": "bad-message"})
                continue

            # 客户端心跳，保持 Render WebSocket 活跃，也便于识别连接状态
            if message.get("type") == "ping":
                await safe_send(websocket, {"type": "pong"})
                continue

            # 转发给房间里的另一个人
            dead_clients = []
            for client in list(rooms.get(room_id, [])):
                if client is websocket:
                    continue

                ok = await safe_send(client, message)
                if not ok:
                    dead_clients.append(client)

            for client in dead_clients:
                if client in rooms.get(room_id, []):
                    rooms[room_id].remove(client)

    except WebSocketDisconnect:
        logging.info("WebSocket disconnected room=%s", room_id)
    except Exception as e:
        logging.exception("WebSocket error room=%s: %s", room_id, e)
    finally:
        await remove_socket(room_id, websocket)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
