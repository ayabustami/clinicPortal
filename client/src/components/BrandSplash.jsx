import React from 'react';

/**
 * In-app brand splash: the same tooth mark, wordmark and message as the static
 * boot splash in index.html. Used as the Suspense fallback while route chunks
 * load, so every loading moment stays on-brand. Pure CSS animation (single
 * stroke draw + fade), static under prefers-reduced-motion, light/dark via
 * prefers-color-scheme. No timers, no artificial delay.
 */
export default function BrandSplash({ message = 'Preparing your workspace' }) {
  return (
    <div className="splash" role="status" aria-label="Loading Denti Clinics">
      <div className="splash-inner">
        <svg className="splash-tooth" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            pathLength="100"
            d="M12 5.6C10.8 4.6 9.3 4 7.9 4 4.9 4 3 6.2 3 9c0 2 .8 3.5 1.6 5.1.8 1.7 1.2 3.4 1.4 5.2.1 1 .9 1.8 1.9 1.8 1.2 0 1.7-.9 1.9-2l.5-2.6c.2-1 .9-1.6 1.7-1.6s1.5.6 1.7 1.6l.5 2.6c.2 1.1.7 2 1.9 2 1 0 1.8-.8 1.9-1.8.2-1.8.6-3.5 1.4-5.2C20.2 12.5 21 11 21 9c0-2.8-1.9-5-4.9-5-1.4 0-2.9.6-4.1 1.6Z"
          />
        </svg>
        <div className="splash-name">Denti Clinics</div>
        <div className="splash-msg">{message}</div>
      </div>
    </div>
  );
}
