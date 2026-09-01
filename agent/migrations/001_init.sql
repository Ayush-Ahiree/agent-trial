-- AgentTrail hosted schema (Supabase/Postgres).
-- auth.users is managed by Supabase Auth; everything here hangs off it.

create table if not exists projects (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    api_key_hash text not null unique,
    api_key_prefix text not null,  -- first chars of the key, shown in the UI so a project's key is recognizable without re-revealing the secret
    created_at timestamptz not null default now()
);
create index if not exists projects_user_id_idx on projects(user_id);

create table if not exists policies (
    project_id uuid primary key references projects(id) on delete cascade,
    deny_path_patterns jsonb not null default '["admin/**", ".env*", "secrets/**"]',
    rule_toggles jsonb not null default '{
        "dangerous_shell_detection": true,
        "secret_exfil_blocking": true,
        "pii_internal_boundary_confirm": true,
        "baseline_external_flagging": true
    }',
    updated_at timestamptz not null default now()
);

create table if not exists events (
    id bigint generated always as identity primary key,
    project_id uuid not null references projects(id) on delete cascade,
    session_id text,
    ts timestamptz not null default now(),
    type text not null,       -- tool_call | taint_update | confirm_request | confirm_resolution
    tool text,
    target text,
    decision text,
    reasons jsonb,
    raw jsonb not null
);
create index if not exists events_project_id_ts_idx on events(project_id, ts desc);

-- Row Level Security: a project (and everything under it) is only ever
-- visible to the user who owns it. The hosted API talks to Postgres with
-- the service-role key (bypasses RLS) since it does its own project_id
-- scoping from the verified API key / JWT -- RLS here is the backstop if
-- anything ever queries Postgres directly with a user's own JWT instead.
alter table projects enable row level security;
alter table policies enable row level security;
alter table events enable row level security;

create policy "own projects" on projects
    for all using (auth.uid() = user_id);

create policy "own project policies" on policies
    for all using (
        exists (select 1 from projects p where p.id = policies.project_id and p.user_id = auth.uid())
    );

create policy "own project events" on events
    for all using (
        exists (select 1 from projects p where p.id = events.project_id and p.user_id = auth.uid())
    );
