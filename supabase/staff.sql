-- Akun staff Kelola. Jalankan sekali di Supabase setelah schema.sql:
-- SQL Editor -> New query -> tempel seluruh isi file ini -> Run.
-- Aman dijalankan ulang.
--
-- Cara kerjanya:
-- - Owner membuat kode undangan. Staff daftar dengan email sendiri, lalu
--   memasukkan kode itu untuk bergabung.
-- - Staff TIDAK bisa membaca tabel `records` milik owner. Staff hanya bisa
--   memanggil fungsi `produk_kasir`, yang mengembalikan nama, harga, stok,
--   satuan, dan foto produk (tanpa modal, resep, laporan, atau pengeluaran).
-- - Penjualan staff masuk ke tabel `penjualan_staff`. Aplikasi owner
--   mengambilnya, menghitung modal dan laba, lalu memotong stok.

create table if not exists public.staff (
  staff_id uuid primary key references auth.users (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  nama text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.undangan_staff (
  kode text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  kedaluwarsa timestamptz not null default now() + interval '7 days',
  dipakai_oleh uuid references auth.users (id) on delete set null
);

create table if not exists public.penjualan_staff (
  id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  staff_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  data jsonb not null,
  diproses boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists penjualan_staff_owner_idx on public.penjualan_staff (owner_id, diproses);

alter table public.staff enable row level security;
alter table public.undangan_staff enable row level security;
alter table public.penjualan_staff enable row level security;

-- Staff: owner melihat dan menghapus staffnya; staff melihat barisnya sendiri.
drop policy if exists "staff: baca" on public.staff;
create policy "staff: baca" on public.staff
  for select using (auth.uid() = owner_id or auth.uid() = staff_id);
drop policy if exists "staff: owner menghapus" on public.staff;
create policy "staff: owner menghapus" on public.staff
  for delete using (auth.uid() = owner_id);

-- Undangan: hanya owner yang membuat, melihat, dan menghapus kodenya.
-- Akun yang sudah menjadi staff tidak bisa membuat undangan.
drop policy if exists "undangan: owner" on public.undangan_staff;
create policy "undangan: owner" on public.undangan_staff
  for all using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id and not exists (select 1 from public.staff s where s.staff_id = auth.uid()));

-- Penjualan staff: staff mencatat untuk owner-nya sendiri; owner membaca dan menandai diproses.
drop policy if exists "penjualan staff: staff mencatat" on public.penjualan_staff;
create policy "penjualan staff: staff mencatat" on public.penjualan_staff
  for insert with check (
    auth.uid() = staff_id
    and diproses = false
    and owner_id = (select s.owner_id from public.staff s where s.staff_id = auth.uid())
  );
drop policy if exists "penjualan staff: baca" on public.penjualan_staff;
create policy "penjualan staff: baca" on public.penjualan_staff
  for select using (auth.uid() = owner_id or auth.uid() = staff_id);
drop policy if exists "penjualan staff: owner memproses" on public.penjualan_staff;
create policy "penjualan staff: owner memproses" on public.penjualan_staff
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Bergabung sebagai staff dengan kode undangan.
create or replace function public.gabung_staff(kode_undangan text, nama_staff text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.undangan_staff;
begin
  if auth.uid() is null then
    raise exception 'Belum masuk';
  end if;
  select * into u from public.undangan_staff
    where kode = upper(trim(kode_undangan)) and dipakai_oleh is null and kedaluwarsa > now()
    for update;
  if not found then
    raise exception 'Kode undangan tidak berlaku';
  end if;
  if u.owner_id = auth.uid() then
    raise exception 'Kode ini milik akun Anda sendiri';
  end if;
  insert into public.staff (staff_id, owner_id, nama)
    values (auth.uid(), u.owner_id, coalesce(nullif(trim(nama_staff), ''), 'Staff'))
    on conflict (staff_id) do update set owner_id = excluded.owner_id, nama = excluded.nama;
  update public.undangan_staff set dipakai_oleh = auth.uid() where kode = u.kode;
  return u.owner_id;
end;
$$;

-- Data untuk layar kasir staff: profil usaha dan produk tanpa modal.
-- Stok sudah dikurangi penjualan staff yang belum diproses aplikasi owner.
create or replace function public.produk_kasir()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pemilik uuid;
  hasil jsonb;
begin
  select s.owner_id into pemilik from public.staff s where s.staff_id = auth.uid();
  if pemilik is null then
    raise exception 'Bukan akun staff';
  end if;
  with tertunda as (
    select i->>'produkId' as produk_id, sum((i->>'qty')::numeric) as qty
    from public.penjualan_staff p, jsonb_array_elements(p.data->'items') i
    where p.owner_id = pemilik and not p.diproses
    group by 1
  )
  select jsonb_build_object(
    'usaha', (select jsonb_build_object('namaUsaha', r.data->>'namaUsaha', 'kontak', r.data->>'kontak', 'qris', r.data->>'qris')
              from public.records r where r.user_id = pemilik and r.id = 'profil' and not r.deleted),
    'produk', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'nama', r.data->>'nama',
        'harga', r.data->'harga',
        'satuan', r.data->>'satuan',
        'foto', r.data->>'foto',
        'mode', r.data->>'mode',
        'paket', r.data->'paket',
        'stok', case when jsonb_typeof(r.data->'stok') = 'number'
                     then to_jsonb((r.data->>'stok')::numeric - coalesce(t.qty, 0))
                     else 'null'::jsonb end
      ))
      from public.records r
      left join tertunda t on t.produk_id = r.id
      where r.user_id = pemilik and r.kind = 'produk' and not r.deleted
    ), '[]'::jsonb)
  ) into hasil;
  return hasil;
end;
$$;

revoke all on function public.gabung_staff(text, text) from public, anon;
revoke all on function public.produk_kasir() from public, anon;
grant execute on function public.gabung_staff(text, text) to authenticated;
grant execute on function public.produk_kasir() to authenticated;
