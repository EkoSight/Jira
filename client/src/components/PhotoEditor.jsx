import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Modal, Spinner } from './ui.jsx';
import { findFaces, loadFaceDetector } from '../lib/faceDetect.js';
import {
  DEFAULT_FIXES, FIX_LABELS, HEIC_HELP, applyFixes, centreCrop, clampCrop, cropForFace, cropPixels, isHeic, levelAngle, looksSmall, mainFace,
} from '../lib/photoEdit.js';
import { setPhotoVersion } from '../lib/photos.js';

const MAX_MB = 10;
const WORK_MAX = 2048;
const PREVIEW = 260;
const OUTPUT = 768;

/** Draws the crop, turned by angle, at size×size; optionally with the fixes. */
function render(source, crop, angle, size, fixes) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { cx, cy, side } = cropPixels(crop, source.width, source.height);
  const rad = (angle * Math.PI) / 180;
  // turning shows corners from outside the square: zoom in just enough to hide them
  const cover = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-rad);
  ctx.scale((size * cover) / side, (size * cover) / side);
  ctx.translate(-cx, -cy);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  if (fixes) {
    const img = ctx.getImageData(0, 0, size, size);
    applyFixes(img, fixes);
    ctx.putImageData(img, 0, 0);
    if (fixes.background) softenBackground(canvas, size);
  }
  return canvas;
}

/** A soft blur outside an oval around head and shoulders. No change to the person. */
function softenBackground(canvas, size) {
  const small = document.createElement('canvas');
  small.width = Math.max(8, Math.round(size / 16));
  small.height = small.width;
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const blurred = document.createElement('canvas');
  blurred.width = size;
  blurred.height = size;
  const b = blurred.getContext('2d');
  b.imageSmoothingQuality = 'high';
  b.drawImage(small, 0, 0, size, size);
  const keep = document.createElement('canvas');
  keep.width = size;
  keep.height = size;
  const k = keep.getContext('2d');
  k.drawImage(canvas, 0, 0);
  k.globalCompositeOperation = 'destination-in';
  k.save();
  k.translate(size / 2, size * 0.56);
  k.scale(1, 1.3);
  const g = k.createRadialGradient(0, 0, size * 0.2, 0, 0, size * 0.42);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.75, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  k.fillStyle = g;
  k.fillRect(-size, -size, size * 2, size * 2);
  k.restore();
  const ctx = canvas.getContext('2d');
  ctx.drawImage(blurred, 0, 0);
  ctx.drawImage(keep, 0, 0);
}

const toBlob = (canvas, type = 'image/jpeg', quality = 0.92) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the picture'))), type, quality));

/** Decodes a chosen file upright (EXIF rotation applied) into a canvas at most 2048 px across. */
async function decode(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(isHeic(file) ? HEIC_HELP : 'That file could not be opened as a picture. Use a JPEG, PNG or WebP photo.');
  }
  const scale = Math.min(1, WORK_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

/**
 * The photo editor. Choose or take a photo; the face is found and framed on
 * this device; gentle fixes can each be switched off; before and after side
 * by side; drag and zoom to adjust. Nothing is saved until Save.
 *
 * mode "own": the person's own photo. mode "suggest": an administrator
 * suggests one for target; it is used only if they accept it.
 */
export default function PhotoEditor({ onClose, onSaved, mode = 'own', target = null, startFrom = null, startEdit = null, notice }) {
  const toast = useToast();
  const { user } = useAuth();
  const [source, setSource] = useState(null); // the decoded picture (canvas)
  const [faces, setFaces] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [crop, setCrop] = useState(null);
  const [angle, setAngle] = useState(0);
  const [fixes, setFixes] = useState({ ...DEFAULT_FIXES });
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [small, setSmall] = useState(false);
  const beforeRef = useRef(null);
  const afterRef = useRef(null);
  const drag = useRef(null);
  const frame = useRef(0);

  const open = useCallback(async (file, edit = null) => {
    setError(null);
    setFaces(null);
    setChoosing(false);
    if (file.size > MAX_MB * 1024 * 1024) { setError(`That photo is larger than ${MAX_MB} MB. Choose a smaller one.`); return; }
    setStatus('Opening the photo…');
    try {
      const canvas = await decode(file);
      setSource(canvas);
      setSmall(looksSmall(canvas.width, canvas.height));
      if (edit?.crop) {
        // re-cropping the kept original: start where it was left
        setCrop(clampCrop(edit.crop, canvas.width, canvas.height));
        setAngle(edit.angle || 0);
        setFixes({ ...DEFAULT_FIXES, ...(edit.fixes || {}) });
        setStatus(null);
        return;
      }
      setCrop(centreCrop(canvas.width, canvas.height));
      setStatus('Finding your face… (the first time, this downloads about 3 MB)');
      let found = [];
      try { found = await findFaces(canvas); } catch { found = null; }
      setStatus(null);
      if (found === null) { setFaces([]); setError('The face finder could not start on this device. Drag and zoom to frame yourself.'); return; }
      setFaces(found);
      if (found.length === 1) {
        setCrop(cropForFace(found[0], canvas.width, canvas.height));
        setAngle(levelAngle(found[0].eyes));
      } else if (found.length > 1) {
        setChoosing(true);
        const best = mainFace(found, canvas.width, canvas.height);
        setCrop(cropForFace(best, canvas.width, canvas.height));
        setAngle(levelAngle(best.eyes));
      }
    } catch (err) {
      setStatus(null);
      setSource(null);
      setError(err.message);
    }
  }, []);

  useEffect(() => { if (startFrom) open(startFrom, startEdit); }, [startFrom, startEdit, open]);
  // start loading the face finder as soon as the editor opens
  useEffect(() => { loadFaceDetector().catch(() => {}); }, []);

  // previews, at most once a frame
  useEffect(() => {
    if (!source || !crop) return undefined;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const before = render(source, crop, angle, PREVIEW, null);
      const after = render(source, crop, angle, PREVIEW, fixes);
      for (const [ref, c] of [[beforeRef, before], [afterRef, after]]) {
        if (!ref.current) continue;
        const ctx = ref.current.getContext('2d');
        ctx.clearRect(0, 0, PREVIEW, PREVIEW);
        ctx.drawImage(c, 0, 0);
      }
    });
    return () => cancelAnimationFrame(frame.current);
  }, [source, crop, angle, fixes]);

  const move = (dx, dy) => setCrop((c) => {
    const { side } = cropPixels(c, source.width, source.height);
    return clampCrop({ ...c, x: c.x - (dx * side) / PREVIEW / source.width, y: c.y - (dy * side) / PREVIEW / source.height }, source.width, source.height);
  });
  const zoom = (factor) => setCrop((c) => clampCrop({ ...c, size: c.size * factor }, source.width, source.height));

  const pointers = useRef(new Map());
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current = { x: e.clientX, y: e.clientY, dist: null };
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (drag.current.dist) zoom(drag.current.dist / dist);
      drag.current.dist = dist;
      return;
    }
    move(e.clientX - drag.current.x, e.clientY - drag.current.y);
    drag.current = { x: e.clientX, y: e.clientY, dist: null };
  };
  const onPointerUp = (e) => { pointers.current.delete(e.pointerId); drag.current = null; };
  const onKeyDown = (e) => {
    const step = 6;
    const map = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (map[e.key]) { e.preventDefault(); move(...map[e.key]); }
    if (e.key === '+' || e.key === '=') zoom(0.95);
    if (e.key === '-') zoom(1.05);
  };

  const save = async () => {
    if (!source || !crop || saving) return;
    setSaving(true);
    try {
      const photo = await toBlob(render(source, crop, angle, OUTPUT, fixes));
      // the original, redrawn here: what is sent carries no hidden data, and the server re-encodes it again
      const original = await toBlob(source, 'image/jpeg', 0.9);
      const form = new FormData();
      form.append('photo', photo, 'photo.jpg');
      form.append('original', original, 'original.jpg');
      form.append('edit', JSON.stringify({ crop, angle, fixes, face: Boolean(faces?.length) }));
      if (mode === 'suggest' && note.trim()) form.append('note', note.trim());
      const r = await api.form(mode === 'suggest' ? `/photos/${target.id}/suggest` : '/photos/me', form);
      if (mode === 'own') setPhotoVersion(user.id, r.version);
      toast.success(mode === 'suggest' ? `Suggested to ${target.full_name}; it is used only if they accept it` : 'Photo saved');
      onSaved?.(r);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const fileInput = useRef(null);
  const cameraInput = useRef(null);
  const pick = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f); };

  return (
    <Modal
      title={mode === 'suggest' ? `Suggest a photo for ${target.full_name}` : 'Your profile photo'}
      size="lg"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!source || !crop || saving} onClick={save}>{saving ? 'Saving…' : mode === 'suggest' ? 'Send the suggestion' : 'Save'}</button>
      </>}
    >
      <div className="stack photo-editor">
        <p className="small muted photo-notice">{notice}</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>{source ? 'Choose another photo' : 'Choose a photo'}</button>
          <button type="button" className="btn" onClick={() => cameraInput.current?.click()}>Take a photo</button>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden onChange={pick} aria-label="Choose a photo" />
          <input ref={cameraInput} type="file" accept="image/*" capture="user" hidden onChange={pick} aria-label="Take a photo" />
        </div>
        {status && <div className="row small" style={{ gap: 8 }} role="status"><Spinner />{status}</div>}
        {error && <div className="mkt-callout is-warning small" role="alert">{error}</div>}
        {small && <div className="small warning-text">This photo is small, so it may look soft. A larger one will be sharper.</div>}

        {source && choosing && faces?.length > 1 && (
          <div className="stack-sm">
            <div className="small"><strong>There is more than one face.</strong> Which one is you?</div>
            <div className="photo-faces" style={{ aspectRatio: `${source.width} / ${source.height}` }}>
              <canvas ref={(el) => { if (el && source) { el.width = source.width; el.height = source.height; el.getContext('2d').drawImage(source, 0, 0); } }} aria-hidden="true" />
              {faces.map((f, i) => (
                <button key={i} type="button" className="photo-face" aria-label={`Face ${i + 1}`}
                  style={{ left: `${(f.x / source.width) * 100}%`, top: `${(f.y / source.height) * 100}%`, width: `${(f.w / source.width) * 100}%`, height: `${(f.h / source.height) * 100}%` }}
                  onClick={() => { setCrop(cropForFace(f, source.width, source.height)); setAngle(levelAngle(f.eyes)); setChoosing(false); }}>
                  <span>{i + 1}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {source && crop && !choosing && (
          <>
            {faces && faces.length === 0 && !error && <div className="small muted">No face was found, so the middle of the photo is used. Drag and zoom to frame yourself.</div>}
            <div className="photo-compare">
              <figure>
                <canvas ref={beforeRef} width={PREVIEW} height={PREVIEW} className="photo-preview" aria-label="Before the fixes" role="img" />
                <figcaption className="small muted">Before</figcaption>
              </figure>
              <figure>
                <canvas ref={afterRef} width={PREVIEW} height={PREVIEW} className="photo-preview is-live" tabIndex={0} role="img"
                  aria-label="After the fixes. Drag to move, pinch or use plus and minus to zoom, arrow keys to move."
                  onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                  onWheel={(e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.05 : 0.95); }} onKeyDown={onKeyDown} />
                <figcaption className="small muted">After · drag to move</figcaption>
              </figure>
            </div>
            <div className="grid-2">
              <Field label="Zoom">
                <input type="range" min="0.15" max="1" step="0.01" value={1.15 - crop.size}
                  onChange={(e) => setCrop((c) => clampCrop({ ...c, size: 1.15 - Number(e.target.value) }, source.width, source.height))} />
              </Field>
              <Field label={`Straighten (${angle > 0 ? '+' : ''}${Math.round(angle * 10) / 10}°)`}>
                <input type="range" min="-15" max="15" step="0.5" value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
              </Field>
            </div>
            <fieldset className="photo-fixes">
              <legend className="small">Fixes (switch off any you do not want)</legend>
              {FIX_LABELS.map(([k, label]) => (
                <label key={k} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" checked={Boolean(fixes[k])} onChange={(e) => setFixes((f) => ({ ...f, [k]: e.target.checked }))} />
                  {label}
                </label>
              ))}
              <span className="small muted">No smoothing or reshaping: only light, colour and focus.</span>
            </fieldset>
            {faces && faces.length > 1 && <button type="button" className="btn-link small" onClick={() => setChoosing(true)}>Choose a different face</button>}
            {mode === 'suggest' && (
              <Field label="A note for them (optional)"><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="From the team day photos" /></Field>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
