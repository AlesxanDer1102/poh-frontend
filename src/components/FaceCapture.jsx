import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { getFaceLandmarker, LivenessDetector } from '../lib/liveness.js';

const FACEAPI_MODEL_URL = '/models';
const REQUIRED_BLINKS = 2;

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
export function FaceCapture({ onResult }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const detectorRef = useRef(null);
  const landmarkerRef = useRef(null);

  const [status, setStatus] = useState('loading-models');
  const [blinks, setBlinks] = useState(0);
  const [faceApiReady, setFaceApiReady] = useState(false);
  const [mediapipeReady, setMediapipeReady] = useState(false);

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

  return (
    <div>
      <video ref={videoRef} width={320} height={240} muted playsInline style={{ background: '#000' }} />
      <div style={{ marginTop: 8 }}>
        <button onClick={startChallenge} disabled={status === 'loading-models' || status === 'liveness'}>
          Iniciar validación
        </button>
      </div>
      {status === 'liveness' && (
        <p>
          Parpadeá {REQUIRED_BLINKS} veces mirando a la cámara — <strong>{blinks}/{REQUIRED_BLINKS}</strong>
        </p>
      )}
      <p>
        Estado: <strong>{status}</strong>
        {status === 'ready' && !mediapipeReady && ' — MediaPipe no cargó (ver consola)'}
        {status === 'ready' && !faceApiReady && ' — modelos face-api ausentes (public/models)'}
      </p>
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
