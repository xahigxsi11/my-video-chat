from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles # 修复点 1：必须导入这个
import uvicorn
import os

app = FastAPI()

# 1. 首页路由
@app.get("/")
async def get_index():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"error": "index.html not found"}

# 2. JavaScript 脚本路由
@app.get("/main.js")
async def get_js():
    if os.path.exists("main.js"):
        return FileResponse("main.js", media_type="application/javascript")
    return {"error": "main.js not found"}

# 3. 关键修复点 2：为 4 张纪念照片添加路由
# 这样你在 HTML 里写的 src="p1.jpg" 才能被服务器找到
@app.get("/{image_name}")
async def get_image(image_name: str):
    # 如果请求的是以 .jpg 结尾的文件，就尝试发送它
    if image_name.endswith(".jpg") and os.path.exists(image_name):
        return FileResponse(image_name)
    return {"error": "image not found"}

# --- WebSocket 逻辑 ---
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
    # Render 会通过环境变量提供端口
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)