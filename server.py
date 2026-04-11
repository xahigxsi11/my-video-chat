from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse # 专门用于发送文件的工具
import uvicorn
import os

app = FastAPI()
app.mount("/static", StaticFiles(directory="."), name="static")
# 1. 访问首页时发送 index.html
@app.get("/")
async def get_index():
    # 检查当前目录下是否有这个文件
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"error": "index.html not found in root"}

# 2. 浏览器请求 main.js 时发送该文件
@app.get("/main.js")
async def get_js():
    # 检查当前目录下是否有这个文件
    if os.path.exists("main.js"):
        return FileResponse("main.js", media_type="application/javascript")
    # 如果没找到，返回一个更具体的错误
    return {"error": "main.js not found in root. Please check your GitHub file list."}

# --- WebSocket 逻辑保持不变 ---
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
    try:
        while True:
            data = await websocket.receive_text()
            for client in rooms[room_id]:
                if client != websocket:
                    await client.send_text(data)
    except WebSocketDisconnect:
        if websocket in rooms[room_id]:
            rooms[room_id].remove(websocket)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)