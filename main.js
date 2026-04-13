/**
 * 属于惊喜和金毛的 WebRTC + 实时聊天脚本
 */

// --- 1. 获取 DOM 元素 ---
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remotePlaceholder = document.getElementById('remotePlaceholder');

// 按钮控制
const muteBtn = document.getElementById('muteBtn');
const videoBtn = document.getElementById('videoBtn');
const hangupBtn = document.getElementById('hangupBtn');

// 聊天相关
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// --- 2. 配置与全局变量 ---
const configuration = {
    'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]
};

const roomID = "888"; 
let peerConnection;
let localStream;
let ws;

// 状态追踪
let isMuted = false;
let isVideoOff = false;

// --- 3. 核心启动流程 ---
async function startApp() {
    try {
        console.log("正在请求摄像头权限...");
        // 获取本地音视频流
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("✅ 摄像头已就绪");
        
        // 连接信令服务器
        connectWebSocket();
        // 初始化按钮点击事件
        setupEventListeners();
    } catch (e) {
        console.error("摄像头启动失败:", e);
        alert("无法访问摄像头！请确保：\n1. 使用 HTTPS 或 localhost 访问\n2. 已授予权限");
    }
}

// --- 4. WebSocket 通信逻辑 ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomID}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("✅ 已连接到信令服务器");
        ws.send(JSON.stringify({ 'type': 'join' }));
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        
        // 分流处理：是聊天消息还是 WebRTC 信令？
        if (message.type === 'chat') {
            appendMessage('peer', message.content);
        } else {
            handleSignalingMessage(message);
        }
    };

    ws.onerror = (err) => console.error("WebSocket 错误:", err);
}

// --- 5. WebRTC 信令处理 ---
async function handleSignalingMessage(message) {
    if (message.type === 'join') {
        console.log("👤 发现新伙伴，发起呼叫...");
        await makeCall();
    } 
    else if (message.offer) {
        console.log("📥 收到视频邀请");
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ 'answer': peerConnection.localDescription }));
    } 
    else if (message.answer) {
        console.log("📥 对方接受了邀请");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    } 
    else if (message.candidate) {
        if (!peerConnection) createPeerConnection();
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) {
            console.error("ICE 候选人添加失败", e);
        }
    }
}

// --- 6. P2P 连接逻辑 ---
function createPeerConnection() {
    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(configuration);

    // 将本地媒体轨道添加到连接中
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // 发现网络路径（Candidate）并发送给对方
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    // 当收到对方视频流时展示
    peerConnection.ontrack = event => {
        console.log("🎉 收到对方视频流！");
        if (remotePlaceholder) remotePlaceholder.style.display = 'none';
        remoteVideo.srcObject = event.streams[0];
    };
}

async function makeCall() {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
}

// --- 7. UI 事件监听（按钮与聊天） ---
function setupEventListeners() {
    // 静音控制
    muteBtn.onclick = () => {
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
        muteBtn.innerText = isMuted ? "Unmute" : "Mute";
        muteBtn.style.background = isMuted ? "#57606f" : "rgba(255, 255, 255, 0.1)";
    };

    // 视频控制
    videoBtn.onclick = () => {
        isVideoOff = !isVideoOff;
        localStream.getVideoTracks().forEach(track => track.enabled = !isVideoOff);
        videoBtn.innerText = isVideoOff ? "Video On" : "Video Off";
        videoBtn.style.background = isVideoOff ? "#57606f" : "rgba(255, 255, 255, 0.1)";
    };

    // 挂断通话
    hangupBtn.onclick = () => {
        if (confirm("确定要结束通话吗？")) {
            if (peerConnection) peerConnection.close();
            if (ws) {
                ws.send(JSON.stringify({ type: 'leave' }));
                ws.close();
            }
            localStream.getTracks().forEach(track => track.stop());
            alert("通话已结束");
            window.location.reload(); 
        }
    };

    // 发送聊天消息
    const performSend = () => {
        const text = chatInput.value.trim();
        if (text && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat', content: text }));
            appendMessage('me', text);
            chatInput.value = '';
        }
    };

    sendBtn.onclick = performSend;
    
    // 支持按回车键发送消息
    chatInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            performSend();
        }
    };
}

// --- 8. 聊天 UI 渲染 ---
function appendMessage(sender, text) {
    const msgDiv = document.createElement('div');
    // 根据发送者设置不同样式（me 或 peer）
    msgDiv.className = `msg ${sender === 'me' ? 'msg-me' : 'msg-peer'}`;
    msgDiv.innerText = text;
    chatMessages.appendChild(msgDiv);
    
    // 自动滚动到最新消息底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 启动
startApp();