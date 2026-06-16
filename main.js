/**
 * 私密双人 WebRTC 网站：稳定性优化版 v3
 *
 * v3 改动（2026-06-16）— Air Writing 全面重写：
 * 1. 手势状态机：IDLE → HOVER → DRAWING → LOST，含 hysteresis + 连续帧确认
 * 2. 1€ Filter（One Euro Filter）坐标平滑，速度自适应
 * 3. 手掌尺度归一化的 pinch 距离检测
 * 4. quadraticCurveTo 曲线绘制 + 速度自适应线宽
 * 5. 最小点间距 + 最大跳跃距离自动断笔
 * 6. ?debug=gesture 调试覆盖层
 * 7. 用户可调参数面板（灵敏度/平滑度/笔粗细）
 * 8. 每帧 getImageData 优化（滤镜时不每帧读回）
 *
 * v2 改动（保留）：
 * - pcGeneration / ICE 容错 / peer-left 防抖 / debug=webrtc 参数
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

// --- Air Writing Settings DOM（由 buildAirWritingSettings 动态创建） ---
let awSensitivitySelect = null;
let awSmoothingSelect = null;
let awBrushWidthSelect = null;
let awModeSelect = null;

// ===== URL 参数 =====
const params = new URLSearchParams(window.location.search);
const roomID = params.get('room') || '888';
const token = params.get('token') || '';
const DEBUG_WEBRTC = params.get('debug') === 'webrtc' || params.get('debug') === '1';
const DEBUG_GESTURE = params.get('debug') === 'gesture' || params.get('debug') === '2';
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
let pcGeneration = 0;
let localStream = null;
let ws = null;

let myRole = null;
let manuallyClosed = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingCandidates = [];

let iceDisconnectTimer = null;
const ICE_DISCONNECT_GRACE_MS = 7000;

let peerLeftTimer = null;
const PEER_LEFT_GRACE_MS = 10000;

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

// =====================================================================
//  Air Writing v3 — Gesture Engine
// =====================================================================

// -- Gesture state machine --
const GESTURE_STATE = { IDLE: 'idle', HOVER: 'hover', DRAWING: 'drawing', LOST: 'lost' };
let gestureState = GESTURE_STATE.IDLE;
let gestureStateEnterTime = 0;
let pinchConfirmCounter = 0;
let releaseConfirmCounter = 0;
const PINCH_CONFIRM_FRAMES = 2;    // 连续 N 帧 pinch 才落笔
const RELEASE_CONFIRM_FRAMES = 3;  // 连续 N 帧松开才抬笔
let handLostTime = 0;
const HAND_LOST_TIMEOUT_MS = 200;  // 手丢失超过此时间→IDLE，自动抬笔

// -- Hand landmarker --
let handLandmarker = null;
let airWritingEnabled = false;
let landmarkerInitStarted = false;

// -- Strokes --
let strokes = [];           // strokes[s] = [{x, y, t}, ...]
let currentStroke = [];
let isDrawing = false;      // true when in DRAWING state

// -- Landmark data --
let lastLandmarks = null;       // most recent MediaPipe landmarks
let lastHandedness = null;      // 'Left' | 'Right'
let lastDetectionTime = 0;

// -- Pinch thresholds (normalized by hand scale, unitless ratio) --
// These are the KEY tunable parameters.
const PINCH_SETTINGS = {
  low:    { down: 0.28, up: 0.38 },   // 低灵敏度：需要捏很紧
  medium: { down: 0.32, up: 0.44 },   // 中灵敏度（默认）
  high:   { down: 0.38, up: 0.50 },   // 高灵敏度：轻捏即可
};
let pinchDownThreshold = PINCH_SETTINGS.medium.down;
let pinchUpThreshold = PINCH_SETTINGS.medium.up;

// -- Hand scale reference distance (landmark indices) --
const WRIST_IDX = 0;
const MIDDLE_MCP_IDX = 9;
const THUMB_TIP_IDX = 4;
const INDEX_TIP_IDX = 8;

// -- Coordinate Smoother: 1€ Filter (One Euro Filter) --
// Based on: "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input"
// https://cristal.univ-lille.fr/~casiez/1euro/
class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;   // Hz — minimum cutoff frequency
    this.beta = beta;             // speed coefficient
    this.dCutoff = dCutoff;       // derivative cutoff (Hz)
    this.xPrev = null;            // {x, y} previous filtered value
    this.dxPrev = null;           // {x, y} previous derivative
    this.lastTime = null;         // timestamp of last sample
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = null;
    this.lastTime = null;
  }

  /**
   * @param {number} t — timestamp in seconds
   * @param {{x: number, y: number}} raw
   * @returns {{x: number, y: number}}
   */
  filter(t, raw) {
    if (this.xPrev === null || this.lastTime === null) {
      // First sample — no filtering
      this.xPrev = { x: raw.x, y: raw.y };
      this.dxPrev = { x: 0, y: 0 };
      this.lastTime = t;
      return { x: raw.x, y: raw.y };
    }

    const dt = t - this.lastTime;
    if (dt <= 0) {
      return { x: this.xPrev.x, y: this.xPrev.y };
    }

    // Compute derivative (velocity)
    const dx = (raw.x - this.xPrev.x) / dt;
    const dy = (raw.y - this.xPrev.y) / dt;

    // Smooth derivative
    const alphaD = this.alpha(this.dCutoff, dt);
    const dxHat = this.dxPrev === null ? dx : alphaD * dx + (1 - alphaD) * this.dxPrev.x;
    const dyHat = this.dxPrev === null ? dy : alphaD * dy + (1 - alphaD) * this.dxPrev.y;

    // Compute speed
    const speed = Math.sqrt(dxHat * dxHat + dyHat * dyHat);

    // Adaptive cutoff
    const cutoff = this.minCutoff + this.beta * speed;

    // Filter the signal
    const alpha = this.alpha(cutoff, dt);
    const xHat = alpha * raw.x + (1 - alpha) * this.xPrev.x;
    const yHat = alpha * raw.y + (1 - alpha) * this.xPrev.y;

    // Update state
    this.xPrev = { x: xHat, y: yHat };
    this.dxPrev = { x: dxHat, y: dyHat };
    this.lastTime = t;

    return { x: xHat, y: yHat };
  }
}

// -- Smoother instances (one per coordinate dimension approach) --
let indexSmoother = null;
let thumbSmoother = null;

// -- Smoothing parameters (tunable by user) --
const SMOOTHING_PRESETS = {
  low:    { minCutoff: 1.8, beta: 5.0,  dCutoff: 1.0 },  // 更跟手，少平滑
  medium: { minCutoff: 1.0, beta: 10.0, dCutoff: 1.0 },  // 默认
  high:   { minCutoff: 0.6, beta: 20.0, dCutoff: 1.0 },  // 更平滑，少抖动
};
let smoothingPreset = SMOOTHING_PRESETS.medium;

// -- Line width presets --
const BRUSH_WIDTH_PRESETS = {
  thin:   { base: 2.0, min: 1.2, max: 3.0 },
  medium: { base: 3.0, min: 2.0, max: 5.0 },
  thick:  { base: 5.0, min: 3.0, max: 8.0 },
};
let brushWidthPreset = BRUSH_WIDTH_PRESETS.medium;

// -- Drawing config --
const MIN_POINT_DISTANCE = 2.0;    // px — skip points closer than this
const MAX_JUMP_DISTANCE = 60.0;    // px — split stroke on jumps larger than this
const MAX_SPEED_FOR_WIDTH = 1200;  // px/s — above this speed, line is thinnest

// -- Debug state --
let debugGestureInfo = {
  indexPos: null,
  thumbPos: null,
  pinchDist: 0,
  handScale: 0,
  normalizedPinch: 0,
  filteredPos: null,
};

// -- Hand detection frame skip --
let handDetectionFrameSkip = 0;
const HAND_DETECT_EVERY_N_FRAMES = 2;  // 每 N 帧跑一次手势检测（约 12-15 fps）

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

// ===== /config 加载 =====

async function loadConfig() {
  try {
    const res = await fetch('/config', { cache: 'no-store' });
    const config = await res.json();

    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      let iceServers = config.iceServers;

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
        console.log('TURN TCP-only 模式');
      }

      configuration = {
        iceServers: iceServers,
        iceCandidatePoolSize: 10,
      };

      if (FORCE_RELAY) {
        configuration.iceTransportPolicy = 'relay';
        console.log('强制 relay 模式');
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

    console.log('TURN 状态:', { hasTurn: config.hasTurn, turnUrlCount: config.turnUrlCount || 0, roomSecretEnabled: config.roomSecretEnabled });

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
    // Wait for video metadata before sizing canvas
    await new Promise((resolve) => {
      if (localVideo.videoWidth > 0) { resolve(); return; }
      localVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });
    startMagicCamera();
    outgoingStream = createOutgoingStream();
    buildAirWritingSettings();
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

  // Set canvas size to match video
  localCanvas.width = localVideo.videoWidth || 640;
  localCanvas.height = localVideo.videoHeight || 480;

  // Reset smoothers
  resetSmoothers();

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
  const ctx = canvasCtx;
  const now = performance.now();

  // --- 1) 绘制原始视频画面（可选镜像）---
  ctx.save();
  if (mirrorEnabled) {
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, cw, ch);
  ctx.restore();

  // --- 2) 应用滤镜（只在非 normal 模式处理）---
  if (filterMode !== 'normal') {
    // 对当前 canvas 内容做后处理
    const imageData = ctx.getImageData(0, 0, cw, ch);
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

    ctx.putImageData(imageData, 0, 0);
    // NOTE: 每帧 getImageData+putImageData 性能较重。如果不需要滤镜，
    // 请保持 filterMode='normal'，避免每帧 GPU→CPU 读回。
  }

  // --- 3) 手势检测（隔帧运行，节省性能）---
  handDetectionFrameSkip = (handDetectionFrameSkip + 1) % HAND_DETECT_EVERY_N_FRAMES;
  if (airWritingEnabled && handLandmarker && handDetectionFrameSkip === 0) {
    processHandDetection(now);
  }

  // --- 4) 绘制笔迹 ---
  drawStrokes(ctx, cw, ch);

  // --- 5) 调试覆盖层 ---
  if (DEBUG_GESTURE && airWritingEnabled) {
    drawDebugOverlay(ctx, now);
  }

  // --- 6) FPS ---
  frameCount++;
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
  // 重新绘制一帧确保笔迹在最上面
  const ctx = canvasCtx;
  if (ctx) {
    drawStrokes(ctx, localCanvas.width, localCanvas.height);
  }
  const link = document.createElement('a');
  link.download = 'capture-' + Date.now() + '.png';
  link.href = localCanvas.toDataURL('image/png');
  link.click();
}

function createOutgoingStream() {
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

// =====================================================================
//  Air Writing v3 — Core Engine
// =====================================================================

function resetSmoothers() {
  const s = smoothingPreset;
  indexSmoother = new OneEuroFilter(s.minCutoff, s.beta, s.dCutoff);
  thumbSmoother = new OneEuroFilter(s.minCutoff, s.beta, s.dCutoff);
}

function recalcSmoothers() {
  const s = smoothingPreset;
  if (indexSmoother) {
    indexSmoother.minCutoff = s.minCutoff;
    indexSmoother.beta = s.beta;
    indexSmoother.dCutoff = s.dCutoff;
  }
  if (thumbSmoother) {
    thumbSmoother.minCutoff = s.minCutoff;
    thumbSmoother.beta = s.beta;
    thumbSmoother.dCutoff = s.dCutoff;
  }
}

/**
 * Map a mediapipe landmark (normalized 0-1) to canvas pixel coordinates.
 * Handles mirror correctly.
 */
function landmarkToCanvas(landmark, cw, ch) {
  return {
    x: (mirrorEnabled ? (1 - landmark.x) : landmark.x) * cw,
    y: landmark.y * ch,
    z: landmark.z,
  };
}

/**
 * Compute Euclidean distance between two canvas-space points.
 */
function ptDist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute hand scale reference distance (wrist to middle finger MCP).
 * This is used to normalize pinch distance so it's scale-invariant.
 */
function computeHandScale(landmarks, cw) {
  const wrist = landmarkToCanvas(landmarks[WRIST_IDX], cw, 1);
  const middleMcp = landmarkToCanvas(landmarks[MIDDLE_MCP_IDX], cw, 1);
  return ptDist(wrist, middleMcp);
}

/**
 * Core gesture detection + state machine + stroke management.
 * Called every ~12-15 fps from drawLoop.
 */
function processHandDetection(now) {
  if (!handLandmarker || !airWritingEnabled || !localVideo || !localVideo.videoWidth) return;

  const cw = localCanvas.width;
  const ch = localCanvas.height;

  // Run detection
  let results;
  try {
    results = handLandmarker.detectForVideo(localVideo, now);
  } catch (e) {
    // Model error — treat as no hand
    results = null;
  }

  const hasHand = results && results.landmarks && results.landmarks.length > 0;

  // --- Handle hand lost ---
  if (!hasHand || !results.landmarks[0]) {
    handleHandLost(now);
    return;
  }

  // Hand detected — cancel lost timer
  handLostTime = 0;

  const landmarks = results.landmarks[0];
  const handedness = results.handedness && results.handedness[0]
    ? results.handedness[0][0].categoryName : null;

  lastLandmarks = landmarks;
  lastHandedness = handedness;
  lastDetectionTime = now;

  // Compute hand scale for normalization
  const handScale = computeHandScale(landmarks, cw);
  if (handScale < 5) {
    // Hand too small/edge — unreliable, treat as lost
    handleHandLost(now);
    return;
  }

  // Get raw finger positions
  const rawThumb = landmarkToCanvas(landmarks[THUMB_TIP_IDX], cw, ch);
  const rawIndex = landmarkToCanvas(landmarks[INDEX_TIP_IDX], cw, ch);

  // Apply 1€ filter smoothing
  const t = now / 1000;
  if (!indexSmoother) resetSmoothers();
  const smoothIndex = indexSmoother.filter(t, rawIndex);
  const smoothThumb = thumbSmoother.filter(t, rawThumb);

  // Raw pinch distance
  const rawPinchDist = ptDist(rawThumb, rawIndex);

  // Normalized pinch distance: divide by hand scale
  const normalizedPinch = handScale > 0 ? rawPinchDist / handScale : 1.0;

  // Draw point = midpoint between thumb and index tips (smoothed)
  const drawPoint = {
    x: (smoothIndex.x + smoothThumb.x) / 2,
    y: (smoothIndex.y + smoothThumb.y) / 2,
    t: now,
  };

  // --- State machine ---
  const wasDrawing = (gestureState === GESTURE_STATE.DRAWING);

  switch (gestureState) {
    case GESTURE_STATE.IDLE:
      // Hand just appeared, go to HOVER
      gestureState = GESTURE_STATE.HOVER;
      gestureStateEnterTime = now;
      pinchConfirmCounter = 0;
      releaseConfirmCounter = 0;
      break;

    case GESTURE_STATE.LOST:
      // Hand recovered from loss
      gestureState = GESTURE_STATE.HOVER;
      gestureStateEnterTime = now;
      pinchConfirmCounter = 0;
      releaseConfirmCounter = 0;
      break;

    case GESTURE_STATE.HOVER:
      if (normalizedPinch < pinchDownThreshold) {
        pinchConfirmCounter++;
        if (pinchConfirmCounter >= PINCH_CONFIRM_FRAMES) {
          // Transition to DRAWING
          gestureState = GESTURE_STATE.DRAWING;
          gestureStateEnterTime = now;
          pinchConfirmCounter = 0;
          releaseConfirmCounter = 0;
          // Start new stroke
          currentStroke = [];
          isDrawing = true;
          // Reset smoother for new stroke (soft reset — keep last pos to avoid jump)
        }
      } else {
        pinchConfirmCounter = Math.max(0, pinchConfirmCounter - 1);
      }
      break;

    case GESTURE_STATE.DRAWING:
      if (normalizedPinch > pinchUpThreshold) {
        releaseConfirmCounter++;
        if (releaseConfirmCounter >= RELEASE_CONFIRM_FRAMES) {
          // Transition to HOVER — lift pen
          gestureState = GESTURE_STATE.HOVER;
          gestureStateEnterTime = now;
          releaseConfirmCounter = 0;
          pinchConfirmCounter = 0;
          // Finalize stroke
          finalizeStroke();
        }
      } else {
        releaseConfirmCounter = Math.max(0, releaseConfirmCounter - 1);
      }
      break;
  }

  // --- If in DRAWING state, add point to current stroke ---
  if (gestureState === GESTURE_STATE.DRAWING) {
    addPointToStroke(drawPoint);
  }

  // --- Update debug info ---
  debugGestureInfo = {
    indexPos: smoothIndex,
    thumbPos: smoothThumb,
    pinchDist: rawPinchDist,
    handScale: handScale,
    normalizedPinch: normalizedPinch,
    filteredPos: drawPoint,
  };

  // --- Periodic console log ---
  if (DEBUG_GESTURE && now - (debugGestureInfo._lastLog || 0) > 500) {
    debugGestureInfo._lastLog = now;
    console.log('[gesture]', {
      state: gestureState,
      normalizedPinch: normalizedPinch.toFixed(3),
      thresholds: `down<${pinchDownThreshold.toFixed(2)} up>${pinchUpThreshold.toFixed(2)}`,
      handScale: handScale.toFixed(1),
      strokePoints: currentStroke.length,
      totalStrokes: strokes.length,
      handedness: handedness,
      fps: fpsDisplay ? fpsDisplay.textContent : 'N/A',
    });
  }
}

function handleHandLost(now) {
  lastLandmarks = null;
  lastHandedness = null;

  if (handLostTime === 0) {
    handLostTime = now;
  }

  const lostDuration = now - handLostTime;

  if (gestureState === GESTURE_STATE.DRAWING) {
    if (lostDuration > HAND_LOST_TIMEOUT_MS) {
      // Hand lost too long — lift pen and go to IDLE
      finalizeStroke();
      gestureState = GESTURE_STATE.IDLE;
      gestureStateEnterTime = now;
      pinchConfirmCounter = 0;
      releaseConfirmCounter = 0;
    } else {
      // Brief loss — go to LOST, keep stroke open
      gestureState = GESTURE_STATE.LOST;
    }
  } else {
    gestureState = GESTURE_STATE.IDLE;
  }
}

/**
 * Add a point to the current stroke with distance/jump checks.
 */
function addPointToStroke(pt) {
  if (currentStroke.length === 0) {
    currentStroke.push(pt);
    return;
  }

  const lastPt = currentStroke[currentStroke.length - 1];
  const dist = ptDist(pt, lastPt);

  // Skip if too close (prevents redundant points)
  if (dist < MIN_POINT_DISTANCE) return;

  // If jump is too big, finalize current stroke and start a new one
  // This prevents long lines when hand jumps across screen
  if (dist > MAX_JUMP_DISTANCE) {
    finalizeStroke();
    currentStroke = [];
    currentStroke.push(pt);
    return;
  }

  currentStroke.push(pt);
}

/**
 * Finalize current stroke: push to strokes array if it has enough points.
 */
function finalizeStroke() {
  isDrawing = false;
  if (currentStroke.length >= 2) {
    strokes.push(currentStroke.slice());
  }
  currentStroke = [];
}

/**
 * Draw all strokes with smooth curves and speed-adaptive line width.
 */
function drawStrokes(ctx, cw, ch) {
  if (!ctx) return;

  const widthPreset = brushWidthPreset;

  ctx.save();
  ctx.strokeStyle = '#FFD700';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 8;

  // Draw completed strokes
  for (let s = 0; s < strokes.length; s++) {
    drawSingleStroke(ctx, strokes[s], widthPreset);
  }

  // Draw current (in-progress) stroke
  if (isDrawing && currentStroke.length >= 2) {
    drawSingleStroke(ctx, currentStroke, widthPreset);
  }

  // Draw current stroke tip (single point, as a dot)
  if (isDrawing && currentStroke.length === 1) {
    const pt = currentStroke[0];
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, widthPreset.base / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD700';
    ctx.shadowColor = '#FFD700';
    ctx.shadowBlur = 6;
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Draw a single stroke with quadratic Bezier curves between midpoints.
 */
function drawSingleStroke(ctx, points, widthPreset) {
  if (points.length < 2) return;
  if (points.length === 2) {
    // Simple line for 2 points
    ctx.lineWidth = widthPreset.base;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.stroke();
    return;
  }

  // Use quadratic curves through midpoints
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;

    // Dynamic line width based on speed
    const dt = (points[i].t - points[i - 1].t) / 1000 || 0.016;
    const segDist = ptDist(points[i], points[i - 1]);
    const speed = dt > 0 ? segDist / dt : 0;
    const speedRatio = Math.min(1, speed / MAX_SPEED_FOR_WIDTH);
    // Slow → thick, Fast → thin
    const lineWidth = widthPreset.max - speedRatio * (widthPreset.max - widthPreset.min);

    ctx.lineWidth = lineWidth;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }

  // Final segment
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const dt = (last.t - prev.t) / 1000 || 0.016;
  const segDist = ptDist(last, prev);
  const speed = dt > 0 ? segDist / dt : 0;
  const speedRatio = Math.min(1, speed / MAX_SPEED_FOR_WIDTH);
  ctx.lineWidth = widthPreset.max - speedRatio * (widthPreset.max - widthPreset.min);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/**
 * Debug overlay drawn on canvas when ?debug=gesture
 */
function drawDebugOverlay(ctx, now) {
  const info = debugGestureInfo;
  ctx.save();
  ctx.font = '12px "Courier New", monospace';
  ctx.textBaseline = 'top';
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;

  // State badge (top-left)
  const stateColors = {
    [GESTURE_STATE.IDLE]: '#888',
    [GESTURE_STATE.HOVER]: '#4facfe',
    [GESTURE_STATE.DRAWING]: '#2ed573',
    [GESTURE_STATE.LOST]: '#ff4757',
  };
  const badgeColor = stateColors[gestureState] || '#888';
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(8, 8, 180, 105);
  ctx.fillStyle = badgeColor;
  ctx.fillText('State: ' + gestureState.toUpperCase(), 12, 12);
  ctx.fillStyle = '#fff';
  ctx.fillText('Pinch dist: ' + info.normalizedPinch.toFixed(3), 12, 28);
  ctx.fillText('Thresholds: ' + pinchDownThreshold.toFixed(2) + ' / ' + pinchUpThreshold.toFixed(2), 12, 42);
  ctx.fillText('Hand scale: ' + info.handScale.toFixed(1) + 'px', 12, 56);
  ctx.fillText('Strokes: ' + strokes.length + ' (+' + (isDrawing ? 1 : 0) + ' active)', 12, 70);
  ctx.fillText('Mirror: ' + (mirrorEnabled ? 'ON' : 'OFF') + ' | Sens: ' + (awSensitivitySelect ? awSensitivitySelect.value : 'med'), 12, 84);
  ctx.fillText('Smooth: ' + (awSmoothingSelect ? awSmoothingSelect.value : 'med') + ' | Brush: ' + (awBrushWidthSelect ? awBrushWidthSelect.value : 'med'), 12, 98);

  // Index finger position (green dot)
  if (info.indexPos) {
    ctx.fillStyle = '#2ed573';
    ctx.beginPath();
    ctx.arc(info.indexPos.x, info.indexPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Thumb position (red dot)
  if (info.thumbPos) {
    ctx.fillStyle = '#ff4757';
    ctx.beginPath();
    ctx.arc(info.thumbPos.x, info.thumbPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Line between thumb and index
    if (info.indexPos) {
      ctx.strokeStyle = gestureState === GESTURE_STATE.DRAWING ? '#2ed573' : '#ff6b6b';
      ctx.lineWidth = gestureState === GESTURE_STATE.DRAWING ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(info.indexPos.x, info.indexPos.y);
      ctx.lineTo(info.thumbPos.x, info.thumbPos.y);
      ctx.stroke();
    }
  }

  // Crosshair cursor at filtered draw position (HOVER mode only)
  if (gestureState === GESTURE_STATE.HOVER && info.filteredPos) {
    const p = info.filteredPos;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 12, p.y); ctx.lineTo(p.x + 12, p.y);
    ctx.moveTo(p.x, p.y - 12); ctx.lineTo(p.x, p.y + 12);
    ctx.stroke();
  }

  ctx.restore();
}

// ===== Air Writing Controls =====

function toggleAirWriting() {
  airWritingEnabled = !airWritingEnabled;
  airWritingToggle.classList.toggle('active', airWritingEnabled);

  if (airWritingEnabled) {
    gestureState = GESTURE_STATE.IDLE;
    gestureStateEnterTime = performance.now();
    pinchConfirmCounter = 0;
    releaseConfirmCounter = 0;
    handLostTime = 0;
    isDrawing = false;
    currentStroke = [];
    resetSmoothers();
    if (!handLandmarker && !landmarkerInitStarted) {
      initHandLandmarker();
    } else if (handLandmarker) {
      setStatus('Air Writing 已开启 — 捏合食指+拇指写字');
    } else {
      setStatus('正在加载手势模型...');
    }
  } else {
    // Turn off — finalize any open stroke
    if (isDrawing) finalizeStroke();
    isDrawing = false;
    currentStroke = [];
    gestureState = GESTURE_STATE.IDLE;
    setStatus('Air Writing 已关闭');
  }
}

async function initHandLandmarker() {
  if (landmarkerInitStarted) return;
  landmarkerInitStarted = true;

  try {
    setStatus('正在加载手势识别模型（约 5-10 秒）...');

    const tokenQs = token ? '?token=' + encodeURIComponent(token) : '';

    const visionModule = await import('./assets/mediapipe/vision_bundle.js' + tokenQs);
    const FilesetResolverClass = visionModule.FilesetResolver;
    const HandLandmarkerClass = visionModule.HandLandmarker;

    if (!FilesetResolverClass || !HandLandmarkerClass) {
      throw new Error('MediaPipe Vision 模块导出不完整，请检查 vision_bundle.js 是否完整');
    }

    const vision = await FilesetResolverClass.forVisionTasks('assets/mediapipe');

    const options = {
      baseOptions: {
        modelAssetPath: 'assets/mediapipe/hand_landmarker.task' + tokenQs,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    };

    try {
      handLandmarker = await HandLandmarkerClass.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn('GPU delegate 初始化失败，回退到 CPU:', gpuError);
      options.baseOptions.delegate = 'CPU';
      handLandmarker = await HandLandmarkerClass.createFromOptions(vision, options);
    }

    resetSmoothers();
    setStatus('手势模型已就绪 — 捏合食指+拇指开始写字 ✋');
  } catch (e) {
    console.error('HandLandmarker 初始化失败:', e);
    setStatus('手势识别加载失败：' + (e.message || '未知错误') + '。请刷新重试或检查模型文件是否完整。');
    airWritingEnabled = false;
    airWritingToggle.classList.remove('active');
    landmarkerInitStarted = false;
  }
}

function clearDrawing() {
  strokes = [];
  currentStroke = [];
  isDrawing = false;
  gestureState = GESTURE_STATE.IDLE;
  pinchConfirmCounter = 0;
  releaseConfirmCounter = 0;
  resetSmoothers();
}

function undoStroke() {
  if (isDrawing && currentStroke.length > 0) {
    // Currently drawing — discard current stroke but stay in DRAWING
    currentStroke = [];
    resetSmoothers();
    return;
  }

  if (strokes.length > 0) {
    strokes.pop();
  }
}

// ===== Air Writing Settings =====

function applySensitivity(value) {
  const setting = PINCH_SETTINGS[value] || PINCH_SETTINGS.medium;
  pinchDownThreshold = setting.down;
  pinchUpThreshold = setting.up;
  // Reset confirm counters to avoid unexpected state changes
  pinchConfirmCounter = 0;
  releaseConfirmCounter = 0;
  if (DEBUG_GESTURE) {
    console.log('[gesture] 灵敏度:', value, setting);
  }
}

function applySmoothing(value) {
  smoothingPreset = SMOOTHING_PRESETS[value] || SMOOTHING_PRESETS.medium;
  recalcSmoothers();
  if (DEBUG_GESTURE) {
    console.log('[gesture] 平滑度:', value, smoothingPreset);
  }
}

function applyBrushWidth(value) {
  brushWidthPreset = BRUSH_WIDTH_PRESETS[value] || BRUSH_WIDTH_PRESETS.medium;
  if (DEBUG_GESTURE) {
    console.log('[gesture] 笔粗细:', value, brushWidthPreset);
  }
}

function buildAirWritingSettings() {
  // Create inline settings row next to the magic bar
  const magicBar = document.querySelector('.magic-bar');
  if (!magicBar) return;

  // Check if already built
  if (document.getElementById('awSettingsRow')) return;

  const row = document.createElement('div');
  row.id = 'awSettingsRow';
  row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:6px 10px;background:rgba(255,255,255,0.04);backdrop-filter:blur(10px);border-radius:16px;border:1px solid rgba(255,255,255,0.08);font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;';

  const labelStyle = 'padding:2px 4px;';

  // Sensitivity
  const sensLabel = document.createElement('span');
  sensLabel.textContent = '灵敏度:';
  sensLabel.style.cssText = labelStyle;
  row.appendChild(sensLabel);

  awSensitivitySelect = document.createElement('select');
  awSensitivitySelect.innerHTML = '<option value="low">低</option><option value="medium" selected>中</option><option value="high">高</option>';
  awSensitivitySelect.style.cssText = 'background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer;';
  awSensitivitySelect.onchange = () => applySensitivity(awSensitivitySelect.value);
  row.appendChild(awSensitivitySelect);

  // Separator
  row.appendChild(sepDot());

  // Smoothing
  const smoothLabel = document.createElement('span');
  smoothLabel.textContent = '平滑:';
  smoothLabel.style.cssText = labelStyle;
  row.appendChild(smoothLabel);

  awSmoothingSelect = document.createElement('select');
  awSmoothingSelect.innerHTML = '<option value="low">低</option><option value="medium" selected>中</option><option value="high">高</option>';
  awSmoothingSelect.style.cssText = awSensitivitySelect.style.cssText;
  awSmoothingSelect.onchange = () => applySmoothing(awSmoothingSelect.value);
  row.appendChild(awSmoothingSelect);

  // Separator
  row.appendChild(sepDot());

  // Brush width
  const brushLabel = document.createElement('span');
  brushLabel.textContent = '笔粗:';
  brushLabel.style.cssText = labelStyle;
  row.appendChild(brushLabel);

  awBrushWidthSelect = document.createElement('select');
  awBrushWidthSelect.innerHTML = '<option value="thin">细</option><option value="medium" selected>中</option><option value="thick">粗</option>';
  awBrushWidthSelect.style.cssText = awSensitivitySelect.style.cssText;
  awBrushWidthSelect.onchange = () => applyBrushWidth(awBrushWidthSelect.value);
  row.appendChild(awBrushWidthSelect);

  // Insert after magic bar
  magicBar.parentNode.insertBefore(row, magicBar.nextSibling);
}

function sepDot() {
  const dot = document.createElement('span');
  dot.textContent = '·';
  dot.style.cssText = 'color:rgba(255,255,255,0.3);padding:0 2px;';
  return dot;
}

// ===== WebSocket (unchanged from v2) =====

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

// ===== 消息处理 (unchanged from v2) =====

async function handleMessage(message) {
  const msgGen = message.generation;

  switch (message.type) {
    case 'joined':
      myRole = message.role;
      debugLog('signal', 'joined role=' + myRole + ' peers=' + message.peers);
      setStatus(
        message.peers === 1
          ? '你已进入房间，等待对方进入...'
          : '双方已进入，正在建立连接...'
      );

      if (message.role === 'callee') {
        createPeerConnection();
      }
      return;

    case 'peer-joined':
      debugLog('signal', 'peer-joined');
      setStatus('对方已进入，正在发起连接...');

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

// ===== WebRTC 信令处理 (unchanged from v2) =====

async function handleSignalingMessage(message, msgGen) {
  try {
    if (message.offer) {
      if (msgGen !== undefined && msgGen < pcGeneration && peerConnection) {
        debugLog('stale', '忽略旧 generation offer: msgGen=' + msgGen + ' current=' + pcGeneration);
        return;
      }

      debugLog('signal', '收到 offer (gen=' + msgGen + ')');
      setStatus('收到对方邀请，正在回应...');

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

    if (message.answer) {
      if (!peerConnection) {
        console.warn('收到 answer 但 peerConnection 不存在，可能连接已关闭');
        return;
      }

      if (msgGen !== undefined && msgGen < pcGeneration) {
        debugLog('stale', '忽略旧 generation answer: msgGen=' + msgGen + ' current=' + pcGeneration);
        return;
      }

      debugLog('signal', '收到 answer (gen=' + msgGen + ')');

      if (peerConnection.signalingState !== 'have-local-offer') {
        debugLog('signal', '跳过 answer: 当前 signalingState=' + peerConnection.signalingState + '（不是 have-local-offer）');
        return;
      }

      setStatus('收到对方回应，正在建立连接...');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
      await flushPendingCandidates();
      return;
    }

    if (message.candidate) {
      if (msgGen !== undefined && msgGen < pcGeneration) {
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

// ===== RTCPeerConnection 创建 (unchanged from v2) =====

function createPeerConnection() {
  if (peerConnection) {
    if (peerConnection.signalingState !== 'closed') {
      debugLog('pc', '复用现有 PC (gen=' + pcGeneration + ')');
      return peerConnection;
    }
    debugLog('pc', '清理已 closed 的 PC');
    resetPeerConnection();
  }

  pcGeneration++;
  const myGen = pcGeneration;
  pendingCandidates = [];
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

  outgoingStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, outgoingStream);
  });

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

  peerConnection.onicegatheringstatechange = () => {
    debugLog('ice', 'gathering state:', peerConnection.iceGatheringState);
  };

  peerConnection.ontrack = event => {
    debugLog('track', 'ontrack 触发, streams=' + event.streams.length + ', track kind=' + event.track.kind);
    if (event.streams[0] && remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().then(() => {
        debugLog('track', 'remoteVideo.play() 成功');
      }).catch(err => {
        console.warn('remoteVideo.play() 被浏览器阻止:', err.name);
        showPlayButton();
      });
    }
    setStatus('已收到对方视频/音频');
  };

  peerConnection.oniceconnectionstatechange = async () => {
    const iceState = peerConnection.iceConnectionState;
    debugLog('ice', 'connection state:', iceState);

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

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    debugLog('pc', 'connection state:', state);

    if (state === 'connected') {
      setStatus('通话已连接 ✓');
    }

    if (state === 'disconnected') {
      debugLog('pc', 'connectionState=disconnected，等待 ICE 层恢复');
    }

    if (state === 'failed') {
      debugLog('pc', 'connectionState=failed，ICE 层应该已经处理');
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

// ===== makeCall / restartIce (unchanged from v2) =====

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

// ===== ICE candidate 管理 (unchanged from v2) =====

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

function sendSignal(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.warn('WebSocket 未连接，消息未发送:', payload);
  }
}

// ===== 统计信息 (unchanged from v2) =====

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

  const playBtn = document.getElementById('remotePlayBtn');
  if (playBtn) playBtn.remove();
}

function showPlayButton() {
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

  // --- Magic Camera ---
  captureBtn.onclick = capturePhoto;

  filterBtns.forEach(function(btn) {
    btn.onclick = function() {
      applyFilter(this.dataset.filter);
    };
  });

  // --- Mirror ---
  mirrorToggle.onclick = function() {
    mirrorEnabled = !mirrorEnabled;
    mirrorToggle.classList.toggle('active', mirrorEnabled);
  };

  // --- Air Writing ---
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
