import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { getFaceLandmarker, LivenessDetector } from '../lib/liveness.js';

const FACEAPI_MODEL_URL = '/models';
const REQUIRED_BLINKS = 2;

/** Human-readable presentation for each internal capture state. */
const STATUS_META = {
  'loading-models': { label: 'Loading detection models…', variant: 'pill--busy' },
  ready: { label: 'Camera ready', variant: 'pill--info' },
  liveness: { label: 'Liveness check in progress', variant: 'pill--info' },
  capturing: { label: 'Capturing biometric signature…', variant: 'pill--busy' },
  done: { label: 'Face captured', variant: 'pill--success' },
  'no-face': { label: 'No face detected — try again', variant: 'pill--danger' },
  'mediapipe-missing': { label: 'Liveness engine failed to load', variant: 'pill--danger' },
  'descriptor-models-missing': { label: 'Identity models missing', variant: 'pill--warning' },
};

/**
 * Biometric capture with a real MediaPipe liveness challenge.
 *
 * Flow:
 *   1. Load face-api models (identity descriptor) + MediaPipe FaceLandmarker (liveness).
 *   2. Start webcam.
 *   3. Liveness challenge: user must blink `REQUIRED_BLINKS` times; MediaPipe blendshapes
 *      drive a blink state machine over the video stream.
 *   4. On pass, capture the 128-d face descriptor with face-api.
 *   5. Emit { faceDescriptor, livenessPassed: true }.
 */
export function FaceCapture({ onResult, onStatus }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const detectorRef = useRef(null);
  const landmarkerRef = useRef(null);

  const [status, setStatus] = useState('loading-models');
  const [blinks, setBlinks] = useState(0);
  const [faceApiReady, setFaceApiReady] = useState(false);
  const [mediapipeReady, setMediapipeReady] = useState(false);

  // Lift status changes so the parent stepper can reflect them.
  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  // Load both model sets up front.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const faceApi = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(FACEAPI_MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(FACEAPI_MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(FACEAPI_MODEL_URL),
      ])
        .then(() => !cancelled && setFaceApiReady(true))
        .catch(() => !cancelled && setFaceApiReady(false));

      const mp = getFaceLandmarker()
        .then((lm) => {
          if (cancelled) return;
          landmarkerRef.current = lm;
          setMediapipeReady(true);
        })
        .catch(() => !cancelled && setMediapipeReady(false));

      await Promise.allSettled([faceApi, mp]);
      if (!cancelled) setStatus('ready');
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      stopStream(videoRef.current);
    };
  }, []);

  async function startChallenge() {
    if (!mediapipeReady) {
      setStatus('mediapipe-missing');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    detectorRef.current = new LivenessDetector({ requiredBlinks: REQUIRED_BLINKS });
    setBlinks(0);
    setStatus('liveness');
    loop();
  }

  function loop() {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    const detector = detectorRef.current;
    if (!video || !landmarker || !detector) return;

    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, performance.now());
      const state = detector.update(result);
      setBlinks(state.blinks);

      if (state.passed) {
        setStatus('capturing');
        cancelAnimationFrame(rafRef.current);
        captureDescriptor();
        return;
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }

  async function captureDescriptor() {
    if (!faceApiReady) {
      // Liveness proven; identity models missing. Report so the flow can decide.
      setStatus('descriptor-models-missing');
      onResult({ faceDescriptor: null, livenessPassed: true });
      return;
    }
    const detection = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    stopStream(videoRef.current);

    if (!detection) {
      setStatus('no-face');
      return;
    }
    setStatus('done');
    onResult({ faceDescriptor: Array.from(detection.descriptor), livenessPassed: true });
  }

  const meta = STATUS_META[status] ?? { label: status, variant: '' };
  const isLive = status === 'liveness' || status === 'capturing';
  const busy = status === 'loading-models' || status === 'liveness' || status === 'capturing';

  return (
    <div>
      <div className={`camera${isLive ? ' is-live' : ''}`}>
        <video
          ref={videoRef}
          className="camera__video"
          width={320}
          height={240}
          muted
          playsInline
          style={{ display: isLive ? 'block' : 'none' }}
        />
        {isLive && <div className="camera__frame" aria-hidden="true" />}
        {isLive && (
          <span className="camera__badge">
            <span className="pill pill--danger pill--busy">
              <span className="pill__dot" />
              REC
            </span>
          </span>
        )}
        {!isLive && (
          <div className="camera__placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>{status === 'done' ? 'Capture complete' : 'Camera preview'}</span>
          </div>
        )}
      </div>

      {status === 'liveness' && (
        <div className="blink">
          <span className="blink__label">Blink {REQUIRED_BLINKS} times, looking at the camera</span>
          <span className="blink__dots">
            {Array.from({ length: REQUIRED_BLINKS }).map((_, i) => (
              <span key={i} className={`blink__dot${i < blinks ? ' is-on' : ''}`} />
            ))}
          </span>
        </div>
      )}

      <div className="row mt-1" style={{ justifyContent: 'space-between' }}>
        <span className={`pill ${meta.variant}`}>
          <span className="pill__dot" />
          {meta.label}
        </span>
        <button
          className="btn btn--primary btn--sm"
          onClick={startChallenge}
          disabled={busy}
        >
          {status === 'done' || status === 'no-face' ? 'Restart' : 'Start verification'}
        </button>
      </div>
    </div>
  );
}

function stopStream(video) {
  const stream = video?.srcObject;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}
