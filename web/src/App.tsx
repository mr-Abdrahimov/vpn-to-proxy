import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler } from './lib/api';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { ProxiesPage } from './pages/ProxiesPage';
import { SettingsPage } from './pages/SettingsPage';
import { LogsPage } from './pages/LogsPage';

export default function App() {
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(false);

  // Любой 401 из любого запроса возвращает нас на экран входа.
  useEffect(() => {
    setUnauthorizedHandler(() => setExpired(true));
  }, []);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.auth.me,
    retry: false,
  });

  const onAuthenticated = () => {
    setExpired(false);
    queryClient.clear();
    void me.refetch();
  };

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (expired || me.isError || !me.data?.user) {
    return <LoginPage onAuthenticated={onAuthenticated} />;
  }

  return (
    <Layout user={me.data.user}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
        <Route path="/proxies" element={<ProxiesPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage user={me.data.user} />} />
        <Route path="*" element={<DashboardPage />} />
      </Routes>
    </Layout>
  );
}
