/**
 * Finds faces in a picture, in the browser. MediaPipe's face detector (only
 * where a face is, never who it is); its engine and model are served by
 * TaskFlow itself, so the photo never leaves the device while it is edited.
 * Loaded the first time the photo editor needs it (about 3 MB, then kept).
 */
/* global __MEDIAPIPE_BASE__ */
let detector = null;

export function loadFaceDetector() {
  if (!detector) {
    detector = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const base = `${import.meta.env.BASE_URL}${__MEDIAPIPE_BASE__}`;
      const fileset = await FilesetResolver.forVisionTasks(base);
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}vendor/mediapipe/blaze_face_short_range.tflite`, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
    })().catch((err) => { detector = null; throw err; });
  }
  return detector;
}

/**
 * The faces in a canvas, in its pixels: { x, y, w, h, score, eyes: { right, left } }.
 * Large pictures are looked at at most 1024 px across, for speed.
 */
export async function findFaces(canvas) {
  const d = await loadFaceDetector();
  const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
  let input = canvas;
  if (scale < 1) {
    input = document.createElement('canvas');
    input.width = Math.round(canvas.width * scale);
    input.height = Math.round(canvas.height * scale);
    input.getContext('2d').drawImage(canvas, 0, 0, input.width, input.height);
  }
  const result = d.detect(input);
  return (result.detections || []).map((det) => {
    const b = det.boundingBox;
    const kp = det.keypoints || [];
    const point = (p) => (p ? { x: p.x * input.width / scale, y: p.y * input.height / scale } : null);
    return {
      x: b.originX / scale, y: b.originY / scale, w: b.width / scale, h: b.height / scale,
      score: det.categories?.[0]?.score ?? null,
      // MediaPipe's order: the person's right eye, then left eye
      eyes: { right: point(kp[0]), left: point(kp[1]) },
    };
  }).sort((a, b) => a.x - b.x);
}
