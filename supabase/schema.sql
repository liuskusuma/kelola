-- Skema cloud Kelola. Jalankan sekali di Supabase: SQL Editor -> New query -> tempel -> Run.
-- Semua data (produk, transaksi, profil usaha) disimpan di satu tabel `records`,
-- satu baris per catatan, dan setiap pengguna hanya bisa melihat datanya sendiri.

create table if not exists public.records (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  id text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  -- Waktu perubahan di perangkat; dipakai untuk memilih versi terbaru.
  updated_at timestamptz not null,
  deleted boolean not null default false,
  -- Waktu baris diterima server; dipakai perangkat lain untuk menarik perubahan.
  server_updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create index if not exists records_user_server_updated_idx
  on public.records (user_id, server_updated_at);

-- Versi yang lebih lama tidak boleh menimpa versi yang lebih baru,
-- misalnya saat HP yang lama offline baru tersambung lagi.
create or replace function public.records_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

alter table public.records enable row level security;

drop policy if exists "records milik sendiri: baca" on public.records;
create policy "records milik sendiri: baca" on public.records
  for select using (auth.uid() = user_id);

drop policy if exists "records milik sendiri: tambah" on public.records;
create policy "records milik sendiri: tambah" on public.records
  for insert with check (auth.uid() = user_id);

drop policy if exists "records milik sendiri: ubah" on public.records;
create policy "records milik sendiri: ubah" on public.records
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
