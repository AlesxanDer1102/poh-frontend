import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { getFaceLandmarker, LivenessDetector } from '../lib/liveness.js';

const FACEAPI_MODEL_URL = '/models';
const SAMPLE_GAP_MS = 250; // pause between extra samples taken after the blinks
const TIMEOUT_MARGIN_MS = 1000; // give up this long before the server's challenge window ends

/** Human-readable presentation for each internal capture state. */
const STATUS_META = {
  'loading-models': { label: 'Loading detection models…', variant: 'pill--busy' },
  ready: { label: 'Camera ready', variant: 'pill--info' },
  'requesting-challenge': { label: 'Requesting challenge…', variant: 'pill--busy' },
  liveness: { label: 'Liveness check in progress', variant: 'pill--info' },
  done: { label: 'Face captured', variant: 'pill--success' },
  timeout: { label: 'Challenge timed out — try again', variant: 'pill--danger' },
  'camera-error': { label: 'Camera unavailable', variant: 'pill--danger' },
  'challenge-error': { label: 'Could not get a challenge', variant: 'pill--danger' },
  'mediapipe-missing': { label: 'Liveness engine failed to load', variant: 'pill--danger' },
  'descriptor-models-missing': { label: 'Identity models missing', variant: 'pill--warning' },
};

const RESTARTABLE = ['done', 'timeout', 'camera-error', 'challenge-error'];

/**
 * Biometric capture with a real MediaPipe liveness challenge, bound to the identity capture.
 *
 * Flow:
 *   1. Load face-api models (identity descriptor) + MediaPipe FaceLandmarker (liveness).
 *   2. On start, ask the parent for a server challenge (`getChallenge`): the number of
 *      blinks, the sample count range and the time window all come from the server.
 *   3. Start the webcam. MediaPipe blendshapes drive a blink state machine over the video
 *      stream; DURING that same loop, face-api descriptors are sampled from the same stream:
 *      one before the first blink and one right after each blink (so at least one lies
 *      between blinks), plus extra samples if needed to reach the server's minimum.
 *   4. Emit { samples: [{ descriptor, t }] }, `t` = ms since challenge start.
 *
 * Client-side liveness only: the server can check the samples are consistent and
 * time-plausible, but cannot tell a live face from an injected video stream.
 */
export function FaceCapture({ getChallenge, onResult, onStatus }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const runRef = useRef(0); // id of the active challenge run; bumping it cancels the loop
  const landmarkerRef = useRef(null);

  const [status, setStatus] = useState('loading-models');
  const [blinks, setBlinks] = useState(0);
  const [requiredBlinks, setRequiredBlinks] = useState(0);
  const [sampleCount, setSampleCount] = useState(0);
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
      runRef.current += 1;
      cancelAnimationFrame(rafRef.current);
      stopStream(videoRef.current);
    };
  }, []);

  async function startChallenge() {
    if (!mediapipeReady) {
      setStatus('mediapipe-missing');
      return;
    }
    if (!faceApiReady) {
      // Without face-api there is nothing to sample; let the parent explain it.
      setStatus('descriptor-models-missing');
      onResult({ samples: null });
      return;
    }

    const runId = ++runRef.current;
    const active = () => runRef.current === runId;

    setStatus('requesting-challenge');
    let challenge;
    try {
      challenge = await getChallenge();
    } catch {
      if (active()) setStatus('challenge-error'); // the parent reports the details
      return;
    }
    if (!active()) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (!videoRef.current || !active()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    } catch {
      if (active()) setStatus('camera-error');
      return;
    }

    setBlinks(0);
    setSampleCount(0);
    setRequiredBlinks(challenge.liveness.requiredBlinks);
    setStatus('liveness');

    const samples = await runChallenge(challenge.liveness, active);
    stopStream(videoRef.current);
    if (!active()) return;

    if (!samples) {
      setStatus('timeout');
      return;
    }
    setStatus('done');
    onResult({ samples });
  }

  /**
   * Blink loop + descriptor sampling on the same video stream.
   * @returns {Promise<Array<{descriptor:number[], t:number}> | null>} null on timeout/cancel
   */
  async function runChallenge(params, active) {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    const detector = new LivenessDetector({ requiredBlinks: params.requiredBlinks });
    const deadline = params.maxDurationMs - TIMEOUT_MARGIN_MS;
    const start = performance.now();
    const samples = [];
    let sampledAtBlinks = -1; // blink count when the last sample was taken

    const timedOut = () => performance.now() - start > deadline;

    /** Take one descriptor from the current frame; false if no face was found. */
    const takeSample = async () => {
      const t = Math.round(performance.now() - start);
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detection) return false;
      const prev = samples.length ? samples[samples.length - 1].t : -1;
      samples.push({ descriptor: Array.from(detection.descriptor), t: Math.max(t, prev + 1) });
      setSampleCount(samples.length);
      return true;
    };

    // Phase 1: blinks. Sample once with open eyes at the start and once after every blink.
    while (active()) {
      if (timedOut()) return null;
      if (video.readyState >= 2) {
        const state = detector.update(landmarker.detectForVideo(video, performance.now()));
        setBlinks(state.blinks);

        const due = state.facePresent && detector.eyesOpen && state.blinks > sampledAtBlinks;
        if (due && samples.length < params.maxSamples && (await takeSample())) {
          sampledAtBlinks = state.blinks;
        }
        if (state.passed) break;
      }
      await nextFrame(rafRef);
    }
    if (!active()) return null;

    // Phase 2: top up to the server's minimum, and make sure the last sample is not earlier
    // than the minimum challenge duration.
    const target = Math.min(params.maxSamples, Math.max(params.minSamples, 1 + params.requiredBlinks));
    while (active() && (samples.length < target || samples[samples.length - 1].t < params.minDurationMs)) {
      if (timedOut()) return null;
      await sleep(SAMPLE_GAP_MS);
      if (samples.length >= params.maxSamples) samples.pop(); // replace the last one with a later one
      await takeSample();
    }
    return active() ? samples : null;
  }

  const meta = STATUS_META[status] ?? { label: status, variant: '' };
  const isLive = status === 'liveness';
  const busy = status === 'loading-models' || status === 'requesting-challenge' || status === 'liveness';

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
          <span className="blink__label">
            Blink {requiredBlinks} times, looking at the camera ({sampleCount} sample{sampleCount === 1 ? '' : 's'} captured)
          </span>
          <span className="blink__dots">
            {Array.from({ length: requiredBlinks }).map((_, i) => (
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
          {RESTARTABLE.includes(status) ? 'Restart' : 'Start verification'}
        </button>
      </div>
    </div>
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = (rafRef) => new Promise((resolve) => (rafRef.current = requestAnimationFrame(resolve)));

function stopStream(video) {
  const stream = video?.srcObject;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}
