import { type FormEvent, useState } from 'react';

interface LoginPageProps {
  authMode: 'github' | 'password';
  onSuccess: () => void;
}

export default function LoginPage({ authMode, onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) {
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
      if (err === 'access_denied') return 'Access denied. Your GitHub account is not authorized.';
      if (err === 'invalid_state') return 'Login expired. Please try again.';
      return `Login failed: ${err}`;
    }
    return '';
  });
  const [loading, setLoading] = useState(false);

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        onSuccess();
      } else {
        const data = await res.json();
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGitHubLogin = () => {
    window.location.href = '/api/auth/github';
  };

  return (
    <div className='flex items-center justify-center h-screen bg-iris-bg'>
      <div className='flex flex-col gap-4 p-8 bg-iris-surface rounded-xl w-80 border border-iris-border'>
        <img src='/icon-192x192.png' alt='CloudShell' className='w-16 h-16 mx-auto rounded-xl' />
        <h1 className='text-xl font-bold text-iris-text text-center'>CloudShell</h1>

        {error && <p className='text-iris-error text-sm'>{error}</p>}

        {authMode === 'github' ? (
          <button
            type='button'
            onClick={handleGitHubLogin}
            className='flex items-center justify-center gap-2 px-4 py-2 bg-[#24292f] text-white rounded-lg hover:bg-[#32383f] transition-colors'
          >
            <svg className='w-5 h-5' fill='currentColor' viewBox='0 0 24 24'>
              <path d='M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z' />
            </svg>
            Sign in with GitHub
          </button>
        ) : (
          <form onSubmit={handlePasswordSubmit} className='flex flex-col gap-4'>
            <input
              type='text'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder='Username'
              className='px-3 py-2 bg-iris-bg text-iris-text rounded-lg border border-iris-border focus:outline-none focus:border-iris-primary transition-colors'
              autoFocus
            />
            <input
              type='password'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder='Password'
              className='px-3 py-2 bg-iris-bg text-iris-text rounded-lg border border-iris-border focus:outline-none focus:border-iris-primary transition-colors'
            />
            <button
              type='submit'
              disabled={loading || !username || !password}
              className='px-4 py-2 bg-iris-primary text-iris-primary-text rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50'
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
