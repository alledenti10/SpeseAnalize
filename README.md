# Spese AI

Dashboard professionale per tracciare spese giornaliere e report mensili, con accesso utente tramite Supabase.

## Setup

1) Copia `.env.example` in `.env` e inserisci le tue variabili:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
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
- Non usare mai la service role key nel client.
