import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';

const MODEL_URL = '/models';

/**
 * Webcam face capture + basic liveness (blink detection via eye-aspect proxy).
 *
 * face-api.js model weights must be placed in `public/models/` (see README). Until then the
 * component reports a clear "models not loaded" state instead of crashing, so the rest of
 * the flow remains developable.
 */
export function FaceCapture({ onResult }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [modelsReady, setModelsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        if (!cancelled) setModelsReady(true);
      } catch {
        if (!cancelled) setModelsReady(false);
      }
    }
    loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startCamera() {
    setStatus('starting-camera');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setStatus('camera-ready');
  }

  async function capture() {
    if (!modelsReady) {
      setStatus('models-missing');
      return;
    }
    setStatus('detecting');
    const detection = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      setStatus('no-face');
      return;
    }

    // Liveness proxy: eye aspect ratio from landmarks (a full blink challenge is a TODO).
    const livenessPassed = detectBlinkProxy(detection.landmarks);

    setStatus('done');
    onResult({
      faceDescriptor: Array.from(detection.descriptor),
      livenessPassed,
    });
  }

  return (
    <div>
      <video ref={videoRef} width={320} height={240} muted playsInline style={{ background: '#000' }} />
      <div style={{ marginTop: 8 }}>
        <button onClick={startCamera}>Iniciar cámara</button>{' '}
        <button onClick={capture} disabled={status !== 'camera-ready' && status !== 'no-face'}>
          Capturar y validar
        </button>
      </div>
      <p>
        Estado: <strong>{status}</strong>
        {!modelsReady && ' — modelos face-api no cargados (ver README: public/models)'}
      </p>
    </div>
  );
}

/**
 * Very rough eye-aspect-ratio proxy. Returns true when eyes are open (face present and
 * alert). A production liveness check would require a temporal blink/movement challenge
 * (planned with MediaPipe).
 */
function detectBlinkProxy(landmarks) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const ear = (eye) => {
    const height = Math.abs(eye[1].y - eye[5].y) + Math.abs(eye[2].y - eye[4].y);
    const width = Math.abs(eye[0].x - eye[3].x) * 2;
    return width === 0 ? 0 : height / width;
  };
  const avg = (ear(leftEye) + ear(rightEye)) / 2;
  return avg > 0.15;
}
