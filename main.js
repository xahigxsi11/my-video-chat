/**
 * 私密双人 WebRTC 网站：稳定性优化版 v2
 *
 * v2 改动（2026-06-16）：
 * 1. 引入 pcGeneration — 每次新建 PC 递增，信令消息带 generation，忽略旧消息
 * 2. 移除硬编码 iceTransportPolicy: 'relay'，改为 URL 参数 ?forceRelay=1 控制
 * 3. 支持 ?debug=webrtc、?forceRelay=1、?turnTcpOnly=1
 * 4. ICE disconnected 等待 7 秒再判定失败，避免过早重建
 * 5. peer-left 等待 10 秒再 reset PC，避免 WebSocket 短暂断开引发震荡
 * 6. restartIce 对双方都可用（不再仅 caller）
 * 7. onconnectionstatechange 'failed' 不再重复 reset（交给 ICE failed 处理）
 * 8. remoteVideo 显式调用 play()，失败时显示点击播放按钮
 * 9. 增强 ICE candidate pair 日志（nominated、rtt、bitrate、bytesReceived）
 * 10. Magic Camera / Air Writing / 聊天功能完全保留
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

// ===== URL 参数 =====
const params = new URLSearchParams(window.location.search);
const roomID = params.get('room') || '888';
const token = params.get('token') || '';
const DEBUG_WEBRTC = params.get('debug') === 'webrtc' || params.get('debug') === '1';
const FORCE_RELAY = params.get('forceRelay') === '1';
const TURN_TCP_ONLY = params.get('turnTcpOnly') === '1';

// ===== 配置 =====
let configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

// ===== 全局状态 =====
let peerConnection = null;
let pcGeneration = 0;           // 每次 createPeerConnection 递增
let localStream = null;
let ws = null;

let myRole = null;
let manuallyClosed = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingCandidates = [];

// ICE disconnected 计时器
let iceDisconnectTimer = null;
const ICE_DISCONNECT_GRACE_MS = 7000;   // disconnected 后等 7 秒

// peer-left 防抖
let peerLeftTimer = null;
const PEER_LEFT_GRACE_MS = 10000;       // 对方离开后等 10 秒

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

// ===== 工具函数 =====

function setStatus(text) {
  console.log('[status]', text);
  if (statusEl) statusEl.textContent = text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debugLog(tag, ...args) {
  if (DEBUG_WEBRTC) {
    console.log(`[webrtc:${tag}]`, ...args);
  }
}

function sanitizeCandidateForLog(candidateStr) {
  // SDP candidate 行里 IP 地址脱敏：保留类型和协议，IP 替换为 x.x.x.x
  if (!candidateStr) return '(empty)';
  const parts = candidateStr.split(' ');
  if (parts.length >= 5) {
    parts[4] = 'x.x.x.x';  // address
  }
  return parts.join(' ');
}

// ===== /config 加载 =====

async function loadConfig() {
  try {
    const res = await fetch('/config', { cache: 'no-store' });
    const config = await res.json();

    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      let iceServers = config.iceServers;

      // 如果 ?turnTcpOnly=1，只保留 TCP/TLS 的 TURN URL
      if (TURN_TCP_ONLY) {
        iceServers = iceServers.map(server => {
          if (server.urls && (typeof server.urls === 'string' || Array.isArray(server.urls))) {
            const urls = (typeof server.urls === 'string' ? [server.urls] : server.urls)
              .filter(u => {
                const lower = u.toLowerCase();
                return !lower.startsWith('turn:') || lower.includes('transport=tcp') || lower.startsWith('turns:');
              });
            if (urls.length === 0) return null;
            return { ...server, urls: urls.length === 1 ? urls[0] : urls };
          }
          return server;
        }).filter(Boolean);
        console.log('TURN TCP-only 模式，过滤后 iceServers:', iceServers.length, '个');
      }

      configuration = {
        iceServers: iceServers,
        iceCandidatePoolSize: 10,
      };

      // 只有 ?forceRelay=1 时才强制走 relay
      if (FORCE_RELAY) {
        configuration.iceTransportPolicy = 'relay';
        console.log('强制 relay 模式（?forceRelay=1）');
      }

      debugLog('config', 'RTCPeerConnection configuration:', {
        iceServers: iceServers.map(s => ({
          urls: typeof s.urls === 'string' ? s.urls : JSON.stringify(s.urls),
          hasCredential: !!s.credential,
          hasUsername: !!s.username,
        })),
        iceTransportPolicy: configuration.iceTransportPolicy || 'all',
      });
    }

    console.log('TURN 状态:', {
      hasTurn: config.hasTurn,
      turnUrlCount: config.turnUrlCount || 0,
      roomSecretEnabled: config.roomSecretEnabled,
    });

    if (!config.hasTurn) {
      console.warn('⚠️ 当前没有 TURN。复杂网络下视频/语音可能无法互通。');
    }

    setStatus(config.hasTurn ? '已加载配置' : '未配置 TURN，仅使用 STUN');
  } catch (e) {
    console.warn('读取 /config 失败，使用默认 STUN 配置：', e);
    setStatus('配置读取失败，使用默认 STUN');
  }
}

// ===== 应用启动 =====

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
  if (!lastLandmarks) return;

  const cw = localCanvas.width;
  const ch = localCanvas.height;

  const thumbTip = getFingerPosition(lastLandmarks, 4, cw, ch);
  const indexTip = getFingerPosition(lastLandmarks, 8, cw, ch);

  const dist = calcDistance(thumbTip, indexTip);
  const isNowPinching = dist < PINCH_DIST_THRESHOLD * cw;

  if (isNowPinching) {
    const drawPoint = {
      x: (thumbTip.x + indexTip.x) / 2,
      y: (thumbTip.y + indexTip.y) / 2,
    };

    if (!isPinching) {
      isPinching = true;
      currentStroke = [drawPoint];
    } else {
      currentStroke.push(drawPoint);
    }
  } else {
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

  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 8;

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

function sendFrameToHandLandmarker() {
  if (!handLandmarker || !airWritingEnabled || !localVideo || !localVideo.videoWidth) return;

  try {
    const results = handLandmarker.detectForVideo(localVideo, performance.now());
    if (results.landmarks && results.landmarks.length > 0) {
      lastLandmarks = results.landmarks[0];
    } else {
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

// ===== WebSocket =====

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

// ===== 消息处理 =====

async function handleMessage(message) {
  const msgGen = message.generation; // 对方 PC 的 generation

  switch (message.type) {
    case 'joined':
      myRole = message.role;
      debugLog('signal', 'joined role=' + myRole + ' peers=' + message.peers);
      setStatus(
        message.peers === 1
          ? '你已进入房间，等待对方进入...'
          : '双方已进入，正在建立连接...'
      );

      // 第二个人进入时：预先创建 PC（但不发 offer）
      // 这样当 offer 到达时 PC 已经 ready，减少延迟
      if (message.role === 'callee') {
        createPeerConnection();
      }
      return;

    case 'peer-joined':
      debugLog('signal', 'peer-joined');
      setStatus('对方已进入，正在发起连接...');

      // 取消 peer-left 的防抖计时器
      if (peerLeftTimer) {
        clearTimeout(peerLeftTimer);
        peerLeftTimer = null;
        debugLog('signal', 'peer-left 计时器已取消（对方已重新进入）');
      }

      await makeCall();
      return;

    case 'peer-left':
      debugLog('signal', 'peer-left 收到，启动 ' + (PEER_LEFT_GRACE_MS / 1000) + 's 防抖');
      setStatus('对方可能暂时离开，等待重连...');

      // 不清除 peerLeftTimer，等待 peer-joined 或超时
      if (!peerLeftTimer) {
        peerLeftTimer = setTimeout(() => {
          peerLeftTimer = null;
          debugLog('signal', 'peer-left 防抖超时，正式重置连接');
          setStatus('对方已离开，等待重新连接...');
          resetPeerConnection();
        }, PEER_LEFT_GRACE_MS);
      }
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
      await handleSignalingMessage(message, msgGen);
  }
}

// ===== WebRTC 信令处理 =====

async function handleSignalingMessage(message, msgGen) {
  try {
    // ---- offer ----
    if (message.offer) {
      // 过滤旧 generation 的 offer
      if (msgGen !== undefined && msgGen < pcGeneration && peerConnection) {
        debugLog('stale', '忽略旧 generation offer: msgGen=' + msgGen + ' current=' + pcGeneration);
        return;
      }

      debugLog('signal', '收到 offer (gen=' + msgGen + ')');
      setStatus('收到对方邀请，正在回应...');

      // 如果已有 PC 但处于 closed 状态，先清理
      if (peerConnection && peerConnection.signalingState === 'closed') {
        debugLog('signal', '旧 PC 已 closed，重建');
        resetPeerConnection();
      }

      createPeerConnection();

      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      await flushPendingCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      sendSignal({ answer: peerConnection.localDescription, generation: pcGeneration });
      setStatus('已发送回应，正在连接...');
      return;
    }

    // ---- answer ----
    if (message.answer) {
      if (!peerConnection) {
        console.warn('收到 answer 但 peerConnection 不存在，可能连接已关闭');
        return;
      }

      // 过滤旧 generation 的 answer
      if (msgGen !== undefined && msgGen < pcGeneration) {
        debugLog('stale', '忽略旧 generation answer: msgGen=' + msgGen + ' current=' + pcGeneration);
        return;
      }

      debugLog('signal', '收到 answer (gen=' + msgGen + ')');

      // 检查 signalingState 是否允许设置 remote description
      if (peerConnection.signalingState !== 'have-local-offer') {
        debugLog('signal', '跳过 answer: 当前 signalingState=' + peerConnection.signalingState + '（不是 have-local-offer）');
        return;
      }

      setStatus('收到对方回应，正在建立连接...');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
      await flushPendingCandidates();
      return;
    }

    // ---- candidate ----
    if (message.candidate) {
      // 过滤旧 generation 的 candidate
      if (msgGen !== undefined && msgGen < pcGeneration) {
        // 静默忽略旧 candidate，否则会有大量日志
        return;
      }

      await addCandidate(message.candidate);
      return;
    }
  } catch (e) {
    console.error('信令处理出错:', e, message);
    setStatus('信令处理出错，正在尝试恢复...');
  }
}

// ===== RTCPeerConnection 创建 =====

function createPeerConnection() {
  // 如果已有 PC 且不是 closed 状态，直接复用
  if (peerConnection) {
    if (peerConnection.signalingState !== 'closed') {
      debugLog('pc', '复用现有 PC (gen=' + pcGeneration + ')');
      return peerConnection;
    }
    // closed 的 PC 先清理
    debugLog('pc', '清理已 closed 的 PC');
    resetPeerConnection();
  }

  pcGeneration++;
  const myGen = pcGeneration;
  pendingCandidates = [];
  // 清除 ICE disconnected 计时器
  if (iceDisconnectTimer) {
    clearTimeout(iceDisconnectTimer);
    iceDisconnectTimer = null;
  }

  setStatus('正在创建 WebRTC 连接...');

  peerConnection = new RTCPeerConnection(configuration);
  debugLog('pc', '创建 RTCPeerConnection gen=' + myGen + ' config:', {
    iceServers: configuration.iceServers.map(s => ({
      urls: typeof s.urls === 'string' ? s.urls.replace(/turn:[^?]+/, 'turn:***') : '[...]',
      hasCredential: !!s.credential,
      hasUsername: !!s.username,
    })),
    iceTransportPolicy: configuration.iceTransportPolicy || 'all',
  });

  // 添加本地 tracks
  outgoingStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, outgoingStream);
  });

  // -- ICE candidate 事件 --
  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      const cand = event.candidate.candidate || '';
      const typMatch = cand.match(/ typ ([a-zA-Z0-9_-]+)/);
      const protocolMatch = cand.match(/ (udp|tcp) /i);
      const relayProtocolMatch = cand.match(/ relay-protocol (udp|tcp)/i);
      debugLog('ice', '本地 candidate:', {
        type: typMatch ? typMatch[1] : 'unknown',
        protocol: protocolMatch ? protocolMatch[1] : 'unknown',
        relayProtocol: relayProtocolMatch ? relayProtocolMatch[1] : null,
        gen: myGen,
      });
      sendSignal({ candidate: event.candidate, generation: myGen });
    } else {
      debugLog('ice', 'ICE candidate gathering 完成 (gen=' + myGen + ')');
    }
  };

  // -- ICE gathering 状态 --
  peerConnection.onicegatheringstatechange = () => {
    debugLog('ice', 'gathering state:', peerConnection.iceGatheringState);
  };

  // -- 远端 track --
  peerConnection.ontrack = event => {
    debugLog('track', 'ontrack 触发, streams=' + event.streams.length + ', track kind=' + event.track.kind);
    if (event.streams[0] && remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      // 显式调用 play()，处理 autoplay 被浏览器阻止的情况
      remoteVideo.play().then(() => {
        debugLog('track', 'remoteVideo.play() 成功');
      }).catch(err => {
        console.warn('remoteVideo.play() 被浏览器阻止:', err.name);
        showPlayButton();
      });
    }
    setStatus('已收到对方视频/音频');
  };

  // -- ICE 连接状态 --
  peerConnection.oniceconnectionstatechange = async () => {
    const iceState = peerConnection.iceConnectionState;
    debugLog('ice', 'connection state:', iceState);

    // 清除之前的 disconnected 计时器
    if (iceDisconnectTimer) {
      clearTimeout(iceDisconnectTimer);
      iceDisconnectTimer = null;
    }

    if (iceState === 'connected' || iceState === 'completed') {
      setStatus('ICE 已连接');
      await logSelectedCandidatePair(peerConnection);
      await logInboundStats(peerConnection);
    }

    if (iceState === 'disconnected') {
      setStatus('ICE 暂时中断，等待恢复...');
      // 不立即处理，等待一段时间看是否恢复
      iceDisconnectTimer = setTimeout(async () => {
        iceDisconnectTimer = null;
        if (peerConnection && peerConnection.iceConnectionState === 'disconnected') {
          debugLog('ice', 'disconnected 持续超过 ' + (ICE_DISCONNECT_GRACE_MS / 1000) + 's，尝试 ICE restart');
          await logSelectedCandidatePair(peerConnection);
          restartIce();
        }
      }, ICE_DISCONNECT_GRACE_MS);
    }

    if (iceState === 'failed') {
      await logSelectedCandidatePair(peerConnection);
      setStatus('ICE 连接失败，正在重启...');
      restartIce();
    }
  };

  // -- 连接状态 --
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    debugLog('pc', 'connection state:', state);

    if (state === 'connected') {
      setStatus('通话已连接 ✓');
    }

    if (state === 'disconnected') {
      // 让 ICE disconnected 处理，这里只记录
      debugLog('pc', 'connectionState=disconnected，等待 ICE 层恢复');
    }

    if (state === 'failed') {
      // iceConnectionState 的 failed 处理器已经调用了 restartIce
      // 这里只在 ICE 层没有自动重启时才完整重建
      debugLog('pc', 'connectionState=failed，ICE 层应该已经处理');
      // 如果 ICE 状态还是 failed 且 restartIce 没起作用，做完整重建
      if (peerConnection && peerConnection.iceConnectionState === 'failed') {
        setStatus('连接失败，正在重建...');
        const wasCaller = myRole === 'caller';
        resetPeerConnection();
        if (wasCaller && ws && ws.readyState === WebSocket.OPEN) {
          setTimeout(makeCall, 1500);
        }
      }
    }

    if (state === 'closed') {
      setStatus('WebRTC 连接已关闭');
    }
  };

  return peerConnection;
}

// ===== makeCall / restartIce =====

async function makeCall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('信令未连接，无法发起通话');
    return;
  }

  createPeerConnection();
  const myGen = pcGeneration;

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ offer: peerConnection.localDescription, generation: myGen });
    debugLog('signal', '发送 offer (gen=' + myGen + ')');
    setStatus('已发送连接邀请，等待对方回应...');
  } catch (e) {
    console.error('创建 offer 失败:', e);
    setStatus('创建连接邀请失败');
  }
}

async function restartIce() {
  if (!peerConnection) return;
  if (peerConnection.signalingState === 'closed') {
    debugLog('ice', 'restartIce: PC 已 closed，跳过');
    return;
  }

  const myGen = pcGeneration;
  debugLog('ice', '执行 ICE restart (gen=' + myGen + ', role=' + myRole + ')');

  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    sendSignal({ offer: peerConnection.localDescription, generation: myGen });
    setStatus('ICE 重启中...');
  } catch (e) {
    console.error('ICE restart 失败:', e);
    debugLog('ice', 'ICE restart 失败，完整重建');
    const wasCaller = myRole === 'caller';
    resetPeerConnection();
    if (wasCaller && ws && ws.readyState === WebSocket.OPEN) {
      setTimeout(makeCall, 1500);
    }
  }
}

// ===== ICE candidate 管理 =====

async function addCandidate(candidate) {
  try {
    if (peerConnection && peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      pendingCandidates.push(candidate);
      debugLog('ice', 'candidate 缓存（remoteDescription 未就绪），队列长度=' + pendingCandidates.length);
    }
  } catch (e) {
    console.warn('添加 ICE candidate 失败:', e);
  }
}

async function flushPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  const toFlush = pendingCandidates.slice();
  pendingCandidates = [];

  if (toFlush.length > 0) {
    debugLog('ice', '刷新 ' + toFlush.length + ' 个缓存的 candidate');
  }

  for (const candidate of toFlush) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('flush candidate 失败:', e);
    }
  }
}

// ===== 信令发送 =====

function sendSignal(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('WebSocket 未连接，消息未发送:', payload);
  }
}

// ===== 统计信息（调试用） =====

async function logSelectedCandidatePair(pc) {
  try {
    const stats = await pc.getStats();
    let selectedPair = null;
    let nominatedPair = null;

    stats.forEach(report => {
      if (report.type === 'candidate-pair') {
        if (report.selected) selectedPair = report;
        if (report.nominated && !nominatedPair) nominatedPair = report;
        if (report.state === 'succeeded' && !selectedPair && !nominatedPair) nominatedPair = report;
      }
    });

    const bestPair = selectedPair || nominatedPair;
    if (!bestPair) {
      debugLog('stats', '未找到 selected/nominated candidate-pair');
      // 打印所有 pair 的状态帮助诊断
      if (DEBUG_WEBRTC) {
        const pairs = [];
        stats.forEach(r => {
          if (r.type === 'candidate-pair') {
            pairs.push({
              state: r.state,
              nominated: r.nominated,
              selected: r.selected,
              localCandidateId: r.localCandidateId,
              remoteCandidateId: r.remoteCandidateId,
            });
          }
        });
        console.log('[webrtc:stats] 所有 candidate-pairs:', pairs);
      }
      return;
    }

    const local = stats.get(bestPair.localCandidateId);
    const remote = stats.get(bestPair.remoteCandidateId);

    console.log('=== Selected ICE candidate pair ===');
    console.log('  状态:', bestPair.state, '| nominated:', bestPair.nominated, '| selected:', bestPair.selected);
    console.log('  RTT:', bestPair.currentRoundTripTime, 's | 可用出带宽:', bestPair.availableOutgoingBitrate, 'bps');
    console.log('  本地:', {
      type: local && local.candidateType,
      protocol: local && local.protocol,
      relayProtocol: local && local.relayProtocol,
      address: local && (local.address || local.ip),
      port: local && local.port,
    });
    console.log('  远端:', {
      type: remote && remote.candidateType,
      protocol: remote && remote.protocol,
      address: remote && (remote.address || remote.ip),
      port: remote && remote.port,
    });
    console.log('  判断: 走 relay=' + (local && local.candidateType === 'relay') +
                ' 走 srflx=' + (local && local.candidateType === 'srflx') +
                ' 走 host=' + (local && local.candidateType === 'host'));
    console.log('  协议: ' + (local && local.protocol) + ' / ' + (local && local.relayProtocol || 'N/A'));
    console.log('===================================');
  } catch (e) {
    console.warn('读取 WebRTC stats 失败:', e);
  }
}

async function logInboundStats(pc) {
  try {
    const stats = await pc.getStats();
    stats.forEach(report => {
      if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.kind === 'audio')) {
        debugLog('stats', 'inbound-' + report.kind, {
          bytesReceived: report.bytesReceived,
          packetsReceived: report.packetsReceived,
          packetsLost: report.packetsLost,
          framesDecoded: report.framesDecoded,
          frameWidth: report.frameWidth,
          frameHeight: report.frameHeight,
          framesPerSecond: report.framesPerSecond,
          jitter: report.jitter,
        });
      }
    });
  } catch (e) {
    console.warn('读取 inbound stats 失败:', e);
  }
}

// ===== 连接清理 =====

function resetPeerConnection() {
  // 清除 ICE 计时器
  if (iceDisconnectTimer) {
    clearTimeout(iceDisconnectTimer);
    iceDisconnectTimer = null;
  }

  if (peerConnection) {
    debugLog('pc', '重置 PC (gen=' + pcGeneration + ')');
    peerConnection.onicecandidate = null;
    peerConnection.onicegatheringstatechange = null;
    peerConnection.ontrack = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  pendingCandidates = [];
  remoteVideo.srcObject = null;

  // 移除播放按钮
  const playBtn = document.getElementById('remotePlayBtn');
  if (playBtn) playBtn.remove();
}

function showPlayButton() {
  // 如果已经有了就不重复创建
  if (document.getElementById('remotePlayBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'remotePlayBtn';
  btn.textContent = '▶ 点击播放对方画面/声音';
  btn.style.cssText = 'display:block;margin:8px auto;padding:8px 16px;background:#00f2fe;color:#1a1a2e;border:none;border-radius:8px;cursor:pointer;font-weight:bold;';
  btn.onclick = () => {
    if (remoteVideo.srcObject) {
      remoteVideo.play().then(() => {
        btn.remove();
        debugLog('track', '用户手动播放 remoteVideo 成功');
      }).catch(err => {
        console.warn('手动播放仍然失败:', err);
      });
    }
  };
  const peerCard = remoteVideo.parentElement;
  if (peerCard) peerCard.appendChild(btn);
}

function closeEverything(stopLocalTracks = true) {
  manuallyClosed = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (peerLeftTimer) {
    clearTimeout(peerLeftTimer);
    peerLeftTimer = null;
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

// ===== UI 事件 =====

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

// ===== 启动 =====
startApp();
})();
