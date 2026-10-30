import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../state/AppState.jsx';
import { EmptyState, Spinner } from '../components/ui.jsx';
import { Leads, MyDay } from '../components/sales/SalesWork.jsx';
import { Approvals, Calls, Reports } from '../components/sales/SalesInsight.jsx';
import { Imports, SalesSettings } from '../components/sales/SalesAdmin.jsx';
import SalesHelp from '../components/sales/SalesHelp.jsx';
import { forgetSalesMeta, useSalesMeta } from '../lib/sales.js';

/**
 * The sales CRM: the day's work, leads, approvals, calls, reports, imports,
 * settings and help. Organizations and deals live where they always have —
 * the Pipeline board and each organization's page — with a Sales section on
 * every deal.
 */
export default function Sales() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [version, setVersion] = useState(0);
  const { meta, error } = useSalesMeta(version);
  const tabs = [
    ['day', 'My Day'], ['leads', 'Leads'],
    ...(can('crm.approve') ? [['approvals', 'Approvals']] : []),
    ['calls', 'Calls'], ['reports', 'Reports'],
    ...(can('crm.import') ? [['imports', 'Imports']] : []),
    ...(can('crm.settings') || can('crm.routing') || can('crm.audit') || can('crm.automation') ? [['settings', 'Settings']] : []),
    ['help', 'Help'],
  ];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'day';
  const goTo = (key) => setParams({ tab: key }, { replace: true });
  const refresh = () => { forgetSalesMeta(); setVersion((v) => v + 1); };

  if (error) return <EmptyState title="The sales CRM could not load">{error.message}</EmptyState>;
  if (!meta) return <Spinner label="Opening the sales CRM" />;
  return (
    <div className="stack">
      <div className="row-between wrap">
        <h1>Sales CRM</h1>
        <div className="row small" style={{ gap: 10 }}>
          <Link to="/pipeline" className="btn-link">Deals board</Link>
          <span className="muted">B2B corporate and CSR / NGO · retailers, FPOs and individuals go to TeleCRM</span>
        </div>
      </div>
      <div className="tabs tabs-scroll" role="tablist" aria-label="Sales CRM">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => goTo(k)}>{l}</button>)}
      </div>
      {tab === 'day' && <MyDay meta={meta} />}
      {tab === 'leads' && <Leads meta={meta} />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'calls' && <Calls />}
      {tab === 'reports' && <Reports meta={meta} />}
      {tab === 'imports' && <Imports meta={meta} />}
      {tab === 'settings' && <SalesSettings meta={meta} onSaved={refresh} initial={params.get('section')} />}
      {tab === 'help' && <SalesHelp />}
    </div>
  );
}
