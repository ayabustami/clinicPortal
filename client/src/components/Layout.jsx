import React, { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import {
  IconDashboard, IconCalendar, IconUsers, IconSteth, IconFileText, IconInvoice,
  IconChart, IconSettings, IconBuilding, IconMenu, IconLogout, IconX, IconTooth, IconPlus, IconQueue,
  IconGrid, IconShield, IconClock, IconGlobe, IconUser,
} from './icons.jsx';

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: IconDashboard, roles: null, section: 'nav.overview' },
  { to: '/appointments', key: 'nav.appointments', icon: IconCalendar, roles: null, section: 'nav.overview' },
  { to: '/waiting-room', key: 'nav.waitingRoom', icon: IconQueue, roles: ['owner', 'receptionist', 'doctor'], section: 'nav.overview' },
  { to: '/my-day', key: 'nav.myday', icon: IconClock, roles: ['doctor'], section: 'nav.overview' },
  { to: '/patients', key: 'nav.patients', icon: IconUsers, roles: null, section: 'nav.care' },
  { to: '/records', key: 'nav.records', icon: IconFileText, roles: ['owner', 'doctor', 'receptionist'], section: 'nav.care' },
  { to: '/staff', key: 'nav.staff', icon: IconSteth, roles: ['owner'], section: 'nav.manage' },
  { to: '/services', key: 'nav.services', icon: IconGrid, roles: ['owner', 'receptionist'], section: 'nav.manage' },
  { to: '/invoices', key: 'nav.invoices', icon: IconInvoice, roles: ['owner', 'accountant', 'doctor'], section: 'nav.manage' },
  { to: '/reports', key: 'nav.reports', icon: IconChart, roles: ['owner', 'accountant', 'receptionist'], section: 'nav.manage' },
  { to: '/audit', key: 'nav.audit', icon: IconShield, roles: ['owner'], section: 'nav.manage' },
  { to: '/settings', key: 'nav.settings', icon: IconSettings, roles: ['owner'], section: 'nav.manage' },
  { to: '/admin/clinics', key: 'nav.clinics', icon: IconBuilding, roles: ['platform_admin'], section: 'nav.platform' },
  { to: '/account', key: 'nav.myAccount', icon: IconUser,
    roles: ['owner', 'receptionist', 'doctor', 'accountant', 'platform_admin'], section: 'nav.account' },
];

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { clinic } = useClinicMeta();
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const hamburgerRef = useRef(null);
  const sidebarRef = useRef(null);
  const isAdmin = user?.role === 'platform_admin';
  const canBook = !isAdmin && ['owner', 'receptionist', 'doctor'].includes(user?.role);

  const items = isAdmin
    ? NAV.filter((n) => n.roles?.includes('platform_admin'))
    : NAV.filter((n) => !n.roles || n.roles.includes(user?.role));
  let lastSection = null;
  const today = new Date().toLocaleDateString(lang === 'ar' ? 'ar' : undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Drawer UX/a11y: Escape closes, body scroll locks while open, focus returns
  // to the hamburger, and navigating (route change) always closes the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    const first = sidebarRef.current?.querySelector('.nav-item, .icon-btn');
    first?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      hamburgerRef.current?.focus();
    };
  }, [open]);

  // Any route change (nav link, programmatic navigate, deep link) closes the drawer.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <div className="app-shell">
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar${open ? ' open' : ''}`} id="app-sidebar" ref={sidebarRef}>
        <div className="brand">
          <div className="brand-mark"><IconTooth size={20} /></div>
          <div className="brand-text">
            <div className="t1">{t('app.title')}</div>
            <div className="t2">{t('app.subtitle')}</div>
          </div>
          <button className="icon-btn sidebar-close" style={{ marginInlineStart: 'auto', color: '#9db6ca', display: open ? undefined : 'none' }}
            onClick={() => setOpen(false)} aria-label={t('nav.closeMenu')}>
            <IconX />
          </button>
        </div>
        <div className="clinic-chip">
          <span className="dot" /> <b>{isAdmin ? t('nav.platform') : clinic?.name}</b>
        </div>
        <nav className="nav" aria-label={t('nav.mainNav')}>
          {items.map((n) => {
            const header = n.section !== lastSection ? <div className="nav-section" key={`s-${n.section}`}>{t(n.section)}</div> : null;
            lastSection = n.section;
            return (
              <React.Fragment key={n.to}>
                {header}
                <NavLink
                  to={n.to} end={n.to === '/'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  onClick={() => setOpen(false)}
                >
                  <n.icon className="nav-ico" />
                  {t(n.key)}
                </NavLink>
              </React.Fragment>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-card">
            <div className="avatar">{initials(user?.full_name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nm" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.full_name}</div>
              <div className="rl">{t(`role.${user?.role}`)}</div>
            </div>
            <NavLink to="/account" className="icon-btn" style={{ color: '#9db6ca' }} title={t('nav.myAccount')}>
              <IconUser />
            </NavLink>
            <button className="icon-btn" style={{ color: '#9db6ca' }} title={t('common.signOut')}
              onClick={async () => { await logout(); navigate('/login'); }}>
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="icon-btn hamburger" ref={hamburgerRef} onClick={() => setOpen(true)}
            aria-label={t('nav.openMenu')} aria-expanded={open} aria-controls="app-sidebar">
            <IconMenu />
          </button>
          <div className="topbar-date" title={today}>
            <h1 style={{ fontSize: 14.5 }}>{today}</h1>
          </div>
          <div className="topbar-spacer" />
          <button
            className="btn btn-outline btn-sm topbar-lang"
            onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
            title={t('topbar.language')}
            aria-label={t('topbar.language')}
          >
            <IconGlobe size={15} /> <span className="cta-lbl">{lang === 'ar' ? 'English' : 'العربية'}</span>
          </button>
          {canBook && (
            <Link to="/appointments" className="btn btn-primary btn-sm topbar-cta" title={t('topbar.newAppointment')}>
              <IconPlus size={15} /> <span className="cta-lbl">{t('topbar.newAppointment')}</span>
            </Link>
          )}
        </div>
        {/* Page-level Suspense lives INSIDE the shell: navigating to a
            not-yet-loaded chunk replaces only the content area, never the
            sidebar/topbar (which used to blank out via the app-level fallback). */}
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}

/** Localized skeleton for the content area while a lazy route chunk loads. */
function PageSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" style={{ width: '40%' }} />
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <span className="sr-only">Loading page…</span>
    </div>
  );
}
