import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, Field, Input } from '../components/ui';
import { ThemeToggle } from '../components/theme';
import { errorText } from '../components/toast';

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.auth.login(username, password),
    onSuccess: onAuthenticated,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            VP
          </div>
          <h1 className="text-lg font-semibold">vpn-to-proxy</h1>
          <p className="mt-1 text-sm text-muted-foreground">Вход в панель управления</p>
        </div>

        <Card>
          <form onSubmit={submit} className="space-y-4 p-5">
            <Field label="Логин">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>

            <Field label="Пароль">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            {login.isError ? (
              <p className="rounded-md border border-danger/30 bg-danger-surface px-3 py-2 text-sm text-danger">
                {errorText(login.error)}
              </p>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={login.isPending}
              icon={<LogIn className="size-4" />}
            >
              Войти
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Пароль администратора выводится в лог сервера при первом запуске
        </p>
      </div>
    </div>
  );
}
