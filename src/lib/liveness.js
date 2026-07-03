import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

// WASM runtime and model. Default to the official CDN/model bucket; override via env to
// self-host under public/ for a fully offline / reproducible thesis setup.
const WASM_URL =
  import.meta.env.VITE_MEDIAPIPE_WASM_URL ??
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  import.meta.env.VITE_FACE_LANDMARKER_MODEL_URL ??
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarkerPromise;

/** Create (once) a FaceLandmarker configured for real-time video with blendshapes. */
export function getFaceLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: 'VIDEO',
        numFaces: 1,
      });
    })().catch((err) => {
      // reset so a later retry can re-attempt loading
      landmarkerPromise = undefined;
      throw err;
    });
  }
  return landmarkerPromise;
}

const EYES_CLOSED = 0.5; // blendshape score above which an eye counts as closed
const EYES_OPEN = 0.2; // score below which an eye counts as open again
const YAW_THRESHOLD = 0.25; // normalized head yaw for the "turn head" challenge

/**
 * Stateful liveness detector. Feed it MediaPipe results frame by frame; it counts blinks
 * and tracks head yaw. A challenge passes when the requested number of blinks is reached
 * (optionally combined with a head turn).
 */
export class LivenessDetector {
  constructor({ requiredBlinks = 2, requireHeadTurn = false } = {}) {
    this.requiredBlinks = requiredBlinks;
    this.requireHeadTurn = requireHeadTurn;
    this.reset();
  }

  reset() {
    this.blinks = 0;
    this.eyesOpen = true;
    this.headTurned = false;
    this.facePresent = false;
  }

  /**
   * @param {import('@mediapipe/tasks-vision').FaceLandmarkerResult} result
   * @returns {{ blinks: number, headTurned: boolean, facePresent: boolean, passed: boolean }}
   */
  update(result) {
    const shapes = result?.faceBlendshapes?.[0]?.categories;
    this.facePresent = Boolean(shapes);

    if (shapes) {
      const left = score(shapes, 'eyeBlinkLeft');
      const right = score(shapes, 'eyeBlinkRight');
      const blink = Math.max(left, right);

      // blink state machine: open -> closed -> open counts one blink
      if (this.eyesOpen && blink > EYES_CLOSED) {
        this.eyesOpen = false;
      } else if (!this.eyesOpen && blink < EYES_OPEN) {
        this.eyesOpen = true;
        this.blinks += 1;
      }

      if (this.requireHeadTurn && !this.headTurned) {
        const yaw = headYaw(result?.facialTransformationMatrixes?.[0]?.data);
        if (Math.abs(yaw) > YAW_THRESHOLD) this.headTurned = true;
      }
    }

    return {
      blinks: this.blinks,
      headTurned: this.headTurned,
      facePresent: this.facePresent,
      passed: this.isPassed(),
    };
  }

  isPassed() {
    const blinksOk = this.blinks >= this.requiredBlinks;
    const turnOk = !this.requireHeadTurn || this.headTurned;
    return blinksOk && turnOk;
  }
}

function score(categories, name) {
  const c = categories.find((x) => x.categoryName === name);
  return c ? c.score : 0;
}

/** Approximate head yaw (left/right rotation) from the 4x4 transformation matrix. */
function headYaw(matrix) {
  if (!matrix || matrix.length < 16) return 0;
  // element [2][0] of the row-major rotation part approximates sin(yaw)
  return matrix[8];
}
