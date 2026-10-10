import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Badge, Spinner } from './ui.jsx';
import { STAGE_RULE_KEYS, STAGE_RULE_META } from '../lib/crm.js';

/**
 * Days without hearing from the customer before a deal in this stage counts as
 * stalled. Blank uses the pipeline-wide figure for the stage, shown faintly.
 */
function QuietAfter({ stage, fallback, onSave, disabled }) {
  const [value, setValue] = useState(stage.quiet_after_days ?? '');
  useEffect(() => setValue(stage.quiet_after_days ?? ''), [stage.quiet_after_days]);
  const commit = () => {
    const next = value === '' ? null : Math.round(Number(value));
    if (next === (stage.quiet_after_days ?? null)) return;
    if (next !== null && (!Number.isFinite(next) || next < 1 || next > 365)) {
      setValue(stage.quiet_after_days ?? '');
      return;
    }
    onSave(next);
  };
  return (
    <div className="row" style={{ gap: 6 }}>
      <input className="input" type="number" min="1" max="365" style={{ width: 76 }}
        value={value} placeholder={String(fallback)} disabled={disabled}
        aria-label={`Days before a deal in ${stage.name} counts as stalled`}
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <span className="small muted">days{value === '' ? ' (default)' : ''}</span>
    </div>
  );
}

/**
 * What each pipeline stage needs to see before a deal comes in, and before it
 * leaves.
 *
 * The checks run on the server whenever a deal moves forward — from the board,
 * the deal, the organization or the "mark as customer" button — so what is set
 * here is what everyone is held to. Moving backwards, or to Lost, is never
 * checked. A pipeline manager can move a deal without the evidence by writing
 * down why; that exception stays on the deal's history.
 */
export default function PipelineStageSettings() {
  const toast = useToast();
  const { settings } = useRefData();
  const [stages, setStages] = useState(null);
  const [saving, setSaving] = useState(null);
  const cadence = settings?.crm?.cadence || {};
  const fallbackFor = (stage) => Number(cadence.byStage?.[stage.slug]) || Number(cadence.engagementDays) || 7;

  const saveQuiet = async (stage, days) => {
    setSaving(`${stage.id}-quiet`);
    try {
      await api.updateAccountStage(stage.id, { quiet_after_days: days });
      setStages((list) => list.map((s) => (s.id === stage.id ? { ...s, quiet_after_days: days } : s)));
      toast.success(days === null
        ? `${stage.name} uses the default again`
        : `${stage.name}: stalled after ${days} days without hearing from them`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(null);
    }
  };

  const load = () => {
    api.accountStages({ active: 'all' })
      .then((r) => setStages(r.stages))
      .catch((err) => { toast.error(err); setStages([]); });
  };
  useEffect(load, []);

  const toggle = async (stage, field, rule) => {
    const current = stage[field] || [];
    const nextRules = current.includes(rule) ? current.filter((r) => r !== rule) : [...current, rule];
    setSaving(`${stage.id}-${field}-${rule}`);
    try {
      await api.updateAccountStage(stage.id, { [field]: nextRules });
      setStages((list) => list.map((s) => (s.id === stage.id ? { ...s, [field]: nextRules } : s)));
      toast.success(`${stage.name} updated`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(null);
    }
  };

  if (!stages) return <Spinner label="Loading the stages" />;

  return (
    <div className="card">
      <div className="card-head"><h2>Pipeline stages and the evidence they need</h2></div>
      <div className="card-pad stack">
        <div className="small muted">
          Checked whenever a deal moves forward. A finished task is never evidence: the proposal, the
          order or the meeting has to be on record. Moving back or to Lost is never blocked, and a
          pipeline manager can move a deal without the evidence by saying why — that stays on its history.
        </div>
        <div className="small muted">
          <strong>Stalled after</strong> counts days since the customer last responded — not since anyone
          touched the record. A deal marked as waiting until a date, on hold or in nurture is not flagged
          until its date.
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Stalled after</th>
                <th>To come in, a deal needs</th>
                <th>To move on, a deal needs</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage) => (
                <tr key={stage.id} className={stage.is_active ? '' : 'is-muted'}>
                  <td>
                    <Badge dot={stage.color}>{stage.name}</Badge>
                    {!stage.is_active && <div className="small muted">not in use</div>}
                  </td>
                  <td>
                    {stage.kind === 'open' ? (
                      <QuietAfter stage={stage} fallback={fallbackFor(stage)} disabled={saving !== null}
                        onSave={(days) => saveQuiet(stage, days)} />
                    ) : <span className="small muted">closed</span>}
                  </td>
                  {['entry_rules', 'exit_rules'].map((field) => (
                    <td key={field}>
                      {field === 'exit_rules' && stage.kind !== 'open' ? (
                        <span className="small muted">a closed stage is not left forward</span>
                      ) : (
                        <div className="rule-picks">
                          {STAGE_RULE_KEYS.map((rule) => (
                            <label key={rule} className="checklist-item" style={{ padding: '2px 0' }}
                              title={STAGE_RULE_META[rule].hint}>
                              <input type="checkbox"
                                checked={(stage[field] || []).includes(rule)}
                                disabled={saving !== null}
                                onChange={() => toggle(stage, field, rule)} />
                              <span className="small">{STAGE_RULE_META[rule].label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
