-- Notifikasi HP untuk pengingat tagihan jatuh tempo.
-- Jalankan sekali di Supabase setelah schema.sql:
-- SQL Editor -> New query -> tempel seluruh isi file ini -> Run. Aman dijalankan ulang.
-- Setelah itu pasang Edge Function `pengingat-tagihan`
-- (isi file supabase/functions/pengingat-tagihan/index.ts).
--
-- Cara kerjanya:
-- - HP owner yang menyalakan notifikasi menyimpan alamat notifikasinya di `push_langganan`.
-- - Setiap pagi jam 08.00 WIB, jadwal di bawah memanggil Edge Function. Fungsi itu
--   membaca tagihan "bayar nanti" yang belum lunas di `records`, lalu mengirim
--   notifikasi kalau ada yang lewat atau segera jatuh tempo (sesuai pengaturan di Akun).
-- - Kunci notifikasi (VAPID) dibuat otomatis oleh Edge Function dan disimpan di
--   `push_kunci`. Tabel itu tidak bisa dibaca dari aplikasi, hanya dari server.

create table if not exists public.push_langganan (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  p256dh text not null,
  auth text not null,
  bahasa text not null default 'id',
  terakhir_kirim date,
  created_at timestamptz not null default now()
);

create index if not exists push_langganan_user_idx on public.push_langganan (user_id);

alter table public.push_langganan enable row level security;

drop policy if exists "push milik sendiri" on public.push_langganan;
create policy "push milik sendiri" on public.push_langganan
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.push_kunci (
  id int primary key default 1 check (id = 1),
  publik text not null,
  privat jsonb not null,
  created_at timestamptz not null default now()
);

-- Tanpa policy: hanya server (service role) yang bisa membaca kunci privat.
alter table public.push_kunci enable row level security;

-- Jadwal harian: 01.00 UTC = 08.00 WIB.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'kelola-pengingat-tagihan';

select cron.schedule(
  'kelola-pengingat-tagihan',
  '0 1 * * *',
  $$
  select net.http_post(
    url := 'https://nxtcynztijrrwgtfixgr.supabase.co/functions/v1/pengingat-tagihan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Kunci anon (publik, sama dengan js/config.js). Fungsi ini aman dipanggil siapa saja:
      -- setiap HP paling banyak menerima satu pengingat per hari.
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54dGN5bnp0aWpycndndGZpeGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyNjE2NDMsImV4cCI6MjEwODgzNzY0M30.IqmdHvjE3KHnFQkSPEyPq9XgO3IbmjNxPdiygYkAtz8'
    ),
    body := '{"aksi":"kirim"}'::jsonb
  );
  $$
);
