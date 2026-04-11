// main.js
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// --- 关键修复：补全丢失的 WebRTC 配置 ---
const configuration = {
    'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]
};

const roomID = "888"; 
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = window.location.host; 
const ws = new WebSocket(`${protocol}//${host}/ws/${roomID}`);

let peerConnection;
let localStream;

// 1. 页面加载就先请求摄像头，不要等 WebSocket
async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("✅ 摄像头已就绪");
    } catch (e) {
        alert("无法访问摄像头，请确保使用 HTTPS 访问并开启权限：" + e);
    }
}

init();

// 2. 当 WebSocket 连接上后再处理 P2P 逻辑
ws.onopen = () => {
    console.log("✅ 成功连接到信令服务器！");
    startConnect();
};

async function startConnect() {
    peerConnection = new RTCPeerConnection(configuration);

    // 添加本地流到通道
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    peerConnection.ontrack = event => {
        console.log("🎉 收到对方视频流");
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onnegotiationneeded = async () => {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
    };
}

// 3. 处理信令消息
ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.offer) {
        if (!peerConnection) await startConnect();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ 'answer': peerConnection.localDescription }));
    } else if (message.answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    } else if (message.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) { console.error(e); }
    }
};