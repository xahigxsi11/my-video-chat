from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles # 新增：用于自动处理文件
import uvicorn
import os

app = FastAPI()

# --- 关键改进：自动处理所有静态文件 ---
# 这行代码会自动把当前文件夹下的 index.html, main.js 等发给浏览器
# 不再需要手动写 open("main.js") 了
@app.get("/")
async def get_index():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

# 如果你还有其他的 .js 或 .css 文件，FastAPI 会自动处理
# ---------------------------------------

rooms = {}

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    if room_id not in rooms:
        rooms[room_id] = []
    
    # 限制每个房间最多2人
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
        if websocket in rooms[room_id]:
            rooms[room_id].remove(websocket)
        print(f"用户离开房间 {room_id}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)