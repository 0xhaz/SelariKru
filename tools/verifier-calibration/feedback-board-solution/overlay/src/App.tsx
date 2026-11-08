import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { Feedback, FeedbackCounts, FeedbackStatus, StatusFilter } from '../contract/api';

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'planned', label: 'Planned' },
  { value: 'done', label: 'Done' },
];
const STATUS_LABEL: Record<FeedbackStatus, string> = { open: 'Open', planned: 'Planned', done: 'Done' };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

export function App() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [items, setItems] = useState<Feedback[]>([]);
  const [counts, setCounts] = useState<FeedbackCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f: StatusFilter) => {
    try {
      const data = await request<{ items: Feedback[]; counts: FeedbackCounts }>(`/api/feedback?status=${f}`);
      setItems(data.items);
      setCounts(data.counts);
      return true;
    } catch (e) {
      setError(`Could not load feedback. ${(e as Error).message}`);
      return false;
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void load(filter).finally(() => setLoading(false));
  }, [filter, load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await request('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      setTitle('');
      setDescription('');
      await load(filter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(id: string, status: FeedbackStatus) {
    setError(null);
    try {
      await request(`/api/feedback/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await load(filter);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui, sans-serif', padding: '0 1rem' }}>
      <h1>Feedback Board</h1>
      <form onSubmit={submit} noValidate>
        <p>
          <label htmlFor="fb-title">Title</label>
          <br />
          <input id="fb-title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
        </p>
        <p>
          <label htmlFor="fb-description">Description</label>
          <br />
          <textarea id="fb-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </p>
        <button type="submit" disabled={busy}>Submit feedback</button>
      </form>

      {error && <p role="alert" style={{ color: '#9b1c1c' }}>{error}</p>}

      <div role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label} {counts ? counts[f.value] : 0}
          </button>
        ))}
      </div>

      {loading && <p role="status">Loading feedback...</p>}
      {!loading && !error && counts?.all === 0 && <p role="status">No feedback yet. Be the first to add some.</p>}
      {!loading && !error && counts && counts.all > 0 && items.length === 0 && <p role="status">Nothing has this status.</p>}

      <ul aria-label="Feedback list">
        {!loading &&
          items.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              {item.description && <p>{item.description}</p>}
              <select
                aria-label="Status"
                value={item.status}
                onChange={(e) => void changeStatus(item.id, e.target.value as FeedbackStatus)}
              >
                {(Object.keys(STATUS_LABEL) as FeedbackStatus[]).map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </li>
          ))}
      </ul>
    </main>
  );
}
