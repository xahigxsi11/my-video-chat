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
 * 7. Magic Camera：Canvas 处理 + 滤镜 + 截图
 * 8. Canvas → WebRTC 发送流
 * 9. Air Writing：HandLandmarker 空中写字
 */
(() => {
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('connectionStatus');

const muteBtn = document.getElementById('muteBtn');
const videoBtn = document.getElementById('videoBtn');
const hangupBtn = document.getElementById('hangupBtn');

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// --- Magic Camera DOM ---
const localCanvas = document.getElementById('localCanvas');
const fpsDisplay = document.getElementById('fpsDisplay');
const captureBtn = document.getElementById('captureBtn');
const filterBtns = document.querySelectorAll('.filter-btn');

// --- Air Writing DOM ---
const airWritingToggle = document.getElementById('airWritingToggle');
const clearDrawingBtn = document.getElementById('clearDrawingBtn');
const undoStrokeBtn = document.getElementById('undoStrokeBtn');
const mirrorToggle = document.getElementById('mirrorToggle');

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

// --- Magic Camera state ---
let canvasCtx = null;
let animFrameId = null;
let filterMode = 'normal';
let frameCount = 0;
let lastFpsTime = performance.now();
let outgoingStream = null;
let outgoingVideoTrack = null;

// --- Mirror state ---
let mirrorEnabled = true;

// --- Air Writing state ---
let handLandmarker = null;
let airWritingEnabled = false;
let isPinching = false;
let strokes = [];
let currentStroke = [];
let lastLandmarks = null;
const PINCH_DIST_THRESHOLD = 0.06;
let landmarkerInitPromise = null;
let landmarkerInitStarted = false;
let handDetectionFrameSkip = 0;
const HAND_DETECT_EVERY_N_FRAMES = 3;

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
        // 调试/稳定优先：强制所有音视频流量走 TURN relay。
        // 如果这样能连上，说明之前是 P2P/STUN 穿透失败。
        iceTransportPolicy: config.hasTurn ? 'relay' : 'all',
      };
      console.log('RTCPeerConnection configuration:', configuration);
    }

    if (!config.hasTurn) {
      console.warn('⚠️ 当前没有 TURN。复杂网络下视频/语音可能仍然无法互通。');
    }

    setStatus(config.hasTurn ? '已加载 TURN 配置（强制走 TURN 中继）' : '未配置 TURN，仅使用 STUN');
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
    startMagicCamera();
    outgoingStream = createOutgoingStream();
    setupEventListeners();
    connectWebSocket();

    setStatus(`本地媒体已就绪，房间：${roomID}`);
  } catch (e) {
    console.error('媒体设备初始化失败:', e);
    alert('无法访问摄像头/麦克风。请确认使用 https:// 访问，并允许浏览器权限。');
    setStatus('摄像头或麦克风初始化失败');
  }
}

// ----- Magic Camera -----

function startMagicCamera() {
  if (!localCanvas) return;
  canvasCtx = localCanvas.getContext('2d');
  if (!canvasCtx) return;

  lastFpsTime = performance.now();
  frameCount = 0;
  animFrameId = requestAnimationFrame(drawLoop);
}

function drawLoop() {
  if (!localCanvas || !canvasCtx || !localVideo || !localStream) {
    animFrameId = requestAnimationFrame(drawLoop);
    return;
  }

  const video = localVideo;
  const cw = localCanvas.width;
  const ch = localCanvas.height;

  // ----- 1) 绘制原始视频画面（可选镜像） -----
  canvasCtx.save();
  if (mirrorEnabled) {
    canvasCtx.translate(cw, 0);
    canvasCtx.scale(-1, 1);
  }
  canvasCtx.drawImage(video, 0, 0, cw, ch);
  canvasCtx.restore();

  // ----- 2) 应用滤镜 -----
  if (filterMode !== 'normal') {
    const imageData = canvasCtx.getImageData(0, 0, cw, ch);
    const data = imageData.data;
    const len = data.length;

    if (filterMode === 'grayscale') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = data[i + 1] = data[i + 2] = gray;
      }
    } else if (filterMode === 'high-contrast') {
      for (let i = 0; i < len; i += 4) {
        data[i] = data[i] > 128 ? 255 : 0;
        data[i + 1] = data[i + 1] > 128 ? 255 : 0;
        data[i + 2] = data[i + 2] > 128 ? 255 : 0;
      }
    }

    canvasCtx.putImageData(imageData, 0, 0);
  }

  // ----- 3) 绘制笔迹（在所有滤镜之上） -----
  drawStrokes();

  // ----- 4) HandLandmarker 检测与绘制（隔帧运行） -----
  handDetectionFrameSkip = (handDetectionFrameSkip + 1) % HAND_DETECT_EVERY_N_FRAMES;
  if (airWritingEnabled && handLandmarker && handDetectionFrameSkip === 0) {
    sendFrameToHandLandmarker();
    detectHandAndPinch();
  }

  // ----- 5) FPS -----
  frameCount++;
  const now = performance.now();
  const elapsed = now - lastFpsTime;
  if (elapsed >= 1000) {
    const fps = Math.round(frameCount / (elapsed / 1000));
    if (fpsDisplay) fpsDisplay.textContent = fps + ' FPS';
    frameCount = 0;
    lastFpsTime = now;
  }

  animFrameId = requestAnimationFrame(drawLoop);
}

function stopMagicCamera() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  canvasCtx = null;
}

function applyFilter(filterName) {
  filterMode = filterName;
  filterBtns.forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.filter === filterName);
  });
}

function capturePhoto() {
  if (!localCanvas) return;
  const link = document.createElement('a');
  link.download = 'capture-' + Date.now() + '.png';
  link.href = localCanvas.toDataURL('image/png');
  link.click();
}

function createOutgoingStream() {
  // 设定 canvas 大小与摄像头一致
  localCanvas.width = localVideo.videoWidth || 640;
  localCanvas.height = localVideo.videoHeight || 480;

  const canvasStream = localCanvas.captureStream(24);
  outgoingVideoTrack = canvasStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0];

  const stream = new MediaStream();
  if (outgoingVideoTrack) stream.addTrack(outgoingVideoTrack);
  if (audioTrack) stream.addTrack(audioTrack);
  return stream;
}

// ----- Air Writing -----

function getFingerPosition(landmarks, index, cw, ch) {
  return {
    x: (mirrorEnabled ? (1 - landmarks[index].x) : landmarks[index].x) * cw,
    y: landmarks[index].y * ch,
  };
}

function calcDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function detectHandAndPinch() {
  // landmarks are set by the onResults callback when running in VIDEO mode
  if (!lastLandmarks) return;

  const cw = localCanvas.width;
  const ch = localCanvas.height;

  // 拇指尖 (4) 与 食指尖 (8)
  const thumbTip = getFingerPosition(lastLandmarks, 4, cw, ch);
  const indexTip = getFingerPosition(lastLandmarks, 8, cw, ch);

  const dist = calcDistance(thumbTip, indexTip);
  const isNowPinching = dist < PINCH_DIST_THRESHOLD * cw;

  if (isNowPinching) {
    // 使用食指指尖作为绘制点（在食指和拇指中间更好看）
    const drawPoint = {
      x: (thumbTip.x + indexTip.x) / 2,
      y: (thumbTip.y + indexTip.y) / 2,
    };

    if (!isPinching) {
      // 捏合开始 → 新笔画
      isPinching = true;
      currentStroke = [drawPoint];
    } else {
      // 持续捏合 → 添加点
      currentStroke.push(drawPoint);
    }
  } else {
    // 松开捏合
    if (isPinching && currentStroke.length > 0) {
      strokes.push(currentStroke);
    }
    isPinching = false;
    currentStroke = [];
  }
}

function drawStrokes() {
  if (!canvasCtx) return;
  const ctx = canvasCtx;

  // 高亮色笔迹
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 8;

  // 绘制已完成的所有笔画
  for (let s = 0; s < strokes.length; s++) {
    const stroke = strokes[s];
    if (stroke.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let p = 1; p < stroke.length; p++) {
      ctx.lineTo(stroke[p].x, stroke[p].y);
    }
    ctx.stroke();
  }

  // 绘制当前笔画（捏合中）
  if (isPinching && currentStroke.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(currentStroke[0].x, currentStroke[0].y);
    for (let p = 1; p < currentStroke.length; p++) {
      ctx.lineTo(currentStroke[p].x, currentStroke[p].y);
    }
    ctx.stroke();
  }

  ctx.shadowBlur = 0;
}

function toggleAirWriting() {
  airWritingEnabled = !airWritingEnabled;
  airWritingToggle.classList.toggle('active', airWritingEnabled);

  if (airWritingEnabled) {
    setStatus('Air Writing 已开启（捏合食指+拇指写字）');
    if (!handLandmarker && !landmarkerInitStarted) {
      initHandLandmarker();
    }
  } else {
    setStatus(airWritingEnabled ? '' : `本地媒体已就绪，房间：${roomID}`);
  }
}

async function initHandLandmarker() {
  if (landmarkerInitStarted) return;
  landmarkerInitStarted = true;

  try {
    setStatus('正在加载手势识别模型...');

    const tokenQs = token ? '?token=' + encodeURIComponent(token) : '';

    // vision_bundle.js 是 ES Module，不能用普通 <script> 加载，否则会因为 export 语法报错。
    // 用动态 import 后，从模块命名空间里读取 FilesetResolver / HandLandmarker。
    const visionModule = await import('./assets/mediapipe/vision_bundle.js' + tokenQs);
    const FilesetResolverClass = visionModule.FilesetResolver;
    const HandLandmarkerClass = visionModule.HandLandmarker;

    if (!FilesetResolverClass || !HandLandmarkerClass) {
      throw new Error('MediaPipe Vision 模块导出不完整');
    }

    const vision = await FilesetResolverClass.forVisionTasks('assets/mediapipe');

    const options = {
      baseOptions: {
        modelAssetPath: 'assets/mediapipe/hand_landmarker.task' + tokenQs,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    };

    // 某些浏览器 / 显卡环境下 GPU delegate 会初始化失败，自动回退 CPU。
    try {
      handLandmarker = await HandLandmarkerClass.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn('GPU delegate 初始化失败，回退到 CPU:', gpuError);
      options.baseOptions.delegate = 'CPU';
      handLandmarker = await HandLandmarkerClass.createFromOptions(vision, options);
    }

    setStatus('手势识别模型已加载，捏合食指+拇指写字');
  } catch (e) {
    console.error('HandLandmarker 初始化失败:', e);
    setStatus('手势识别加载失败：请按 F12 查看 Console 具体错误');
    airWritingEnabled = false;
    airWritingToggle.classList.remove('active');
    landmarkerInitStarted = false;
  }
}

function loadScript(src) {
  return new Promise(function(resolve, reject) {
    var script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function sendFrameToHandLandmarker() {
  if (!handLandmarker || !airWritingEnabled || !localVideo || !localVideo.videoWidth) return;

  try {
    // results are applied via the VIDEO mode callback
    const results = handLandmarker.detectForVideo(localVideo, performance.now());
    if (results.landmarks && results.landmarks.length > 0) {
      lastLandmarks = results.landmarks[0];
    } else {
      // 没人手在画面中 → 松开笔
      if (isPinching) {
        if (currentStroke.length > 0) {
          strokes.push(currentStroke);
        }
        currentStroke = [];
        isPinching = false;
      }
      lastLandmarks = null;
    }
  } catch (e) {
    // silent
  }
}

function clearDrawing() {
  strokes = [];
  currentStroke = [];
  isPinching = false;
}

function undoStroke() {
  if (strokes.length > 0) {
    strokes.pop();
  }
  currentStroke = [];
  isPinching = false;
}

// ----- WebSocket -----

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


async function logSelectedCandidatePair(pc) {
  try {
    const stats = await pc.getStats();
    let selectedPair = null;

    stats.forEach(report => {
      if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
        if (!selectedPair || report.selected) selectedPair = report;
      }
    });

    if (!selectedPair) {
      console.log('未找到已选中的 candidate-pair。可能还没有真正连通。');
      return;
    }

    const local = stats.get(selectedPair.localCandidateId);
    const remote = stats.get(selectedPair.remoteCandidateId);

    console.log('Selected ICE candidate pair:', {
      pairState: selectedPair.state,
      nominated: selectedPair.nominated,
      currentRoundTripTime: selectedPair.currentRoundTripTime,
      availableOutgoingBitrate: selectedPair.availableOutgoingBitrate,
      localType: local && local.candidateType,
      localProtocol: local && local.protocol,
      localAddress: local && (local.address || local.ip),
      localPort: local && local.port,
      remoteType: remote && remote.candidateType,
      remoteProtocol: remote && remote.protocol,
      remoteAddress: remote && (remote.address || remote.ip),
      remotePort: remote && remote.port,
    });
  } catch (e) {
    console.warn('读取 WebRTC stats 失败:', e);
  }
}

function createPeerConnection() {
  if (peerConnection) return peerConnection;

  setStatus('正在创建 WebRTC 连接...');
  pendingCandidates = [];

  peerConnection = new RTCPeerConnection(configuration);
  console.log('创建 RTCPeerConnection，当前配置：', configuration);

  outgoingStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, outgoingStream);
  });

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      const cand = event.candidate.candidate || '';
      const typMatch = cand.match(/ typ ([a-zA-Z0-9_-]+)/);
      const protocolMatch = cand.match(/ (udp|tcp) /i);
      console.log('ICE candidate:', {
        type: typMatch ? typMatch[1] : 'unknown',
        protocol: protocolMatch ? protocolMatch[1] : 'unknown',
        raw: cand,
      });
      sendSignal({ candidate: event.candidate });
    } else {
      console.log('ICE candidate gathering complete');
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    console.log('ICE gathering state:', peerConnection.iceGatheringState);
  };

  peerConnection.ontrack = event => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
    setStatus('已收到对方视频/音频');
  };

  peerConnection.oniceconnectionstatechange = async () => {
    console.log('ICE state:', peerConnection.iceConnectionState);

    if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
      setStatus('ICE 已连接');
      await logSelectedCandidatePair(peerConnection);
    }

    if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
      await logSelectedCandidatePair(peerConnection);
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

  stopMagicCamera();
  stopHeartbeat();
  resetPeerConnection();

  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }

  if (outgoingStream) {
    outgoingStream.getTracks().forEach(function(t) { t.stop(); });
    outgoingStream = null;
    outgoingVideoTrack = null;
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
    if (outgoingVideoTrack) {
      outgoingVideoTrack.enabled = !isVideoOff;
    }

    videoBtn.innerText = isVideoOff ? 'Video On' : 'Video Off';
    videoBtn.style.background = isVideoOff ? '#57606f' : 'rgba(255, 255, 255, 0.1)';
  };

  hangupBtn.onclick = () => {
    if (confirm('确定要结束通话吗？')) {
      closeEverything(true);
      setStatus('通话已结束');
    }
  };

  // --- Magic Camera event listeners ---
  captureBtn.onclick = capturePhoto;

  filterBtns.forEach(function(btn) {
    btn.onclick = function() {
      applyFilter(this.dataset.filter);
    };
  });

  // --- Mirror toggle ---
  mirrorToggle.onclick = function() {
    mirrorEnabled = !mirrorEnabled;
    mirrorToggle.classList.toggle('active', mirrorEnabled);
  };

  // --- Air Writing event listeners ---
  airWritingToggle.onclick = toggleAirWriting;
  clearDrawingBtn.onclick = clearDrawing;
  undoStrokeBtn.onclick = undoStroke;

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
})();