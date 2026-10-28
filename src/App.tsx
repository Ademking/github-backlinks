import { Fragment, useEffect, useMemo, useState } from 'react'
import { Banner, Button, Empty, Input, LayerCard, Loader, Table, Tabs } from '@cloudflare/kumo'
import { ArrowClockwise, ArrowSquareOut, CaretDown, CaretRight, SignOut } from '@phosphor-icons/react'

type Repo = { full_name: string; html_url: string; permissions?: { push: boolean } }
type Referrer = { referrer: string; count: number; uniques: number }
type Path = { path: string; title: string; count: number; uniques: number }
type Totals = { count: number; uniques: number }
type RepoStats = { repo: Repo; referrers: Referrer[]; paths: Path[]; views: Totals; clones: Totals }
type User = { login: string; avatar_url: string; html_url: string }

const TOKEN_KEY = 'gh-traffic-token'
const storage = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? ''
    } catch {
      return ''
    }
  },
  set: (v: string) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* storage blocked: token just won't persist */
    }
  },
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function gh<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new HttpError(res.status, `${res.status} ${body.message ?? res.statusText}`)
  }
  return res.json()
}

async function loadRepos(token: string) {
  const repos: Repo[] = []
  for (let page = 1; ; page++) {
    const batch = await gh<Repo[]>(token, `/user/repos?per_page=100&page=${page}`)
    repos.push(...batch)
    if (batch.length < 100) break
  }
  // Traffic API needs push access; skip repos where it would 403.
  return repos.filter((r) => r.permissions?.push)
}

async function loadStats(token: string, repo: Repo): Promise<RepoStats> {
  const base = `/repos/${repo.full_name}/traffic`
  const zero = { count: 0, uniques: 0 }
  const [referrers, paths, views, clones] = await Promise.all([
    gh<Referrer[]>(token, `${base}/popular/referrers`).catch(() => []),
    gh<Path[]>(token, `${base}/popular/paths`).catch(() => []),
    gh<Totals>(token, `${base}/views`).catch(() => zero),
    gh<Totals>(token, `${base}/clones`).catch(() => zero),
  ])
  return { repo, referrers, paths, views, clones }
}

// The REST API only returns the domain. GitHub's own page lists the full referring URLs.
const referrerUrl = (repo: string, referrer: string) =>
  `https://github.com/${repo}/graphs/traffic?referrer=${encodeURIComponent(referrer)}#top-domains`

const fmt = (n: number) => n.toLocaleString()

function SiteIcon({ name }: { name: string }) {
  const domain = name.includes('.') ? name : `${name.toLowerCase()}.com`
  return (
    <img
      src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
      alt=""
      width={16}
      height={16}
      className="size-4 shrink-0 rounded-sm"
      onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
    />
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-kumo-recessed">
      <div className="h-full rounded-full bg-kumo-brand" style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
    </div>
  )
}

function ExternalLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1 text-kumo-link transition-colors hover:underline ${className}`}
    >
      {children}
      <ArrowSquareOut size={12} className="shrink-0" />
    </a>
  )
}

export default function App() {
  const [token, setToken] = useState(storage.get)
  const [user, setUser] = useState<User | null>(null)
  const [stats, setStats] = useState<RepoStats[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('sites')
  const [filter, setFilter] = useState('')
  const loading = progress !== null

  async function load(t = token.trim()) {
    if (!t) return
    setError('')
    setProgress({ done: 0, total: 0 })
    try {
      const [me, repos] = await Promise.all([gh<User>(t, '/user'), loadRepos(t)])
      storage.set(t)
      setUser(me)
      const out: RepoStats[] = []
      // ponytail: 5 repos (20 requests) at a time to stay under GitHub's secondary rate limit
      for (let i = 0; i < repos.length; i += 5) {
        setProgress({ done: i, total: repos.length })
        out.push(...(await Promise.all(repos.slice(i, i + 5).map((r) => loadStats(t, r)))))
      }
      setStats(out)
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        storage.set('')
        setUser(null)
        setStats(null)
      }
      setError((err as Error).message)
    } finally {
      setProgress(null)
    }
  }

  function signOut() {
    storage.set('')
    setToken('')
    setUser(null)
    setStats(null)
    setError('')
  }

  // Auto-load once when a token was saved from a previous visit.
  useEffect(() => {
    if (token) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const q = filter.trim().toLowerCase()

  const sites = useMemo(() => {
    const map = new Map<string, { name: string; count: number; uniques: number; repos: (Referrer & { repo: string })[] }>()
    for (const s of stats ?? [])
      for (const r of s.referrers) {
        const e = map.get(r.referrer) ?? { name: r.referrer, count: 0, uniques: 0, repos: [] }
        e.count += r.count
        e.uniques += r.uniques
        e.repos.push({ ...r, repo: s.repo.full_name })
        map.set(r.referrer, e)
      }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [stats])

  const totals = useMemo(() => {
    const t = { referred: 0, views: 0, viewers: 0, clones: 0 }
    for (const s of stats ?? []) {
      t.referred += s.referrers.reduce((n, r) => n + r.count, 0)
      t.views += s.views.count
      t.viewers += s.views.uniques
      t.clones += s.clones.count
    }
    return t
  }, [stats])

  const activeRepos = (stats ?? [])
    .filter((s) => s.views.count || s.clones.count || s.referrers.length)
    .sort((a, b) => b.views.count - a.views.count)

  const shownSites = sites.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.repos.some((r) => r.repo.toLowerCase().includes(q)),
  )
  const shownRepos = activeRepos.filter(
    (s) => !q || s.repo.full_name.toLowerCase().includes(q) || s.referrers.some((r) => r.referrer.toLowerCase().includes(q)),
  )

  return (
    <div className="min-h-dvh bg-kumo-canvas text-kumo-default">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
        <span className="text-lg font-semibold tracking-tight">Backlinks for GitHub</span>
        {user && (
          <div className="flex items-center gap-2">
            <a
              href={user.html_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 transition-colors hover:text-kumo-link"
            >
              <img src={user.avatar_url} alt="" className="size-7 rounded-full" />
              <span className="hidden text-sm font-medium sm:inline">{user.login}</span>
            </a>
            <Button variant="ghost" size="sm" onClick={() => load()} disabled={loading} aria-label="Refresh">
              <ArrowClockwise size={16} />
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut} aria-label="Forget token">
              <SignOut size={16} />
            </Button>
          </div>
        )}
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 pb-24 sm:px-8">
        {!user && (
          <section className="grid gap-10 pt-10 lg:grid-cols-[1.2fr_1fr] lg:items-end lg:pt-20">
            <div className="flex flex-col gap-5">
              <h1 className="text-5xl leading-[0.95] font-semibold tracking-[-0.03em] sm:text-7xl">
                Who links to your repos?
              </h1>
              <p className="max-w-xl text-lg text-kumo-default">
                Every referring site across all your GitHub repositories, in one place. Covers the last 14 days, the most GitHub
                keeps.
              </p>
            </div>
            <LayerCard className="flex flex-col gap-4 p-6">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  load()
                }}
                className="flex flex-col gap-4"
              >
                <Input
                  label="Personal access token"
                  type="password"
                  passwordManagerIgnore
                  placeholder="ghp_…"
                  value={token}
                  onValueChange={setToken}
                />
                <Button type="submit" variant="primary" disabled={!token.trim() || loading} className="w-full justify-center">
                  {loading ? 'Loading…' : 'Show my traffic'}
                </Button>
              </form>
              <p className="text-sm text-kumo-subtle">
                Classic token with <code>repo</code> scope, or fine-grained with Administration: read.{' '}
                <ExternalLink href="https://github.com/settings/tokens/new?scopes=repo&description=Referrers">
                  Create one
                </ExternalLink>
                . The token is saved in this browser's local storage and sent only to api.github.com.
              </p>
            </LayerCard>
          </section>
        )}

        {error && <Banner variant="error">{error}</Banner>}

        {loading && (
          <div className="flex items-center gap-3 text-kumo-subtle">
            <Loader />
            {progress.total
              ? `Reading traffic for ${progress.done} of ${progress.total} repositories…`
              : 'Finding your repositories…'}
          </div>
        )}

        {user && stats && (
          <>
            <section className="grid grid-cols-2 gap-x-6 gap-y-8 pt-6 lg:grid-cols-4">
              {[
                ['Referred views', totals.referred],
                ['Page views', totals.views],
                ['Unique visitors', totals.viewers],
                ['Clones', totals.clones],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-4xl font-semibold tracking-tight tabular-nums sm:text-6xl">{fmt(value as number)}</span>
                  <span className="text-sm text-kumo-subtle">{label}, last 14 days</span>
                </div>
              ))}
            </section>

            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Tabs
                  variant="segmented"
                  value={tab}
                  onValueChange={setTab}
                  tabs={[
                    { value: 'sites', label: `By site (${sites.length})` },
                    { value: 'repos', label: `By repository (${activeRepos.length})` },
                  ]}
                />
                <Input
                  aria-label="Filter"
                  placeholder="Filter sites or repositories"
                  value={filter}
                  onValueChange={setFilter}
                  className="sm:w-72"
                />
              </div>

              {tab === 'sites' && <SitesTable sites={shownSites} />}
              {tab === 'repos' && <RepoList repos={shownRepos} />}

              <p className="text-sm text-kumo-subtle">
                {stats.length} repositories scanned, {stats.length - activeRepos.length} had no traffic. GitHub refreshes
                referrers daily and keeps the top 10 per repository.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function SitesTable({
  sites,
}: {
  sites: { name: string; count: number; uniques: number; repos: (Referrer & { repo: string })[] }[]
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  if (!sites.length)
    return <Empty title="No referring sites" description="Nothing linked to your repositories in the last 14 days." />
  const max = sites[0].count
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Site</Table.Head>
            <Table.Head className="hidden w-1/3 md:table-cell">Share</Table.Head>
            <Table.Head className="text-right">Views</Table.Head>
            <Table.Head className="text-right">Unique</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sites.map((s) => {
            const isOpen = open.has(s.name)
            return (
              <Fragment key={s.name}>
                <Table.Row variant={isOpen ? 'selected' : 'default'} className="cursor-pointer" onClick={() => toggle(s.name)}>
                  <Table.Cell>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      className="flex items-center gap-2 text-left font-medium"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(s.name)
                      }}
                    >
                      {isOpen ? <CaretDown size={14} /> : <CaretRight size={14} />}
                      <SiteIcon name={s.name} />
                      {s.name}
                      <span className="font-normal text-kumo-subtle">
                        {s.repos.length} {s.repos.length === 1 ? 'repo' : 'repos'}
                      </span>
                    </button>
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell">
                    <Bar value={s.count} max={max} />
                  </Table.Cell>
                  <Table.Cell className="text-right font-medium tabular-nums">{fmt(s.count)}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmt(s.uniques)}</Table.Cell>
                </Table.Row>
                {isOpen &&
                  s.repos
                    .toSorted((a, b) => b.count - a.count)
                    .map((r) => (
                      <Table.Row key={r.repo}>
                        <Table.Cell className="pl-12">
                          <div className="flex flex-col gap-0.5">
                            <span>{r.repo}</span>
                            <ExternalLink href={referrerUrl(r.repo, s.name)} className="text-sm">
                              See full referring URLs on GitHub
                            </ExternalLink>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="hidden md:table-cell">
                          <Bar value={r.count} max={max} />
                        </Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{fmt(r.count)}</Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{fmt(r.uniques)}</Table.Cell>
                      </Table.Row>
                    ))}
              </Fragment>
            )
          })}
        </Table.Body>
      </Table>
    </LayerCard>
  )
}

function RepoList({ repos }: { repos: RepoStats[] }) {
  if (!repos.length) return <Empty title="No traffic" description="None of your repositories had visitors in the last 14 days." />
  return (
    <div className="flex flex-col gap-4">
      {repos.map((s) => {
        const max = s.referrers[0]?.count ?? 1
        return (
          <LayerCard key={s.repo.full_name} className="flex flex-col gap-6 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
              <ExternalLink href={`${s.repo.html_url}/graphs/traffic`} className="text-lg font-semibold">
                {s.repo.full_name}
              </ExternalLink>
              <div className="flex gap-6 text-sm text-kumo-subtle">
                <span>
                  <strong className="text-base text-kumo-default tabular-nums">{fmt(s.views.count)}</strong> views
                </span>
                <span>
                  <strong className="text-base text-kumo-default tabular-nums">{fmt(s.views.uniques)}</strong> visitors
                </span>
                <span>
                  <strong className="text-base text-kumo-default tabular-nums">{fmt(s.clones.count)}</strong> clones
                </span>
              </div>
            </div>

            <div className="grid gap-8 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="font-medium">Referring sites</h3>
                {s.referrers.length === 0 && <p className="text-sm text-kumo-subtle">None in the last 14 days.</p>}
                {s.referrers.map((r) => (
                  <div key={r.referrer} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <a
                        href={referrerUrl(s.repo.full_name, r.referrer)}
                        target="_blank"
                        rel="noreferrer"
                        title="See full referring URLs on GitHub"
                        className="flex min-w-0 items-center gap-2 transition-colors hover:text-kumo-link"
                      >
                        <SiteIcon name={r.referrer} />
                        <span className="truncate">{r.referrer}</span>
                        <ArrowSquareOut size={12} className="shrink-0 text-kumo-subtle" />
                      </a>
                      <span className="shrink-0 text-sm tabular-nums">
                        {fmt(r.count)} <span className="text-kumo-subtle">· {fmt(r.uniques)} unique</span>
                      </span>
                    </div>
                    <Bar value={r.count} max={max} />
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="font-medium">Popular content</h3>
                {s.paths.length === 0 && <p className="text-sm text-kumo-subtle">None in the last 14 days.</p>}
                {s.paths.map((p) => (
                  <div key={p.path} className="flex items-center justify-between gap-3">
                    <a
                      href={`https://github.com${p.path}`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate transition-colors hover:text-kumo-link"
                      title={p.path}
                    >
                      {p.path.split('/').slice(3).join('/') || 'Repository home'}
                    </a>
                    <span className="shrink-0 text-sm tabular-nums">
                      {fmt(p.count)} <span className="text-kumo-subtle">· {fmt(p.uniques)} unique</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </LayerCard>
        )
      })}
    </div>
  )
}
