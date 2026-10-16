import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Spinner, EmptyState } from '../components/ui.jsx';
import { money, STATUS_META, STATUS_ORDER } from '../format.js';
import { IconDownload } from '../components/icons.jsx';

function RangePicker({ from, to, setFrom, setTo }) {
  return (
    <div className="flex">
      <input type="date" className="input" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
      <span className="muted">→</span>
      <input type="date" className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
    </div>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const [tab, setTab] = useState('appointments');
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [dataKey, setDataKey] = useState(''); // which tab/range the payload belongs to
  const [error, setError] = useState('');
  const [npPage, setNpPage] = useState(1); // new-patients pagination (server-bounded)

  const canRevenue = ['owner', 'accountant'].includes(user.role);
  const tabs = [['appointments', 'Appointments'], ...(canRevenue ? [['revenue', 'Revenue'], ['operations', 'Operations']] : []), ['patients', 'New patients']];

  useEffect(() => {
    // Bind payload to its request: a stale response must never render against
    // a different report shape (that crashed the whole app before).
    const key = `${tab}|${from}|${to}|${tab === 'patients' ? npPage : 1}`;
    let live = true;
    setData(null); setDataKey(''); setError('');
    (async () => {
      try {
        const pageQs = tab === 'patients' ? `&page=${npPage}&limit=50` : '';
        const res = await api(`/reports/${tab}?from=${from}&to=${to}${pageQs}`);
        if (!live) return;
        setData(res); setDataKey(key);
      } catch (e) { if (live) setError(e.message); }
    })();
    return () => { live = false; };
  }, [tab, from, to, npPage]);
  const show = (t) => data && dataKey === `${t}|${from}|${to}|${t === 'patients' ? npPage : 1}`;
  // any range/tab change resets the paginated view
  const goTab = (t) => { setNpPage(1); setTab(t); };
  const setFromP = (v) => { setNpPage(1); setFrom(v); };
  const setToP = (v) => { setNpPage(1); setTo(v); };

  const csvUrl = `/api/reports/${tab}?from=${from}&to=${to}&format=csv`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <div className="desc">Filter by date range and export results to CSV for spreadsheets.</div>
        </div>
        <div className="flex">
          <RangePicker from={from} to={to} setFrom={setFromP} setTo={setToP} />
          <a className="btn btn-outline" href={csvUrl}><IconDownload size={15}/> Export CSV</a>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(([v, l]) => <button key={v} className={`tab${tab === v ? ' on' : ''}`} onClick={() => goTab(v)}>{l}</button>)}
      </div>

      {error && <div className="form-error">{error}</div>}
      {!data && !error && <Spinner label="Crunching numbers…" />}

      {show('appointments') && (
        <div className="grid-2">
          <div className="card card-pad">
            <div className="card-title">Summary — {data.total} appointments</div>
            {data.total === 0 ? <EmptyState icon="📅" title="No appointments in range" /> : (
              <>
                {STATUS_ORDER.map((s) => data.by_status[s] ? (
                  <div key={s} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="flex" style={{ gap: 8 }}>
                      <i style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_META[s].color }} />
                      {STATUS_META[s].label}
                    </span>
                    <b>{data.by_status[s]}</b>
                  </div>
                ) : null)}
              </>
            )}
            <div className="card-title mt-18">By doctor</div>
            {Object.entries(data.by_doctor || {}).map(([d, c]) => (
              <div key={d} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span>{d}</span><b>{c}</b>
              </div>
            ))}
          </div>
          <div className="card" style={{ maxHeight: 520, overflow: 'auto' }}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Patient</th><th className="hide-sm">Doctor</th><th>Status</th></tr></thead>
                <tbody>
                  {data.appointments.slice(0, 60).map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.start_at.slice(0, 10)}</td>
                      <td>{a.patient_name}</td>
                      <td className="hide-sm">{a.doctor_name}</td>
                      <td style={{ color: STATUS_META[a.status]?.fg, fontWeight: 600 }}>{STATUS_META[a.status]?.label || a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {show('revenue') && (
        <div className="grid-2">
          <div className="card card-pad">
            <div className="card-title">Summary</div>
            <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Invoiced in range</span><b className="mono">{money(data.invoiced_cents)}</b></div>
            <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Collected in range</span><b className="mono" style={{ color: 'var(--ok)' }}>{money(data.collected_cents)}</b></div>
            <div className="flex-between" style={{ padding: '8px 0' }}><span>Outstanding (all time)</span><b className="mono" style={{ color: 'var(--danger)' }}>{money(data.outstanding_cents)}</b></div>
            <div className="card-title mt-18">Collected by method</div>
            {Object.entries(data.by_method || {}).map(([m, c]) => (
              <div key={m} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ textTransform: 'capitalize' }}>{m.replace('_', ' ')}</span><b className="mono">{money(c)}</b>
              </div>
            ))}
          </div>
          <div className="card" style={{ maxHeight: 520, overflow: 'auto' }}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Paid at</th><th>Invoice</th><th>Patient</th><th className="hide-sm">Method</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {(data.payments || []).slice(0, 60).map((p, i) => (
                    <tr key={i}>
                      <td className="mono">{p.paid_at.slice(0, 10)}</td>
                      <td className="mono">{p.invoice_no}</td>
                      <td>{p.patient_name}</td>
                      <td className="hide-sm" style={{ textTransform: 'capitalize' }}>{p.method.replace('_', ' ')}</td>
                      <td className="num mono">{money(p.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {show('operations') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="grid-2">
            <div className="card card-pad">
              <div className="card-title">Billed vs collected ({data.range.days} days)</div>
              <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Billed in range</span><b className="mono">{money(data.billed_cents)}</b></div>
              <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Collected in range</span><b className="mono" style={{ color: 'var(--ok)' }}>{money(data.collected_cents)}</b></div>
              <div className="flex-between" style={{ padding: '8px 0' }}><span>Outstanding (all unpaid)</span><b className="mono" style={{ color: 'var(--danger)' }}>{money(data.outstanding.total_cents)}</b></div>
              <div className="card-title mt-18">Receivables aging</div>
              {[['0–30 days', data.outstanding.aging.d0_30], ['31–60 days', data.outstanding.aging.d31_60], ['61–90 days', data.outstanding.aging.d61_90], ['90+ days', data.outstanding.aging.d90plus]].map(([l, c]) => (
                <div key={l} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                  <span>{l}</span><b className="mono">{money(c)}</b>
                </div>
              ))}
            </div>
            <div className="card card-pad">
              <div className="card-title">Utilization</div>
              <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Booked minutes</span><b className="mono">{data.utilization.booked_minutes}</b></div>
              <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><span>Capacity minutes (working hours)</span><b className="mono">{data.utilization.capacity_minutes}</b></div>
              <div className="flex-between" style={{ padding: '8px 0' }}><span>Utilization rate</span><b className="mono">{(data.utilization.rate * 100).toFixed(1)}%</b></div>
              <div className="card-title mt-18">Revenue by service</div>
              {data.revenue_by_service.length === 0 ? <div className="muted small">No invoiced services in range.</div> : data.revenue_by_service.slice(0, 8).map((s) => (
                <div key={s.service} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                  <span>{s.service}</span><b className="mono">{money(s.cents)}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Doctor</th><th className="num">Appointments</th><th className="num hide-sm">Completed</th><th className="num">No-shows</th><th className="num">Cancelled</th><th className="num">No-show rate</th><th className="num hide-sm">Booked min</th></tr></thead>
                <tbody>
                  {data.doctors.map((d) => (
                    <tr key={d.doctor_id}>
                      <td><b>{d.doctor_name}</b></td>
                      <td className="num">{d.total}</td>
                      <td className="num hide-sm">{d.completed}</td>
                      <td className="num" style={{ color: d.no_shows ? 'var(--danger)' : undefined }}>{d.no_shows}</td>
                      <td className="num">{d.cancelled}</td>
                      <td className="num mono">{(d.no_show_rate * 100).toFixed(1)}%</td>
                      <td className="num mono hide-sm">{d.booked_minutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {show('patients') && (
        <div className="card">
          {data.total === 0 ? <EmptyState icon="🧑‍🤝‍🧑" title="No new patients in range" /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Registered</th><th>MRN</th><th>Name</th><th className="hide-sm">DOB</th><th className="hide-sm">Gender</th><th>Phone</th></tr></thead>
                <tbody>
                  {(data.patients || []).map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.created_at.slice(0, 10)}</td>
                      <td className="mono">{p.mrn}</td>
                      <td><b>{p.first_name} {p.last_name}</b></td>
                      <td className="hide-sm">{p.dob || '—'}</td>
                      <td className="hide-sm" style={{ textTransform: 'capitalize' }}>{p.gender || '—'}</td>
                      <td>{p.phone || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex-between" style={{ padding: '10px 12px' }}>
                <span className="muted small">Page {data.page} of {data.pages} · {data.total} new patient(s) in range · newest first</span>
                <span className="flex" style={{ gap: 6 }}>
                  <button className="btn btn-outline btn-sm" disabled={data.page <= 1} onClick={() => setNpPage((n) => n - 1)}>← Prev</button>
                  <button className="btn btn-outline btn-sm" disabled={data.page >= data.pages} onClick={() => setNpPage((n) => n + 1)}>Next →</button>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
