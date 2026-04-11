// main.js
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remotePlaceholder = document.getElementById('remotePlaceholder');
// --- 关键修复：补全丢失的 WebRTC 配置 ---
const configuration = {
    'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]
};

const roomID = "888"; 
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

const ws = new WebSocket(`${protocol}//${host}/ws/${roomID}`);

let peerConnection;
let localStream;

async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("✅ 摄像头已就绪");
    } catch (e) {
        alert("请确保使用 HTTPS 访问并允许摄像头权限！");
    }
}

init();

// 2. 创建 P2P 连接的核心函数
function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    peerConnection.ontrack = event => {
        console.log("🎉 收到对方视频流");
        if (remotePlaceholder) remotePlaceholder.style.display = 'none';
        remoteVideo.style.display = 'block';
        remoteVideo.srcObject = event.streams[0];
    };
}

// 3. 处理 WebSocket 信令
ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);

    if (message.offer) {
        console.log("📥 收到 Offer，准备创建 Answer");
        if (!peerConnection) createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ 'answer': peerConnection.localDescription }));

    } else if (message.answer) {
        console.log("📥 收到 Answer，连接即将建立");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));

    } else if (message.candidate) {
        console.log("📥 收到 ICE 候选人");
        try {
            if (!peerConnection) createPeerConnection();
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) { console.error("添加候选人失败", e); }
    }
};

// --- 关键改进：由“后来者”发起连接 ---
ws.onopen = () => {
    console.log("✅ 已连接服务器");
    // 发送一个打招呼的消息，告诉对方“我来了”
    ws.send(JSON.stringify({ 'type': 'join' }));
};

// 监听“join”消息：如果有人加入了，我就发起 Offer
ws.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'join') {
        console.log("👤 有新伙伴加入了，我来发起呼叫 (Offer)");
        createPeerConnection();
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
    }
});