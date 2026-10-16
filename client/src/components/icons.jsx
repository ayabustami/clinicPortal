/** Minimal inline SVG icon set (stroke-based, inherits currentColor). */
const I = ({ children, size = 18, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
    {children}
  </svg>
);

export const IconDashboard = (p) => <I {...p}><rect x="3" y="3" width="8" height="10" rx="2"/><rect x="13" y="3" width="8" height="6" rx="2"/><rect x="13" y="11" width="8" height="10" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/></I>;
export const IconCalendar = (p) => <I {...p}><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></I>;
export const IconUsers = (p) => <I {...p}><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.7-3.2 3.2-5 6.2-5s5.5 1.8 6.2 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.3 15.2c2.4.4 4.2 2 4.8 4.8"/></I>;
export const IconSteth = (p) => <I {...p}><path d="M5 3v5a5 5 0 0 0 10 0V3"/><path d="M10 13v3.5a4.5 4.5 0 0 0 9 0V14"/><circle cx="19" cy="11.5" r="2.4"/></I>;
export const IconFileText = (p) => <I {...p}><path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 2.5v5h5M9 12.5h6M9 16h6"/></I>;
export const IconInvoice = (p) => <I {...p}><path d="M6 2.8h12v18.4l-2.4-1.6-2.4 1.6-1.2-.9-1.2.9-2.4-1.6L6 21.2z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/></I>;
export const IconChart = (p) => <I {...p}><path d="M3.5 3.5v17h17"/><path d="M8 16v-5M12.5 16V7.5M17 16v-3.5"/></I>;
export const IconSettings = (p) => <I {...p}><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.2 2.6 2.8-.6 1 2.7 2.8.8-.6 2.8 2 2-2 2 .6 2.8-2.8.8-1 2.7-2.8-.6L12 21.2l-1.2-2.6-2.8.6-1-2.7-2.8-.8.6-2.8-2-2 2-2-.6-2.8 2.8-.8 1-2.7 2.8.6z"/></I>;
export const IconBuilding = (p) => <I {...p}><rect x="4" y="3" width="12" height="18" rx="1.5"/><path d="M16 9h3a1 1 0 0 1 1 1v11M4 21h16M8 7h2M8 11h2M8 15h2M12 7h1M12 11h1M12 15h1"/></I>;
export const IconPlus = (p) => <I {...p}><path d="M12 5v14M5 12h14"/></I>;
export const IconSearch = (p) => <I {...p}><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></I>;
export const IconX = (p) => <I {...p}><path d="M6 6l12 12M18 6L6 18"/></I>;
export const IconChevL = (p) => <I {...p}><path d="M14.5 5.5L8 12l6.5 6.5"/></I>;
export const IconChevR = (p) => <I {...p}><path d="M9.5 5.5L16 12l-6.5 6.5"/></I>;
export const IconClock = (p) => <I {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></I>;
export const IconCheck = (p) => <I {...p}><path d="M4.5 12.5l5 5L19.5 7"/></I>;
export const IconAlert = (p) => <I {...p}><path d="M12 3.5l9.5 16.5H2.5z"/><path d="M12 10v4.5M12 17.6v.4"/></I>;
export const IconInfo = (p) => <I {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.4"/></I>;
export const IconEdit = (p) => <I {...p}><path d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17z"/><path d="M13.5 6.5l3 3"/></I>;
export const IconTrash = (p) => <I {...p}><path d="M4.5 6.5h15M9.5 3.5h5M6.5 6.5l1 14h9l1-14M10 10.5v6M14 10.5v6"/></I>;
export const IconPrint = (p) => <I {...p}><path d="M7 8V3.5h10V8"/><rect x="4" y="8" width="16" height="8.5" rx="1.5"/><path d="M7 13.5h10v7H7z"/></I>;
export const IconDownload = (p) => <I {...p}><path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5M4.5 20.5h15"/></I>;
export const IconMenu = (p) => <I {...p}><path d="M4 6.5h16M4 12h16M4 17.5h16"/></I>;
export const IconLogout = (p) => <I {...p}><path d="M14 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h8M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/></I>;
export const IconHeart = (p) => <I {...p}><path d="M12 20.5S3.5 15 3.5 9a4.6 4.6 0 0 1 8.5-2.4A4.6 4.6 0 0 1 20.5 9c0 6-8.5 11.5-8.5 11.5z"/></I>;
export const IconQueue = (p) => <I {...p}><path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/></I>;
export const IconTooth = (p) => <I {...p}><path d="M12 5.6C10.8 4.6 9.3 4 7.9 4 4.9 4 3 6.2 3 9c0 2 .8 3.5 1.6 5.1.8 1.7 1.2 3.4 1.4 5.2.1 1 .9 1.8 1.9 1.8 1.2 0 1.7-.9 1.9-2l.5-2.6c.2-1 .9-1.6 1.7-1.6s1.5.6 1.7 1.6l.5 2.6c.2 1.1.7 2 1.9 2 1 0 1.8-.8 1.9-1.8.2-1.8.6-3.5 1.4-5.2C20.2 12.5 21 11 21 9c0-2.8-1.9-5-4.9-5-1.4 0-2.9.6-4.1 1.6Z"/></I>;
export const IconPill = (p) => <I {...p}><rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-35 12 12)"/><path d="M9 8.5l5.5 7" transform="rotate(0)"/></I>;
export const IconCard = (p) => <I {...p}><rect x="2.8" y="5" width="18.4" height="14" rx="2.4"/><path d="M2.8 9.6h18.4M6.5 14.5h4"/></I>;
export const IconArrowUp = (p) => <I {...p}><path d="M12 19V5M6 11l6-6 6 6"/></I>;
export const IconPaperclip = (p) => <I {...p}><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5"/></I>;
export const IconGlobe = (p) => <I {...p}><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.3 3.8 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.8-5.3-3.8-8.5S9.5 5.9 12 3.5z"/></I>;
export const IconShield = (p) => <I {...p}><path d="M12 3l7.5 3v5.5c0 4.5-3 8-7.5 9.5-4.5-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></I>;
export const IconGrid = (p) => <I {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></I>;
