import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import BrandSplash from './components/BrandSplash.jsx';
import { AuthProvider, useAuth } from './auth.jsx';
import { LangProvider } from './i18n.jsx';
import { ToastProvider, ConfirmProvider } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';

// Route-level code splitting: FullCalendar and the heavier admin pages load on demand.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Appointments = lazy(() => import('./pages/Appointments.jsx'));
const DentalChart = lazy(() => import('./pages/DentalChart.jsx'));
const MyDay = lazy(() => import('./pages/MyDay.jsx'));
const WaitingRoom = lazy(() => import('./pages/WaitingRoom.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientProfile = lazy(() => import('./pages/PatientProfile.jsx'));
const Staff = lazy(() => import('./pages/Staff.jsx'));
const Services = lazy(() => import('./pages/Services.jsx'));
const Records = lazy(() => import('./pages/Records.jsx'));
const Invoices = lazy(() => import('./pages/Invoices.jsx'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const AdminClinics = lazy(() => import('./pages/AdminClinics.jsx'));
const VisitWorkspace = lazy(() => import('./pages/VisitWorkspace.jsx'));

function Protected({ children }) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ minHeight: '100vh', display: 'grid' }}><BrandSplash /></div>;
  // Keep the intended destination so an expired session returns the user where they were.
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

/** Platform admins have no clinic context — send them to the platform console. */
function Home() {
  const { user } = useAuth();
  return user?.role === 'platform_admin' ? <Navigate to="/admin/clinics" replace /> : <Dashboard />;
}

const PageFallback = <BrandSplash />;

export default function App() {
  return (
    <LangProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <Suspense fallback={PageFallback}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route element={<Protected><Layout /></Protected>}>
                  <Route path="/" element={<Home />} />
                  <Route path="/appointments" element={<Appointments />} />
                  <Route path="/calendar" element={<Navigate to="/appointments" replace />} />
                  <Route path="/my-day" element={<MyDay />} />
                <Route path="/waiting-room" element={<WaitingRoom />} />
                  <Route path="/patients" element={<Patients />} />
                  <Route path="/patients/:id" element={<PatientProfile />} />
                  <Route path="/patients/:id/dental" element={<DentalChart />} />
                  <Route path="/staff" element={<Staff />} />
                  <Route path="/services" element={<Services />} />
                  <Route path="/records" element={<Records />} />
                  <Route path="/visits/:appointmentId" element={<VisitWorkspace />} />
                  <Route path="/invoices" element={<Invoices />} />
                  <Route path="/invoices/:id" element={<InvoiceDetail />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/audit" element={<Audit />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/admin/clinics" element={<AdminClinics />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </LangProvider>
  );
}
