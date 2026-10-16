import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { IconX } from './icons.jsx';

/**
 * Patient search-and-select combobox backed by /api/patients?search=
 */
export default function PatientSelect({ value, onChange }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const boxRef = useRef(null);
  // Chromium can retarget the trailing click of a down/up pair when the DOM
  // under the cursor is swapped synchronously by the selection handler — the
  // phantom click then lands on the clear button and undoes the selection.
  // Ignore clears fired within a beat of a selection.
  const lastSelectRef = useRef(0);

  useEffect(() => {
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!open) return;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api(`/patients?search=${encodeURIComponent(query)}&limit=8`);
        setResults(res.items);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  if (value) {
    return (
      <div className="combo-selected">
        <span>{value.first_name} {value.last_name} <span className="muted small">· {value.mrn}</span></span>
        <button type="button" className="icon-btn" aria-label="Clear patient"
          onClick={() => { if (Date.now() - lastSelectRef.current < 400) return; onChange(null); setQuery(''); }}><IconX size={15} /></button>
      </div>
    );
  }

  return (
    <div className="combo" ref={boxRef}>
      <input
        className="input"
        placeholder="Search patients by name, number or phone…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {open && (
        <div className="combo-list">
          {loading && <div className="combo-item"><span className="muted">Searching…</span></div>}
          {!loading && results?.length === 0 && (
            <div className="combo-item"><span className="muted">No matching patients. Register them on the Patients page first.</span></div>
          )}
          {!loading && results?.map((p) => (
            <div key={p.id} className="combo-item" onClick={() => { lastSelectRef.current = Date.now(); onChange(p); setOpen(false); }}>
              <span>{p.first_name} {p.last_name}</span>
              <span className="sub">{p.mrn}{p.phone ? ` · ${p.phone}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
