// 获取 DOM 元素
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
// 兼容性处理：防止没有 placeholder 元素时代码崩溃
const remotePlaceholder = document.getElementById('remotePlaceholder');

// WebRTC 配置
const configuration = {
    'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]
};

const roomID = "888"; 
let peerConnection;
let localStream;
let ws;

// 1. 第一步：先启动摄像头
async function startApp() {
    try {
        console.log("正在请求摄像头权限...");
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("✅ 摄像头已就绪，开始连接服务器...");
        
        // 只有摄像头成功了，才执行第二步：连接 WebSocket
        connectWebSocket();
    } catch (e) {
        console.error("摄像头启动失败:", e);
        alert("无法访问摄像头！请确保：\n1. 使用了 HTTPS 访问\n2. 点击了‘允许’权限\n3. 没有其他程序占用摄像头");
    }
}

// 2. 第二步：连接信令服务器
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomID}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("✅ 已成功连接到信令服务器");
        // 告诉对方我进来了
        ws.send(JSON.stringify({ 'type': 'join' }));
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        handleSignalingMessage(message);
    };

    ws.onerror = (err) => console.error("WebSocket 错误:", err);
}

// 3. 第三步：处理 P2P 协商
async function handleSignalingMessage(message) {
    // 如果收到新成员加入的消息，我作为发起者
    if (message.type === 'join') {
        console.log("👤 发现新伙伴，我发起呼叫...");
        await makeCall();
    } 
    // 处理 Offer
    else if (message.offer) {
        console.log("📥 收到视频邀请");
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ 'answer': peerConnection.localDescription }));
    } 
    // 处理 Answer
    else if (message.answer) {
        console.log("📥 对方接受了邀请");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    } 
    // 处理网络候选人
    else if (message.candidate) {
        try {
            if (!peerConnection) createPeerConnection();
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) {
            console.error("ICE 候选人添加失败", e);
        }
    }
}

// 创建 P2P 连接实例
function createPeerConnection() {
    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(configuration);

    // 把自己的画面塞进通道
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // 找到网络路径时发送给对方
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    // 收到对方画面时显示
    peerConnection.ontrack = event => {
        console.log("🎉 收到对方视频流！");
        if (remotePlaceholder) remotePlaceholder.style.display = 'none';
        remoteVideo.style.display = 'block';
        remoteVideo.srcObject = event.streams[0];
    };
}

// 发起呼叫的逻辑
async function makeCall() {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
}

// 启动程序
startApp();