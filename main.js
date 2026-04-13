/**
 * 针对 Render 部署优化的 WebRTC 脚本
 */

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
// 增加保护：如果 HTML 里没这个 ID，代码也不会报错
const remotePlaceholder = document.getElementById('remotePlaceholder');

const muteBtn = document.getElementById('muteBtn');
const videoBtn = document.getElementById('videoBtn');
const hangupBtn = document.getElementById('hangupBtn');

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// --- 增强版 STUN 配置 ---
const configuration = {
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
        {'urls': 'stun:stun2.l.google.com:19302'},
        {'urls': 'stun:stun3.l.google.com:19302'},
        {'urls': 'stun:stun.stunprotocol.org:3478'}
    ]
};

const roomID = "888"; 
let peerConnection;
let localStream;
let ws;

let isMuted = false;
let isVideoOff = false;

// 1. 启动程序
async function startApp() {
    try {
        console.log("🚀 正在初始化媒体设备...");
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("✅ 摄像头/麦克风已就绪");
        
        connectWebSocket();
        setupEventListeners();
    } catch (e) {
        console.error("❌ 媒体设备初始化失败:", e);
        alert("无法访问摄像头。Render 要求必须使用 https:// 访问，请检查地址栏。");
    }
}

// 2. 建立 WebSocket (针对 Render 域名适配)
function connectWebSocket() {
    // 自动识别 Render 的 wss:// 协议
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomID}`;
    
    console.log(`正在连接信令服务器: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("✅ 信令服务器已连接");
        // 稍微延迟 500ms 发送 join，给服务器一点反应时间
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 'type': 'join' }));
            }
        }, 500);
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'chat') {
            appendMessage('peer', message.content);
        } else {
            handleSignalingMessage(message);
        }
    };

    ws.onclose = () => {
        console.warn("⚠️ 信令服务器断开，正在尝试重连...");
        setTimeout(connectWebSocket, 3000);
    };
}

// 3. 信令处理逻辑
async function handleSignalingMessage(message) {
    try {
        if (message.type === 'join') {
            console.log("👤 对方已进入房间，我正在发起呼叫...");
            await makeCall();
        } 
        else if (message.offer) {
            console.log("📥 收到 Offer，准备回应...");
            if (!peerConnection) createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify({ 'answer': peerConnection.localDescription }));
        } 
        else if (message.answer) {
            console.log("📥 收到 Answer，正在连接...");
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
        } 
        else if (message.candidate) {
            if (peerConnection) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
            }
        }
    } catch (e) {
        console.error("❌ 信令处理出错:", e);
    }
}

// 4. P2P 连接逻辑
function createPeerConnection() {
    if (peerConnection) return;
    
    console.log("🏗️ 正在创建 P2P 连接通道...");
    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    peerConnection.ontrack = event => {
        console.log("🎉 核心时刻：收到对方视频流！");
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            // 保护性代码：检查元素是否存在再隐藏
            if (remotePlaceholder) remotePlaceholder.style.display = 'none';
        }
    };

    // 监控连接状态
    peerConnection.onconnectionstatechange = () => {
        console.log("📡 当前连接状态:", peerConnection.connectionState);
        if (peerConnection.connectionState === 'failed') {
            console.error("❌ P2P 连接失败，尝试重新发起呼叫...");
            // 如果失败了，可以尝试重新 call 一次
        }
    };
}

async function makeCall() {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
}

// 5. 其他功能 (聊天、按钮) 保持不变
function setupEventListeners() {
    muteBtn.onclick = () => {
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
        muteBtn.innerText = isMuted ? "Unmute" : "Mute";
        muteBtn.style.background = isMuted ? "#57606f" : "rgba(255, 255, 255, 0.1)";
    };

    videoBtn.onclick = () => {
        isVideoOff = !isVideoOff;
        localStream.getVideoTracks().forEach(track => track.enabled = !isVideoOff);
        videoBtn.innerText = isVideoOff ? "Video On" : "Video Off";
        videoBtn.style.background = isVideoOff ? "#57606f" : "rgba(255, 255, 255, 0.1)";
    };

    hangupBtn.onclick = () => {
        if (confirm("确定要结束通话吗？")) {
            if (peerConnection) peerConnection.close();
            if (ws) ws.close();
            localStream.getTracks().forEach(track => track.stop());
            window.location.reload(); 
        }
    };

    const performSend = () => {
        const text = chatInput.value.trim();
        if (text && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat', content: text }));
            appendMessage('me', text);
            chatInput.value = '';
        }
    };

    sendBtn.onclick = performSend;
    chatInput.onkeydown = (e) => { if (e.key === 'Enter') performSend(); };
}

function appendMessage(sender, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${sender === 'me' ? 'msg-me' : 'msg-peer'}`;
    msgDiv.innerText = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

startApp();