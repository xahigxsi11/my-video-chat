// 获取页面上的 video 标签
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// 1. 设置 WebSocket 牵线红娘的地址 (连接到我们刚才用 Python 写的 8080 端口)
const roomID = "888"; // 随便定一个房间号
const ws = new WebSocket(`ws://localhost:8080/ws/${roomID}`);

// 2. 配置 WebRTC，需要一个免费的公共 STUN 服务器来帮你穿透网络寻找对方
const configuration = {
    'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]
};
let peerConnection; // 这就是我们的 P2P 连接通道

// 当红娘（WebSocket）连接成功后，开始调用摄像头
ws.onopen = () => {
    console.log("✅ 成功连接到信令服务器！开始呼叫摄像头...");
    startCameraAndConnect();
};

async function startCameraAndConnect() {
    // 创建 P2P 通道
    peerConnection = new RTCPeerConnection(configuration);

    // 当我们的通道找到了网络捷径 (ICE 候选人) 时，通过红娘发给对方
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ 'candidate': event.candidate }));
        }
    };

    // 当通道里收到了对方传过来的视频流时，把它放到右边的 video 标签里！
    peerConnection.ontrack = event => {
        console.log("🎉 收到了对方的视频流！");
        remoteVideo.srcObject = event.streams[0];
    };

    // 获取自己的摄像头和麦克风
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = stream; // 左边显示自己
        
        // 把自己的音视频轨道塞进 P2P 通道里
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
    } catch (error) {
        alert("无法访问摄像头：" + error);
    }

    // 当通道需要协商时（比如刚把摄像头塞进去），主动向对方发送视频邀请 (Offer)
    peerConnection.onnegotiationneeded = async () => {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ 'offer': peerConnection.localDescription }));
        console.log("📤 发送了视频邀请 (Offer)");
    };
}

// 3. 监听红娘（WebSocket）从对方那里传来的消息
ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);

    // 如果收到的是对方的视频邀请 (Offer)
    if (message.offer) {
        console.log("📥 收到了对方的视频邀请，正在接听...");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ 'answer': peerConnection.localDescription })); // 发送同意接听 (Answer)
    }
    
    // 如果收到的是对方同意接听的回复 (Answer)
    if (message.answer) {
        console.log("📥 对方同意了接听！建立连接...");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    }
    
    // 如果收到的是对方的网络捷径 (ICE Candidate)
    if (message.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } catch (e) {
            console.error("添加网络捷径失败", e);
        }
    }
};