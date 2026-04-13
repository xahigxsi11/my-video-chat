from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import os

app = FastAPI()

# --- 路由设置 ---

# 1. 首页
@app.get("/")
async def get_index():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"error": "index.html not found"}

# 2. JavaScript 脚本
@app.get("/main.js")
async def get_js():
    if os.path.exists("main.js"):
        return FileResponse("main.js", media_type="application/javascript")
    return {"error": "main.js not found"}

# 3. 更加通用的静态文件处理（替代之前的 get_image）
# 如果你的图片和代码在同一个文件夹，这样写最保险
# 它会自动处理 .jpg, .png, .css 等所有文件
@app.get("/{file_path:path}")
async def get_static_files(file_path: str):
    if os.path.exists(file_path):
        return FileResponse(file_path)
    return {"error": "File not found"}

# --- WebSocket 转发逻辑（支持视频信令和文字聊天） ---
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
            # 这里的 data 可能是 WebRTC 的 Offer/Answer，也可能是聊天 JSON
            data = await websocket.receive_text()
            for client in rooms[room_id]:
                if client != websocket:
                    # 转发给房间里的另一个人
                    await client.send_text(data)
    except WebSocketDisconnect:
        if websocket in rooms[room_id]:
            rooms[room_id].remove(websocket)
            # 如果房间空了，清理掉房间
            if not rooms[room_id]:
                del rooms[room_id]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)