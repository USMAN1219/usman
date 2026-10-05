import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { AuthProvider, useAuth } from "./lib/auth.tsx";
import { AnalysisPage } from "./pages/AnalysisPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { WatchlistPage } from "./pages/WatchlistPage.tsx";

function Routed() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/analysis/:id" element={<AnalysisPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
