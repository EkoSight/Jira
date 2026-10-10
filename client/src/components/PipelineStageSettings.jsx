import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Badge, Spinner } from './ui.jsx';
import { STAGE_RULE_KEYS, STAGE_RULE_META } from '../lib/crm.js';

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
  const [stages, setStages] = useState(null);
  const [saving, setSaving] = useState(null);

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
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Stage</th>
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
