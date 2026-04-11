from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, Response
import uvicorn
import os

app = FastAPI()

# 1. 把 index.html 发送给浏览器
@app.get("/")
async def get_html():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

# 2. 把 main.js 发送给浏览器
@app.get("/main.js")
async def get_js():
    with open("main.js", "r", encoding="utf-8") as f:
        return Response(content=f.read(), media_type="application/javascript")

# 3. 红娘服务 (和之前一模一样)
rooms = {}

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    if room_id not in rooms:
        rooms[room_id] = []
    if len(rooms[room_id]) >= 2:
        await websocket.close()
        return
    rooms[room_id].append(websocket)
    print(f"用户加入房间 {room_id}")
    try:
        while True:
            data = await websocket.receive_text()
            for client in rooms[room_id]:
                if client != websocket:
                    await client.send_text(data)
    except WebSocketDisconnect:
        rooms[room_id].remove(websocket)
        print(f"用户离开房间 {room_id}")

if __name__ == "__main__":
    # 云服务器会自动分配 PORT 环境变量，默认使用 8000
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)