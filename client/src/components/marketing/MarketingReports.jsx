import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { EmptyState, Icon, Spinner } from '../ui.jsx';
import { BarList, TrendChart } from '../charts.jsx';
import { formatDate } from '../../lib/format.js';
import { percent, personName, skipWords } from '../../lib/marketing.js';
import { Stat } from './parts.jsx';

function Download({ path, filename, label }) {
  const toast = useToast();
  return (
    <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.mkt.url(path), filename).catch((err) => toast.error(err))}>
      <Icon name="download" size={13} /> {label}
    </button>
  );
}

/** One campaign's results, each figure with where it comes from. */
export function CampaignReport({ campaignId }) {
  const { can } = useAuth();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => api.mkt.get(`/campaigns/${campaignId}/report`).then((r) => live && setReport(r)).catch((err) => live && setError(err));
    load();
    // a campaign still sending fills in as you watch
    const timer = setInterval(load, 30000);
    return () => { live = false; clearInterval(timer); };
  }, [campaignId]);

  if (error) return <EmptyState title="The report could not load">{error.message}</EmptyState>;
  if (!report) return <Spinner label="Counting" />;
  const t = report.totals;
  const r = report.rates;
  const base = report.base_label;
  const timeline = report.timeline.map((p) => ({ hour: p.hour, opens: p.opens, clicks: p.clicks }));

  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="Recipients" value={t.recipients} note={t.waiting ? `${t.waiting} still waiting to go` : `${t.sent} handed to the provider`} />
        <Stat label="Delivered" value={t.delivered === null ? '—' : t.delivered}
          note={t.delivered === null ? 'Not reported by this provider' : `${percent(r.delivery)} of those sent`} />
        <Stat label="Opened" value={t.unique_opens} note={`${percent(r.open)} of ${base}${t.total_opens > t.unique_opens ? ` · ${t.total_opens} opens in all` : ''}`} />
        <Stat label="Clicked" value={t.unique_clicks} note={`${percent(r.click)} of ${base} · ${percent(r.click_to_open)} of openers`} />
        <Stat label="Replied" value={t.replies} note={percent(r.reply)} />
        <Stat label="Converted" value={t.conversions} note={t.conversion_value ? `₹${Number(t.conversion_value).toLocaleString('en-IN')} recorded` : percent(r.conversion)} />
        <Stat label="Bounced" value={t.bounces} note={`${t.hard_bounces} permanent · ${t.soft_bounces} temporary`} tone={t.hard_bounces ? 'critical' : undefined} />
        <Stat label="Unsubscribed" value={t.unsubscribes} note={percent(r.unsubscribe)} />
        <Stat label="Marked as spam" value={t.complaints} note={t.complaints ? 'Keep this under 0.1%' : 'None'} tone={t.complaints ? 'critical' : undefined} />
        <Stat label="Not sent" value={t.skipped + t.failed} note={`${t.skipped} skipped · ${t.failed} failed`} />
      </div>

      <div className="grid-2">
        <div className="card card-pad">
          <div className="row-between" style={{ marginBottom: 8 }}><h3>Opens and clicks by hour</h3><span className="small muted">people only</span></div>
          {timeline.length >= 2
            ? <TrendChart data={timeline} xKey="hour" series={[{ key: 'opens', label: 'Opens' }, { key: 'clicks', label: 'Clicks' }]} ariaLabel="Opens and clicks per hour" />
            : <div className="empty small">{timeline.length ? `So far all within one hour: ${timeline[0].opens} open${timeline[0].opens === 1 ? '' : 's'}, ${timeline[0].clicks} click${timeline[0].clicks === 1 ? '' : 's'}.` : 'No opens or clicks yet.'}</div>}
        </div>
        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Links clicked</h3>
          <BarList items={report.links.map((l) => ({ id: l.id, label: l.url.replace(/^https?:\/\//, ''), value: l.people }))} emptyText="No clicks yet" />
          {report.links.some((l) => l.automatic) && (
            <div className="small muted" style={{ marginTop: 6 }}>
              {report.links.reduce((n, l) => n + l.automatic, 0)} more clicks were made by link scanners and are not counted.
            </div>
          )}
        </div>
      </div>

      {report.variants.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>A/B test</h3>{report.campaign.ab_test?.winner && <span className="badge badge-good">Version {report.campaign.ab_test.winner} won</span>}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Version</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Clicked</th><th className="num">Replied</th><th className="num">Converted</th></tr></thead>
              <tbody>
                {report.variants.map((v) => (
                  <tr key={v.variant}>
                    <td>{v.variant}</td><td className="num">{v.sent}</td>
                    <td className="num">{v.opened} <span className="muted">({percent(v.sent ? (v.opened / v.sent) * 100 : null)})</span></td>
                    <td className="num">{v.clicked} <span className="muted">({percent(v.sent ? (v.clicked / v.sent) * 100 : null)})</span></td>
                    <td className="num">{v.replied}</td><td className="num">{v.converted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Follow-up tasks made</h3><span className="small muted">{report.followups.length}</span></div>
          {report.followups.length === 0 ? <div className="empty small">None yet. Replies, conversions and (if switched on) clicks create them.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Person</th><th>Why</th><th>Task</th><th>With</th></tr></thead>
                <tbody>
                  {report.followups.map((f) => (
                    <tr key={f.id}>
                      <td>{personName(f)}</td><td>{f.reason.toLowerCase()}</td>
                      <td>{f.task_id ? <Link className="task-ref" to={`?task=${f.task_id}`}>{f.task_ref}</Link> : '—'} {f.task_stage === 'done' && <span className="badge badge-good">done</span>}</td>
                      <td>{f.assignee_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Not sent, and why</h3>
          {report.skipped.length === 0 ? <div className="empty small">Everyone due an email was sent one.</div>
            : <BarList items={report.skipped.map((s) => ({ label: skipWords(s.skip_reason), value: s.n }))} />}
        </div>
      </div>

      <div className="card card-pad stack-sm">
        <h3>Where these numbers come from</h3>
        <ul className="small dim mkt-notes">
          {Object.entries(report.sources).map(([k, v]) => <li key={k}><strong style={{ textTransform: 'capitalize' }}>{k}</strong>: {v}</li>)}
        </ul>
        <details>
          <summary className="small" style={{ cursor: 'pointer' }}>What tracking cannot see</summary>
          <ul className="small dim mkt-notes">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
        {can('marketing.export') && (
          <div className="row wrap">
            <Download path={`/campaigns/${campaignId}/recipients.csv`} filename={`campaign-${campaignId}-recipients.csv`} label="Recipients (CSV)" />
            <Download path={`/campaigns/${campaignId}/events.csv`} filename={`campaign-${campaignId}-events.csv`} label="Every event (CSV)" />
          </div>
        )}
      </div>
    </div>
  );
}

/** One audience, or all: size, growth, sources, engagement and recent campaigns. */
export function AudienceReport({ report }) {
  if (!report) return null;
  const s = report.status || {};
  const growth = report.growth.map((g) => ({ week: g.week, joined: g.joined, left: g.left }));
  const sourceWords = { MANUAL: 'Added by hand', IMPORT: 'Import', FORM: 'Signup form', CRM_SYNC: 'From the pipeline', AUTOMATION: 'Automation' };
  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="Subscribed" value={s.SUBSCRIBED || 0} tone="good" />
        <Stat label="Waiting to confirm" value={s.PENDING || 0} />
        <Stat label="Unsubscribed" value={s.UNSUBSCRIBED || 0} />
        <Stat label="Bounced" value={s.CLEANED || 0} />
      </div>
      <div className="grid-2">
        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Joined and left, by week</h3>
          <TrendChart data={growth} xKey="week" series={[{ key: 'joined', label: 'Joined' }, { key: 'left', label: 'Left' }]} ariaLabel="People joining and leaving per week" />
        </div>
        <div className="card card-pad stack">
          <div>
            <h3 style={{ marginBottom: 8 }}>How engaged</h3>
            <BarList items={['High', 'Medium', 'Low', 'None yet'].map((band) => ({ label: band, value: report.engagement.find((e) => e.band === band)?.n || 0 }))} emptyText="Nobody subscribed yet" />
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Where they came from</h3>
            <BarList items={report.sources.map((x) => ({ label: sourceWords[x.source] || x.source, value: x.n }))} emptyText="Nobody subscribed yet" />
          </div>
        </div>
      </div>
      {report.places.length > 0 && (
        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Where they are</h3>
          <BarList items={report.places.map((p) => ({ label: p.state, value: p.n }))} />
        </div>
      )}
      <div className="card">
        <div className="card-head"><h3>Recent campaigns</h3></div>
        {report.campaigns.length === 0 ? <div className="empty small">No campaigns sent yet.</div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Campaign</th><th>Started</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Clicked</th><th className="num">Unsubscribed</th></tr></thead>
              <tbody>
                {report.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td><td>{formatDate(c.started_at)}</td><td className="num">{c.sent}</td>
                    <td className="num">{percent(c.open_rate)}</td><td className="num">{percent(c.click_rate)}</td><td className="num">{c.unsubscribed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
