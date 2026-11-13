-- QRIS Midtrans: pembayaran dengan tanda lunas otomatis.
-- Jalankan sekali di Supabase setelah schema.sql dan staff.sql:
-- SQL Editor -> New query -> tempel seluruh isi file ini -> Run. Aman dijalankan ulang.
-- Setelah itu pasang Edge Function `midtrans`
-- (isi file supabase/functions/midtrans/index.ts).
--
-- Cara kerjanya:
-- - Setiap owner (client Kelola) mendaftar akun Midtrans sendiri, lalu menempel
--   Server Key-nya di Akun. Kunci itu disimpan di `midtrans_kunci`.
-- - Kasir (owner atau staff) meminta QR lewat Edge Function. Fungsi itu memakai
--   Server Key milik owner untuk membuat QRIS di Midtrans, dan mencatatnya di
--   `midtrans_bayar`. Status lunas dicek ke Midtrans lewat fungsi yang sama.
-- - Untuk tagihan "bayar nanti", fungsi membuat link bayar Midtrans. Pembayaran yang
--   masuk diambil HP owner saat sinkron, lalu dicatat sebagai pembayaran tagihan.
--
-- Kedua tabel TIDAK bisa dibaca atau diubah dari aplikasi (tanpa aturan RLS),
-- hanya dari Edge Function. Server Key tidak pernah dikirim balik ke HP mana pun.

create table if not exists public.midtrans_kunci (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  server_key text not null,
  aktif boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.midtrans_kunci enable row level security;

create table if not exists public.midtrans_bayar (
  order_id text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  dibuat_oleh uuid,
  sumber text not null check (sumber in ('kasir', 'tagihan')),
  ref text,
  jumlah bigint not null check (jumlah > 0),
  status text not null default 'pending',
  metode text,
  link text,
  kedaluwarsa timestamptz,
  dibayar timestamptz,
  diproses boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists midtrans_bayar_owner_idx on public.midtrans_bayar (owner_id, sumber, status, diproses);
create index if not exists midtrans_bayar_ref_idx on public.midtrans_bayar (owner_id, ref);

alter table public.midtrans_bayar enable row level security;
