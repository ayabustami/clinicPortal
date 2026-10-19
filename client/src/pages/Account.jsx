import React from 'react';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { StatusBadge } from '../components/ui.jsx';
import ChangePasswordCard from '../components/ChangePasswordCard.jsx';
import { IconMail, IconSteth, IconUser } from '../components/icons.jsx';

/**
 * My account — per-user settings available to every role: profile summary
 * and the email-verified change-password flow.
 */
export default function Account() {
  const { user, meta } = useAuth();
  const { t } = useI18n();
  const clinic = meta?.clinic;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('account.title')}</h1>
          <div className="desc">{t('account.desc')}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad">
          <div className="card-title"><IconUser size={16} /> {t('account.profile')}</div>
          <div className="account-identity">
            <div className="account-avatar" aria-hidden>{(user?.full_name || '?').trim().charAt(0).toUpperCase()}</div>
            <div>
              <div className="account-name">{user?.full_name}</div>
              <div className="muted small">{user?.email}</div>
            </div>
          </div>

          <div className="account-fields">
            <div className="account-field">
              <span className="muted small">{t('account.role')}</span>
              <span><StatusBadge status={t(`role.${user?.role}`)} /></span>
            </div>
            <div className="account-field">
              <span className="muted small">{t('account.clinic')}</span>
              <span>{clinic?.name || user?.clinic?.name || t('account.notSet')}</span>
            </div>
            <div className="account-field">
              <span className="muted small"><IconMail size={13} /> {t('account.email')}</span>
              <span dir="ltr">{user?.email}</span>
            </div>
            <div className="account-field">
              <span className="muted small"><IconSteth size={13} /> {t('account.phone')}</span>
              <span dir="ltr">{user?.phone || t('account.notSet')}</span>
            </div>
          </div>
        </div>

        <ChangePasswordCard userEmail={user?.email} />
      </div>
    </div>
  );
}
