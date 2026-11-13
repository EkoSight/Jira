import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Spinner } from './ui.jsx';
import PhotoEditor from './PhotoEditor.jsx';
import { setPhotoVersion } from '../lib/photos.js';

const blobUrl = async (path) => {
  const token = api.token.get();
  const r = await fetch(api.url(path), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error('Could not load the picture');
  return r.blob();
};

function SuggestionPicture({ id }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false;
    let made = null;
    blobUrl(`/photos/suggestions/${id}/picture`).then((b) => { made = URL.createObjectURL(b); if (!gone) setUrl(made); }).catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url ? <img src={url} alt="The suggested photo" className="photo-suggestion" width={96} height={96} /> : <span className="photo-suggestion" />;
}

/** In My account: add, change, re-crop or delete my photo; answer a suggested one. */
export default function ProfilePhoto() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/photos/me').then(setData).catch(() => setData(false)), []);
  useEffect(() => { load(); }, [load]);
  if (data === false) return null;
  if (!data) return <div className="card card-pad"><Spinner label="Loading your photo" /></div>;
  const photo = data.photo;

  const recrop = async () => {
    setBusy(true);
    try {
      const blob = await blobUrl('/photos/me/original');
      setEditor({ startFrom: new File([blob], 'original.webp', { type: blob.type || 'image/webp' }), startEdit: photo.edit });
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Delete your photo? Every copy is removed and your initials are shown instead.')) return;
    setBusy(true);
    try { await api.del('/photos/me'); setPhotoVersion(user.id, null); toast.success('Photo deleted'); load(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const decide = async (id, accept) => {
    setBusy(true);
    try {
      const r = await api.post(`/photos/me/suggestions/${id}/${accept ? 'accept' : 'decline'}`);
      if (accept) setPhotoVersion(user.id, r.version);
      toast.success(accept ? 'That photo is now yours' : 'Declined; it has been deleted');
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head"><h2>Profile photo</h2></div>
      <div className="card-pad stack-sm">
        <div className="row wrap" style={{ gap: 16 }}>
          <Avatar userId={user.id} name={user.full_name} color={user.avatar_color} size={88} />
          <div className="stack-xs" style={{ flex: 1, minWidth: 220 }}>
            <span className="small">{photo ? 'Colleagues see this photo next to your name.' : 'You have no photo yet: colleagues see your initials.'}</span>
            <span className="small muted">{data.notice}</span>
            {!photo && data.last?.status === 'REMOVED' && (
              <span className="small warning-text">An administrator removed your last photo: {data.last.removed_reason}</span>
            )}
            <div className="row wrap" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setEditor({})}>{photo ? 'Change photo' : 'Add a photo'}</button>
              {photo?.has_original && <button type="button" className="btn btn-sm" disabled={busy} onClick={recrop}>Adjust the framing</button>}
              {photo && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={remove}>Delete photo</button>}
            </div>
          </div>
        </div>
        {data.proposals.map((p) => (
          <div key={p.id} className="mkt-callout small row wrap" style={{ gap: 12 }}>
            <SuggestionPicture id={p.id} />
            <div className="stack-xs" style={{ flex: 1, minWidth: 200 }}>
              <strong>{p.proposed_by_name || 'An administrator'} suggested this photo for you.</strong>
              {p.note && <span>“{p.note}”</span>}
              <span className="muted">It is not used unless you accept it. Declining deletes it.</span>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(p.id, true)}>Use it</button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(p.id, false)}>Decline</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editor && <PhotoEditor notice={data.notice} startFrom={editor.startFrom} startEdit={editor.startEdit} onClose={() => setEditor(null)} onSaved={load} />}
    </div>
  );
}

/** On someone's Team profile, for an administrator: suggest a photo, or remove theirs with a reason. */
export function PhotoAdminActions({ member, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { api.get('/photos/me').then((r) => setNotice(r.notice)).catch(() => {}); }, []);
  if (member.id === user.id) return null;
  const remove = async () => {
    const reason = window.prompt(`Why remove ${member.full_name}'s photo? They will be told.`);
    if (!reason || reason.trim().length < 3) return;
    try { await api.del(`/photos/${member.id}`, { reason: reason.trim() }); setPhotoVersion(member.id, null); toast.success('Photo removed; they have been told'); onChanged?.(); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack-xs">
      <span className="small muted">Photo</span>
      <div className="row wrap" style={{ gap: 8 }}>
        <Avatar userId={member.id} name={member.full_name} color={member.avatar_color} size={44} />
        <button type="button" className="btn btn-sm" onClick={() => setSuggesting(true)}>Suggest a photo</button>
        {member.photo_version && <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Remove photo…</button>}
      </div>
      <span className="small muted">A suggested photo is used only if {member.full_name.split(' ')[0]} accepts it.</span>
      {suggesting && <PhotoEditor mode="suggest" target={member} notice={notice} onClose={() => setSuggesting(false)} onSaved={onChanged} />}
    </div>
  );
}
