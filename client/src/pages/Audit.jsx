import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, EmptyState, Pagination } from '../components/ui.jsx';
import { fmtDateShort, fmtTime } from '../format.js';
import { useI18n } from '../i18n.jsx';

const ENTITIES = ['', 'user', 'patient', 'appointment', 'medical_record', 'invoice', 'doctor', 'service', 'branch', 'clinic', 'attachment'];
const ACTIONS = ['', 'auth', 'appointment', 'patient', 'record', 'invoice', 'payment', 'user', 'doctor', 'service', 'clinic', 'unavailability', 'attachment'];

/**
 * Audit trail (owner-only, server-enforced). Append-only: the UI has no
 * edit/delete anywhere — entries can only be viewed and filtered.
 */
export default function Audit() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ action: '', entity: '', from: '', to: '' });
  const [expanded, setExpanded] = useState(null);
  const { lang } = useI18n();

  const load = useCallback(async (p = 1) => {
    setError('');
    try {
      const qs = new URLSearchParams({ page: String(p), limit: '25' });
      if (filters.action) qs.set('action', filters.action);
      if (filters.entity) qs.set('entity', filters.entity);
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', `${filters.to}T23:59:59Z`);
      setData(await api(`/audit?${qs.toString()}`));
      setPage(p);
    } catch (e) { setError(e.message); }
  }, [filters]);

  useEffect(() => { load(1); /* eslint-disable-next-line */ }, []);

  const setF = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'سجل التدقيق' : 'Audit trail'}</h1>
          <div className="desc">{lang === 'ar' ? 'سجل غير قابل للتعديل/الحذف للإجراءات السريرية والمالية والإدارية.' : 'Append-only log of clinical, financial and administrative actions. Entries cannot be edited or deleted.'}</div>
        </div>
      </div>

      <div className="card mb-12">
        <div className="flex" style={{ padding: '14px 16px', gap: 10, flexWrap: 'wrap' }}>
          <select className="select" style={{ width: 'auto' }} value={filters.action} onChange={setF('action')} aria-label={lang === 'ar' ? 'تصفية حسب الإجراء' : 'Filter by action'}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a ? `${a}.*` : (lang === 'ar' ? 'كل الإجراءات' : 'All actions')}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} value={filters.entity} onChange={setF('entity')} aria-label={lang === 'ar' ? 'تصفية حسب الكيان' : 'Filter by entity'}>
            {ENTITIES.map((e) => <option key={e} value={e}>{e || (lang === 'ar' ? 'كل الكيانات' : 'All entities')}</option>)}
          </select>
          <label className="flex small muted" style={{ gap: 6 }}>{lang === 'ar' ? 'من' : 'From'}
            <input type="date" className="input" style={{ width: 'auto' }} value={filters.from} onChange={setF('from')} />
          </label>
          <label className="flex small muted" style={{ gap: 6 }}>{lang === 'ar' ? 'إلى' : 'To'}
            <input type="date" className="input" style={{ width: 'auto' }} value={filters.to} onChange={setF('to')} />
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => load(1)}>{lang === 'ar' ? 'تطبيق' : 'Apply'}</button>
        </div>
      </div>

      <div className="card">
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!error && (!data ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل سجل التدقيق…' : 'Loading audit trail…'} /> : data.items.length === 0 ? (
          <EmptyState icon="🛡️" title={lang === 'ar' ? 'لا توجد إدخالات مطابقة' : 'No matching entries'} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>{lang === 'ar' ? 'متى' : 'When'}</th><th className="hide-sm">{lang === 'ar' ? 'من' : 'Who'}</th><th>{lang === 'ar' ? 'الإجراء' : 'Action'}</th><th className="hide-sm">{lang === 'ar' ? 'الكيان' : 'Entity'}</th><th>{lang === 'ar' ? 'التفاصيل' : 'Details'}</th></tr></thead>
                <tbody>
                  {data.items.map((it) => (
                    <React.Fragment key={it.id}>
                      <tr className={it.details ? 'row-link' : ''} tabIndex={it.details ? 0 : -1} role="button" aria-expanded={expanded === it.id}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && it.details) { e.preventDefault(); setExpanded(expanded === it.id ? null : it.id); } }}
                        onClick={() => it.details && setExpanded(expanded === it.id ? null : it.id)}>
                        <td className="mono small">{fmtDateShort(it.created_at)} {fmtTime(it.created_at)}</td>
                        <td className="hide-sm">{it.actor_name || (lang === 'ar' ? 'النظام' : 'System')}<div className="muted small">{it.actor_email}</div></td>
                        <td><code className="mono small">{it.action}</code></td>
                        <td className="hide-sm">{it.entity ? <span className="muted small">{it.entity} #{it.entity_id ?? ''}</span> : '—'}</td>
                        <td className="muted small">{it.details ? (expanded === it.id ? '▾' : (lang === 'ar' ? '▸ عرض' : '▸ view')) : '—'}</td>
                      </tr>
                      {expanded === it.id && it.details && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                            <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(it.details, null, 2)}</pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pages={data.pages} total={data.total} onPage={load} />
          </>
        ))}
      </div>
    </div>
  );
}
