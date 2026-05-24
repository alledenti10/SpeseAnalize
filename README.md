# Spese AI

Dashboard professionale per tracciare spese giornaliere e report mensili, con accesso utente tramite Supabase.

## Setup

1) Copia `.env.example` in `.env` e inserisci le tue variabili:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_VAPID_PUBLIC_KEY=
```

2) Applica lo schema Supabase in [supabase/schema.sql](supabase/schema.sql).

3) Installa le dipendenze e avvia lo sviluppo:

```
npm install
npm run dev
```

## Note operative

- Le categorie sono: Volute, Dovute, Necessarie.
- Le spese vengono salvate per data e aggregate sul mese selezionato.
- La app e installabile come PWA: in produzione deve essere servita via HTTPS.
- Su iPhone le notifiche web funzionano dopo "Aggiungi alla schermata Home" e il permesso deve partire da un tap dell'utente.
- Le notifiche locali vengono mostrate quando la PWA viene aperta e trova scadenze nei successivi 10 giorni.
- Per invii anche ad app chiusa, configura `VITE_VAPID_PUBLIC_KEY` nel client e distribuisci `supabase/functions/send-deadline-reminders` con `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `SUPABASE_SERVICE_ROLE_KEY` e un cron HTTP protetto da `CRON_SECRET`.
- Non usare mai la service role key nel client.
