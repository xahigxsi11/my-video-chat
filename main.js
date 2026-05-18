/**
 * 私密双人 WebRTC 网站：稳定性优化版
 *
 * 主要改动：
 * 1. 从 /config 读取 STUN/TURN 配置
 * 2. 支持 ?room=xxx 和 ?token=xxx
 * 3. ICE candidate 排队，避免 candidate 早于 remoteDescription 导致失败
 * 4. WebSocket 心跳与自动重连
 * 5. WebRTC failed/disconnected 后重建
 * 6. 增加连接状态显示
 */

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('connectionStatus');

const muteBtn = document.getElementById('muteBtn');
const videoBtn = document.getElementById('videoBtn');
const hangupBtn = document.getElementById('hangupBtn');

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

const params = new URLSearchParams(window.location.search);
const roomID = params.get('room') || '888';
const token = params.get('token') || '';

let configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let ws = null;

let myRole = null;
let manuallyClosed = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingCandidates = [];

let isMuted = false;
let isVideoOff = false;

function setStatus(text) {
  console.log(text);
  if (statusEl) statusEl.textContent = text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadConfig() {
  try {
    const res = await fetch('/config', { cache: 'no-store' });
    const config = await res.json();

    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      configuration = {
        iceServers: config.iceServers,
        iceCandidatePoolSize: 10,
      };
    }

    if (!config.hasTurn) {
      console.warn('⚠️ 当前没有 TURN。复杂网络下视频/语音可能仍然无法互通。');
    }

    setStatus(config.hasTurn ? '已加载 TURN 配置' : '未配置 TURN，仅使用 STUN');
  } catch (e) {
    console.warn('读取 /config 失败，使用默认 STUN 配置：', e);
    setStatus('配置读取失败，使用默认 STUN');
  }
}

async function startApp() {
  try {
    setStatus('正在初始化摄像头和麦克风...');
    await loadConfig();

    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    localVideo.srcObject = localStream;
    setupEventListeners();
    connectWebSocket();

    setStatus(`本地媒体已就绪，房间：${roomID}`);
  } catch (e) {
    console.error('媒体设备初始化失败:', e);
    alert('无法访问摄像头/麦克风。请确认使用 https:// 访问，并允许浏览器权限。');
    setStatus('摄像头或麦克风初始化失败');
  }
}

function buildWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${window.location.host}/ws/${encodeURIComponent(roomID)}${qs}`;
}

function connectWebSocket() {
  if (manuallyClosed) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = buildWsUrl();
  setStatus('正在连接信令服务器...');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('信令服务器已连接，等待对方进入...');
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      console.warn('收到非 JSON 消息:', event.data);
      return;
    }

    await handleMessage(message);
  };

  ws.onerror = (e) => {
    console.warn('WebSocket error:', e);
    setStatus('信令连接异常');
  };

  ws.onclose = () => {
    stopHeartbeat();

    if (manuallyClosed) {
      setStatus('通话已结束');
      return;
    }

    setStatus('信令断开，正在重连...');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer || manuallyClosed) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

function startHeartbeat() {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    }
  }, 25000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case 'joined':
      myRole = message.role;
      setStatus(
        message.peers === 1
          ? '你已进入房间，等待对方进入...'
          : '双方已进入，正在建立连接...'
      );

      // 第二个进入的人先只等待 offer，避免两边同时 offer 造成 glare。
      if (message.role === 'callee') {
        createPeerConnection();
      }
      return;

    case 'peer-joined':
      setStatus('对方已进入，正在发起连接...');
      await makeCall();
      return;

    case 'peer-left':
      setStatus('对方已离开，等待重新连接...');
      resetPeerConnection();
      return;

    case 'room-full':
      alert('房间里已经有两个人了。请确认没有旧页面开着，双方都刷新后再试。');
      manuallyClosed = true;
      closeEverything(false);
      return;

    case 'auth-failed':
      alert('访问 token 不正确。请检查链接里的 token。');
      manuallyClosed = true;
      closeEverything(false);
      return;

    case 'server-ping':
      return;

    case 'pong':
      return;

    case 'chat':
      appendMessage('peer', message.content || '');
      return;

    default:
      await handleSignalingMessage(message);
  }
}

async function handleSignalingMessage(message) {
  try {
    if (message.offer) {
      setStatus('收到对方邀请，正在回应...');
      createPeerConnection();

      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      await flushPendingCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      sendSignal({ answer: peerConnection.localDescription });
      setStatus('已发送回应，正在连接...');
      return;
    }

    if (message.answer) {
      if (!peerConnection) {
        console.warn('收到 answer 但 peerConnection 不存在');
        return;
      }

      setStatus('收到对方回应，正在建立连接...');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
      await flushPendingCandidates();
      return;
    }

    if (message.candidate) {
      await addCandidate(message.candidate);
      return;
    }
  } catch (e) {
    console.error('信令处理出错:', e);
    setStatus('信令处理出错，正在尝试恢复...');
  }
}

function createPeerConnection() {
  if (peerConnection) return peerConnection;

  setStatus('正在创建 WebRTC 连接...');
  pendingCandidates = [];

  peerConnection = new RTCPeerConnection(configuration);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      sendSignal({ candidate: event.candidate });
    }
  };

  peerConnection.ontrack = event => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
    setStatus('已收到对方视频/音频');
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);

    if (peerConnection.iceConnectionState === 'connected') {
      setStatus('ICE 已连接');
    }

    if (peerConnection.iceConnectionState === 'failed') {
      setStatus('ICE 连接失败，正在重启...');
      restartIce();
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('PeerConnection state:', state);

    if (state === 'connected') {
      setStatus('通话已连接');
    }

    if (state === 'failed') {
      setStatus('连接失败，正在重建...');
      resetPeerConnection();
      if (myRole === 'caller' && ws && ws.readyState === WebSocket.OPEN) {
        setTimeout(makeCall, 1000);
      }
    }

    if (state === 'disconnected') {
      setStatus('连接暂时中断，等待恢复...');
    }

    if (state === 'closed') {
      setStatus('WebRTC 连接已关闭');
    }
  };

  return peerConnection;
}

async function makeCall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('信令未连接，无法发起通话');
    return;
  }

  createPeerConnection();

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ offer: peerConnection.localDescription });
    setStatus('已发送连接邀请，等待对方回应...');
  } catch (e) {
    console.error('创建 offer 失败:', e);
    setStatus('创建连接邀请失败');
  }
}

async function restartIce() {
  if (!peerConnection || myRole !== 'caller') return;

  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    sendSignal({ offer: peerConnection.localDescription });
  } catch (e) {
    console.error('ICE restart failed:', e);
    resetPeerConnection();
  }
}

async function addCandidate(candidate) {
  try {
    if (peerConnection && peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      pendingCandidates.push(candidate);
    }
  } catch (e) {
    console.warn('添加 ICE candidate 失败:', e);
  }
}

async function flushPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  for (const candidate of pendingCandidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('flush candidate failed:', e);
    }
  }

  pendingCandidates = [];
}

function sendSignal(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('WebSocket 未连接，消息未发送:', payload);
  }
}

function resetPeerConnection() {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  pendingCandidates = [];
  remoteVideo.srcObject = null;
}

function closeEverything(stopLocalTracks = true) {
  manuallyClosed = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  stopHeartbeat();
  resetPeerConnection();

  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  if (stopLocalTracks && localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
}

function setupEventListeners() {
  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });

    muteBtn.innerText = isMuted ? 'Unmute' : 'Mute';
    muteBtn.style.background = isMuted ? '#57606f' : 'rgba(255, 255, 255, 0.1)';
  };

  videoBtn.onclick = () => {
    isVideoOff = !isVideoOff;
    localStream.getVideoTracks().forEach(track => {
      track.enabled = !isVideoOff;
    });

    videoBtn.innerText = isVideoOff ? 'Video On' : 'Video Off';
    videoBtn.style.background = isVideoOff ? '#57606f' : 'rgba(255, 255, 255, 0.1)';
  };

  hangupBtn.onclick = () => {
    if (confirm('确定要结束通话吗？')) {
      closeEverything(true);
      setStatus('通话已结束');
    }
  };

  const performSend = () => {
    const text = chatInput.value.trim();
    if (!text) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSignal({ type: 'chat', content: text });
      appendMessage('me', text);
      chatInput.value = '';
    } else {
      alert('信令服务器未连接，暂时无法发送消息。');
    }
  };

  sendBtn.onclick = performSend;

  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter') performSend();
  };

  window.addEventListener('beforeunload', () => {
    closeEverything(true);
  });
}

function appendMessage(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg ${sender === 'me' ? 'msg-me' : 'msg-peer'}`;
  msgDiv.innerText = text;

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

startApp();
