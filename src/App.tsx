import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabaseClient'
import type { Deadline, Expense, ExpenseCategory } from './types'
import { formatCurrency, formatDate, formatMonth } from './utils/format'
import './App.css'

type Status = {
  type: 'success' | 'error'
  message: string
}

type CategoryMeta = {
  value: ExpenseCategory
  label: string
  description: string
}

const CATEGORY_META: CategoryMeta[] = [
  {
    value: 'volute',
    label: 'Volute',
    description: 'Spese superflue: aperitivi, cene, viaggi, acquisti extra.',
  },
  {
    value: 'dovute',
    label: 'Dovute',
    description: 'Tasse, bollette, assicurazioni, mutuo, affitto, quote.',
  },
  {
    value: 'necessarie',
    label: 'Necessarie',
    description: 'Alimentari, benzina, servizi essenziali per vivere.',
  },
]

const emptyForm = {
  amount: '',
  category: 'volute' as ExpenseCategory,
  note: '',
}

const emptyDeadlineForm = {
  title: '',
  date: new Date().toISOString().slice(0, 10),
  note: '',
}

const hasSupabaseEnv =
  Boolean(import.meta.env.VITE_SUPABASE_URL) &&
  Boolean(
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  )

const CATEGORY_LABELS = new Map<ExpenseCategory, string>(
  CATEGORY_META.map((item) => [item.value, item.label]),
)

const CATEGORY_ALIASES = new Map<string, ExpenseCategory>([
  ['volute', 'volute'],
  ['dovute', 'dovute'],
  ['necessarie', 'necessarie'],
  ['spese volute', 'volute'],
  ['spese dovute', 'dovute'],
  ['spese necessarie', 'necessarie'],
  ['voluta', 'volute'],
  ['dovuta', 'dovute'],
  ['necessaria', 'necessarie'],
])

const CSV_HEADERS = ['data', 'categoria', 'importo', 'note']

const escapeCsv = (value: string) => {
  const needsQuotes = /[",\n;]/.test(value)
  const escaped = value.replace(/"/g, '""')
  return needsQuotes ? `"${escaped}"` : escaped
}

const toCsvLine = (values: string[], separator: ',' | ';') =>
  values.map((value) => escapeCsv(value)).join(separator)

const splitCsvLine = (line: string, separator: ',' | ';') => {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (char === '"') {
      const nextChar = line[i + 1]
      if (inQuotes && nextChar === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (!inQuotes && char === separator) {
      cells.push(current)
      current = ''
      continue
    }

    current += char
  }

  cells.push(current)
  return cells
}

const normalizeCategory = (value: string): ExpenseCategory | null => {
  const normalized = value.trim().toLowerCase()
  if (CATEGORY_ALIASES.has(normalized)) {
    return CATEGORY_ALIASES.get(normalized) ?? null
  }

  const byLabel = CATEGORY_META.find(
    (item) => item.label.toLowerCase() === normalized,
  )
  return byLabel?.value ?? null
}

const normalizeDate = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('/')
    return `${year}-${month}-${day}`
  }
  return null
}

const parseCsv = (text: string) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return []

  const separator: ',' | ';' =
    lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','

  let headerMap: {
    date: number
    category: number
    amount: number
    note: number | null
  } | null = null

  const parsed: Array<{
    date: string
    category: ExpenseCategory
    amount: number
    note: string | null
  }> = []

  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (/^categoria:/i.test(trimmed)) return

    const cells = splitCsvLine(trimmed, separator).map((cell) => cell.trim())
    const lowered = cells.map((cell) => cell.toLowerCase())

    const hasDateHeader = lowered.includes('date') || lowered.includes('data')
    const hasCategoryHeader =
      lowered.includes('category') || lowered.includes('categoria')
    const hasAmountHeader = lowered.includes('amount') || lowered.includes('importo')

    if (hasDateHeader && hasCategoryHeader && hasAmountHeader) {
      const findIndex = (keys: string[]) =>
        lowered.findIndex((cell) => keys.includes(cell))

      headerMap = {
        date: findIndex(['date', 'data']),
        category: findIndex(['category', 'categoria']),
        amount: findIndex(['amount', 'importo']),
        note: findIndex(['note', 'nota']),
      }

      return
    }

    if (!headerMap) return
    if (cells.length <= Math.max(headerMap.date, headerMap.category, headerMap.amount)) {
      return
    }

    const dateValue = normalizeDate(cells[headerMap.date] ?? '')
    const categoryValue = normalizeCategory(cells[headerMap.category] ?? '')
    const amountValue = Number.parseFloat(
      (cells[headerMap.amount] ?? '').replace(/[^0-9,.-]/g, '').replace(',', '.'),
    )
    const noteValue =
      headerMap.note !== null ? cells[headerMap.note] ?? '' : ''

    if (!dateValue || !categoryValue || !Number.isFinite(amountValue)) return

    parsed.push({
      date: dateValue,
      category: categoryValue,
      amount: amountValue,
      note: noteValue ? noteValue : null,
    })
  })

  return parsed
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  )
  const [monthExpenses, setMonthExpenses] = useState<Expense[]>([])
  const [formState, setFormState] = useState(emptyForm)
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [resetMode, setResetMode] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [selectedCategories, setSelectedCategories] = useState<ExpenseCategory[]>([])
  const [yearExpenses, setYearExpenses] = useState<Expense[]>([])
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [deadlineForm, setDeadlineForm] = useState(emptyDeadlineForm)
  const [editingDeadlineId, setEditingDeadlineId] = useState<string | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importedFiles, setImportedFiles] = useState<string[]>([])
  const [showImportedFiles, setShowImportedFiles] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >('default')

  useEffect(() => {
    let isMounted = true

    const init = async () => {
      const { data } = await supabase.auth.getSession()
      if (!isMounted) return
      setSession(data.session)
      setLoading(false)
    }

    init()

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === 'PASSWORD_RECOVERY') {
          setResetMode(true)
        }
        setSession(nextSession)
      },
    )

    return () => {
      isMounted = false
      listener?.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session) {
      setMonthExpenses([])
      return
    }

    const loadMonthExpenses = async () => {
      setBusy(true)
      const [year, month] = selectedDate.split('-').map(Number)
      const monthStart = `${selectedDate.slice(0, 7)}-01`
      const monthEnd = new Date(year, month, 0)
        .toISOString()
        .slice(0, 10)

      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('user_id', session.user.id)
        .gte('date', monthStart)
        .lte('date', monthEnd)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile caricare le spese del mese.',
        })
        setMonthExpenses([])
      } else {
        setMonthExpenses((data as Expense[]) ?? [])
      }

      setBusy(false)
    }

    loadMonthExpenses()
  }, [session, selectedDate])

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 4200)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported')
      return
    }
    setNotificationPermission(Notification.permission)
  }, [])

  useEffect(() => {
    if (!session) {
      setDeadlines([])
      return
    }

    const loadDeadlines = async () => {
      const { data, error } = await supabase
        .from('deadlines')
        .select('*')
        .eq('user_id', session.user.id)
        .order('date', { ascending: true })

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile caricare le scadenze.',
        })
        setDeadlines([])
      } else {
        setDeadlines((data as Deadline[]) ?? [])
      }
    }

    loadDeadlines()
  }, [session])

  useEffect(() => {
    if (editingDeadlineId) return
    setDeadlineForm((prev) => ({
      ...prev,
      date: selectedDate || prev.date,
    }))
  }, [selectedDate, editingDeadlineId])

  const dayExpenses = useMemo(
    () => monthExpenses.filter((expense) => expense.date === selectedDate),
    [monthExpenses, selectedDate],
  )

  const monthTotals = useMemo(() => {
    const base = CATEGORY_META.reduce(
      (acc, category) => {
        acc[category.value] = 0
        return acc
      },
      {} as Record<ExpenseCategory, number>,
    )

    monthExpenses.forEach((expense) => {
      base[expense.category] += Number(expense.amount)
    })

    return base
  }, [monthExpenses])

  const dayTotal = useMemo(
    () =>
      dayExpenses.reduce((total, expense) => total + Number(expense.amount), 0),
    [dayExpenses],
  )

  const monthTotal = useMemo(
    () =>
      monthExpenses.reduce(
        (total, expense) => total + Number(expense.amount),
        0,
      ),
    [monthExpenses],
  )

  const toggleCategory = (cat: ExpenseCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    )
  }

  const year = useMemo(() => new Date(selectedDate).getFullYear(), [selectedDate])

  // load year expenses for YTD totals and per-month totals
  useEffect(() => {
    if (!session) {
      setYearExpenses([])
      return
    }

    const loadYearExpenses = async () => {
      const now = new Date()
      const start = `${year}-01-01`
      const end =
        year === now.getFullYear()
          ? now.toISOString().slice(0, 10)
          : `${year}-12-31`

      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('user_id', session.user.id)
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: false })

      if (error) {
        // keep silent, yearExpenses stays empty
        setYearExpenses([])
      } else {
        setYearExpenses((data as Expense[]) ?? [])
      }
    }

    loadYearExpenses()
  }, [session, year])

  const monthsOfYear = useMemo(() => {
    const now = new Date()
    const lastMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12
    return Array.from({ length: lastMonth }, (_, i) => i + 1)
  }, [year])

  const monthSums = useMemo(() => {
    const sums: Record<string, number> = {}
    monthsOfYear.forEach((m) => {
      const mm = String(m).padStart(2, '0')
      const key = `${year}-${mm}`
      sums[key] = 0
    })

    yearExpenses.forEach((e) => {
      const key = e.date.slice(0, 7)
      sums[key] = (sums[key] ?? 0) + Number(e.amount)
    })

    return sums
  }, [yearExpenses, monthsOfYear, year])

  const yearTotal = useMemo(() => {
    return Object.values(monthSums).reduce((s, v) => s + v, 0)
  }, [monthSums])

  const groupedByCategory = useMemo(() => {
    if (selectedCategories.length === 0) return {}
    const map: Record<ExpenseCategory, Expense[]> = {
      volute: [],
      dovute: [],
      necessarie: [],
    }
    monthExpenses
      .filter((e) => selectedCategories.includes(e.category))
      .forEach((e) => map[e.category].push(e))
    return map
  }, [monthExpenses, selectedCategories])

  const sortedDeadlines = useMemo(() => {
    return [...deadlines].sort((a, b) => a.date.localeCompare(b.date))
  }, [deadlines])

  const getDeadlineStatus = (dateValue: string) => {
    const today = new Date()
    const target = new Date(`${dateValue}T00:00:00`)
    const diffMs = target.getTime() - today.setHours(0, 0, 0, 0)
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays < 0) {
      return { label: `Scaduta da ${Math.abs(diffDays)} gg`, tone: 'overdue' }
    }
    if (diffDays === 0) {
      return { label: 'Scade oggi', tone: 'due' }
    }
    if (diffDays <= 14) {
      return { label: `Scade tra ${diffDays} gg`, tone: 'due' }
    }
    return { label: `Tra ${diffDays} gg`, tone: 'upcoming' }
  }

  useEffect(() => {
    if (!session) return
    if (notificationPermission !== 'granted') return
    if (deadlines.length === 0) return

    const notify = async () => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const nowIso = new Date().toISOString()

      const dueSoon = deadlines.filter((item) => {
        const target = new Date(`${item.date}T00:00:00`)
        const diffDays = Math.ceil(
          (target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
        )
        return diffDays >= 0 && diffDays <= 10
      })

      const toNotify = dueSoon.filter((item) => {
        if (!item.last_notified_at) return true
        const last = new Date(item.last_notified_at)
        last.setHours(0, 0, 0, 0)
        return last.getTime() < today.getTime()
      })

      if (toNotify.length === 0) return

      toNotify.forEach((item) => {
        new Notification('Scadenza in arrivo', {
          body: `${item.title} - ${formatDate(item.date)}`,
        })
      })

      const ids = toNotify.map((item) => item.id)
      const { error } = await supabase
        .from('deadlines')
        .update({ last_notified_at: nowIso })
        .in('id', ids)
        .eq('user_id', session.user.id)

      if (!error) {
        setDeadlines((prev) =>
          prev.map((item) =>
            ids.includes(item.id)
              ? { ...item, last_notified_at: nowIso }
              : item,
          ),
        )
      }
    }

    notify()
  }, [deadlines, notificationPermission, session])

  const handleAuthSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!authEmail || !authPassword) return

    setBusy(true)
    const action =
      authMode === 'sign-up'
        ? supabase.auth.signUp({
            email: authEmail,
            password: authPassword,
          })
        : supabase.auth.signInWithPassword({
            email: authEmail,
            password: authPassword,
          })

    const { error } = await action

    if (error) {
      setStatus({
        type: 'error',
        message: 'Accesso non riuscito. Controlla le credenziali.',
      })
    } else {
      setStatus({
        type: 'success',
        message:
          authMode === 'sign-up'
            ? 'Registrazione completata.'
            : 'Accesso effettuato.',
      })
    }

    setBusy(false)
  }

  const handlePasswordReset = async () => {
    if (!authEmail) {
      setStatus({
        type: 'error',
        message: 'Inserisci la tua email per il recupero password.',
      })
      return
    }

    setBusy(true)
    const { error } = await supabase.auth.resetPasswordForEmail(authEmail, {
      redirectTo: window.location.origin,
    })

    if (error) {
      setStatus({
        type: 'error',
        message: 'Recupero password non riuscito. Riprova.',
      })
    } else {
      setStatus({
        type: 'success',
        message: 'Email di recupero inviata. Controlla la posta.',
      })
    }

    setBusy(false)
  }

  const handlePasswordUpdate = async () => {
    if (resetPassword.length < 8) {
      setStatus({
        type: 'error',
        message: 'La nuova password deve avere almeno 8 caratteri.',
      })
      return
    }

    if (resetPassword !== resetPasswordConfirm) {
      setStatus({
        type: 'error',
        message: 'Le password non coincidono.',
      })
      return
    }

    setBusy(true)
    const { error } = await supabase.auth.updateUser({
      password: resetPassword,
    })

    if (error) {
      setStatus({
        type: 'error',
        message: 'Impossibile aggiornare la password. Riprova.',
      })
      setBusy(false)
      return
    }

    setStatus({
      type: 'success',
      message: 'Password aggiornata. Ora puoi accedere.',
    })
    setResetMode(false)
    setResetPassword('')
    setResetPasswordConfirm('')
    await supabase.auth.signOut()
    setBusy(false)
  }

  const handleSignOut = async () => {
    setBusy(true)
    await supabase.auth.signOut()
    setBusy(false)
  }

  const handleSaveExpense = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!session) return

    const amountValue = Number.parseFloat(formState.amount)
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      setStatus({
        type: 'error',
        message: 'Inserisci un importo valido maggiore di zero.',
      })
      return
    }

    setBusy(true)

    if (editingExpenseId) {
      const { data, error } = await supabase
        .from('expenses')
        .update({
          amount: amountValue,
          category: formState.category,
          note: formState.note || null,
          date: selectedDate,
        })
        .eq('id', editingExpenseId)
        .eq('user_id', session.user.id)
        .select()
        .single()

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile aggiornare la spesa. Riprova.',
        })
      } else if (data) {
        setMonthExpenses((prev) =>
          prev.map((item) => (item.id === editingExpenseId ? data : item)),
        )
        setFormState(emptyForm)
        setEditingExpenseId(null)
        setStatus({ type: 'success', message: 'Spesa aggiornata.' })
      }
    } else {
      const { data, error } = await supabase
        .from('expenses')
        .insert({
          user_id: session.user.id,
          amount: amountValue,
          category: formState.category,
          note: formState.note || null,
          date: selectedDate,
        })
        .select()
        .single()

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile salvare la spesa. Riprova.',
        })
      } else if (data) {
        setMonthExpenses((prev) => [data as Expense, ...prev])
        setFormState(emptyForm)
        setStatus({ type: 'success', message: 'Spesa salvata.' })
      }
    }

    setBusy(false)
  }

  const handleEditExpense = (expense: Expense) => {
    setEditingExpenseId(expense.id)
    setFormState({
      amount: String(expense.amount),
      category: expense.category,
      note: expense.note ?? '',
    })
    setSelectedDate(expense.date)
  }

  const handleDeleteExpense = async (expenseId: string) => {
    if (!session) return
    const confirmed = window.confirm(
      'Vuoi eliminare questa spesa? Questa azione non puo essere annullata.',
    )
    if (!confirmed) return
    setBusy(true)

    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', expenseId)
      .eq('user_id', session.user.id)

    if (error) {
      setStatus({
        type: 'error',
        message: 'Impossibile eliminare la spesa.',
      })
    } else {
      setMonthExpenses((prev) => prev.filter((item) => item.id !== expenseId))
      setStatus({ type: 'success', message: 'Spesa eliminata.' })
    }

    setBusy(false)
  }

  const handleSaveDeadline = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!session) return
    if (!deadlineForm.title.trim() || !deadlineForm.date) {
      setStatus({
        type: 'error',
        message: 'Inserisci titolo e data per la scadenza.',
      })
      return
    }

    setBusy(true)

    if (editingDeadlineId) {
      const { data, error } = await supabase
        .from('deadlines')
        .update({
          title: deadlineForm.title.trim(),
          note: deadlineForm.note || null,
          date: deadlineForm.date,
        })
        .eq('id', editingDeadlineId)
        .eq('user_id', session.user.id)
        .select()
        .single()

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile aggiornare la scadenza.',
        })
      } else if (data) {
        setDeadlines((prev) =>
          prev.map((item) => (item.id === editingDeadlineId ? data : item)),
        )
        setEditingDeadlineId(null)
        setDeadlineForm({ ...emptyDeadlineForm, date: selectedDate })
        setStatus({ type: 'success', message: 'Scadenza aggiornata.' })
      }
    } else {
      const { data, error } = await supabase
        .from('deadlines')
        .insert({
          user_id: session.user.id,
          title: deadlineForm.title.trim(),
          note: deadlineForm.note || null,
          date: deadlineForm.date,
        })
        .select()
        .single()

      if (error) {
        setStatus({
          type: 'error',
          message: 'Impossibile salvare la scadenza.',
        })
      } else if (data) {
        setDeadlines((prev) => [...prev, data as Deadline])
        setDeadlineForm({ ...emptyDeadlineForm, date: selectedDate })
        setStatus({ type: 'success', message: 'Scadenza salvata.' })
      }
    }

    setBusy(false)
  }

  const handleEditDeadline = (deadline: Deadline) => {
    setEditingDeadlineId(deadline.id)
    setDeadlineForm({
      title: deadline.title,
      date: deadline.date,
      note: deadline.note ?? '',
    })
  }

  const handleCancelDeadlineEdit = () => {
    setEditingDeadlineId(null)
    setDeadlineForm({ ...emptyDeadlineForm, date: selectedDate })
  }

  const handleDeleteDeadline = async (deadlineId: string) => {
    if (!session) return
    const confirmed = window.confirm(
      'Vuoi eliminare questa scadenza? Questa azione non puo essere annullata.',
    )
    if (!confirmed) return
    setBusy(true)

    const { error } = await supabase
      .from('deadlines')
      .delete()
      .eq('id', deadlineId)
      .eq('user_id', session.user.id)

    if (error) {
      setStatus({
        type: 'error',
        message: 'Impossibile eliminare la scadenza.',
      })
    } else {
      setDeadlines((prev) => prev.filter((item) => item.id !== deadlineId))
      setStatus({ type: 'success', message: 'Scadenza eliminata.' })
    }

    setBusy(false)
  }

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported')
      setStatus({
        type: 'error',
        message: 'Notifiche non supportate dal browser.',
      })
      return
    }

    const result = await Notification.requestPermission()
    setNotificationPermission(result)
    if (result !== 'granted') {
      setStatus({
        type: 'error',
        message: 'Permesso notifiche non concesso.',
      })
    }
  }

  const buildCsv = (
    items: Expense[],
    label: string,
    separator: ',' | ';' = ',',
  ) => {
    const lines: string[] = []
    lines.push(toCsvLine([...CSV_HEADERS, 'categoria_label'], separator))

    const sorted = [...items].sort((a, b) => {
      if (a.category === b.category) return a.date.localeCompare(b.date)
      const order = CATEGORY_META.map((item) => item.value)
      return order.indexOf(a.category) - order.indexOf(b.category)
    })

    sorted.forEach((item) => {
      const labelText = CATEGORY_LABELS.get(item.category) ?? item.category
      lines.push(
        toCsvLine(
          [
            item.date,
            item.category,
            String(item.amount),
            item.note ?? '',
            labelText,
          ],
          separator,
        ),
      )
    })

    return lines.join('\n')
  }

  const downloadCsv = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const handleExport = (scope: 'month' | 'year') => {
    const label =
      scope === 'month'
        ? formatMonth(selectedDate.slice(0, 7))
        : `Anno ${year}`
    const rows = scope === 'month' ? monthExpenses : yearExpenses
    const csv = buildCsv(rows, label, ';')
    const safeLabel =
      scope === 'month' ? selectedDate.slice(0, 7) : String(year)
    downloadCsv(`spese-${safeLabel}.csv`, csv)
  }

  const handleImport = async () => {
    if (!session || !importFile) return

    setBusy(true)
    const text = await importFile.text()
    const parsed = parseCsv(text)

    if (parsed.length === 0) {
      setStatus({ type: 'error', message: 'Nessun dato valido nel file.' })
      setBusy(false)
      return
    }

    const payload = parsed.map((row) => ({
      user_id: session.user.id,
      date: row.date,
      category: row.category,
      amount: row.amount,
      note: row.note,
    }))

    const { data, error } = await supabase
      .from('expenses')
      .insert(payload)
      .select()

    if (error) {
      setStatus({
        type: 'error',
        message: 'Importazione non riuscita. Controlla il file.',
      })
      setBusy(false)
      return
    }

    if (data && data.length > 0) {
      const inserted = data as Expense[]
      setMonthExpenses((prev) => {
        const monthKey = selectedDate.slice(0, 7)
        const toAdd = inserted.filter((item) => item.date.startsWith(monthKey))
        if (toAdd.length === 0) return prev
        return [...toAdd, ...prev]
      })
      setYearExpenses((prev) => {
        const toAdd = inserted.filter((item) => item.date.startsWith(`${year}-`))
        if (toAdd.length === 0) return prev
        return [...toAdd, ...prev]
      })
    }

    setImportFile(null)
    setImportedFiles((prev) => [importFile.name, ...prev])
    setShowImportedFiles(true)
    setStatus({ type: 'success', message: 'Importazione completata.' })
    setBusy(false)
  }

  const handleCancelEdit = () => {
    setEditingExpenseId(null)
    setFormState(emptyForm)
  }

  if (!hasSupabaseEnv) {
    return (
      <div className="shell">
        <section className="empty-state">
          <h1>Configura Supabase</h1>
          <p>
            Aggiungi le variabili in <strong>.env</strong> per continuare. Usa
            <strong> VITE_SUPABASE_URL</strong> e{' '}
            <strong>VITE_SUPABASE_ANON_KEY</strong>.
          </p>
        </section>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="shell">
        <section className="empty-state">
          <h1>Spese AI</h1>
          <p>Caricamento in corso...</p>
        </section>
      </div>
    )
  }

  if (resetMode) {
    return (
      <div className="shell">
        <section className="auth-card">
          <div className="auth-header">
            <span className="pill">Spese AI</span>
            <h1>Nuova password</h1>
            <p>Inserisci una nuova password per completare il recupero.</p>
          </div>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault()
              handlePasswordUpdate()
            }}
          >
            <label>
              Nuova password
              <input
                type="password"
                placeholder="Minimo 8 caratteri"
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <label>
              Conferma password
              <input
                type="password"
                placeholder="Ripeti la nuova password"
                value={resetPasswordConfirm}
                onChange={(event) => setResetPasswordConfirm(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Aggiornamento...' : 'Aggiorna password'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setResetMode(false)}
              disabled={busy}
            >
              Torna al login
            </button>
          </form>
        </section>
        {status && (
          <div className={`toast ${status.type}`}>{status.message}</div>
        )}
      </div>
    )
  }

  if (!session) {
    return (
      <div className="shell">
        <section className="auth-card">
          <div className="auth-header">
            <span className="pill">Spese AI</span>
            <h1>Accesso sicuro</h1>
            <p>Gestisci le spese quotidiane con dati sempre protetti.</p>
          </div>
          <div className="auth-tabs">
            <button
              type="button"
              className={authMode === 'sign-in' ? 'active' : ''}
              onClick={() => setAuthMode('sign-in')}
            >
              Accedi
            </button>
            <button
              type="button"
              className={authMode === 'sign-up' ? 'active' : ''}
              onClick={() => setAuthMode('sign-up')}
            >
              Crea account
            </button>
          </div>
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label>
              Email
              <input
                type="email"
                placeholder="nome@azienda.com"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                placeholder="Minimo 8 caratteri"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy
                ? 'Attendere...'
                : authMode === 'sign-up'
                  ? 'Crea account'
                  : 'Accedi'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handlePasswordReset}
              disabled={busy}
            >
              Recupera password
            </button>
          </form>
        </section>
        {status && (
          <div className={`toast ${status.type}`}>{status.message}</div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SA</div>
          <div>
            <p className="brand-title">Spese AI</p>
            <span className="brand-subtitle">Monitoraggio professionale</span>
          </div>
        </div>

        <div className="sidebar-card">
          <h3>Categorie</h3>
          <ul>
            {CATEGORY_META.map((category) => (
              <li
                key={category.value}
                role="button"
                tabIndex={0}
                onClick={() => {
                  toggleCategory(category.value)
                  setTimeout(
                    () =>
                      document
                        .querySelector('.grouped-expenses')
                        ?.scrollIntoView({ behavior: 'smooth' }),
                    140,
                  )
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleCategory(category.value)
                  }
                }}
                className={selectedCategories.includes(category.value) ? 'selected-cat' : ''}
              >
                <span>{category.label}</span>
                <small>{category.description}</small>
              </li>
            ))}
          </ul>
        </div>

      </aside>

      <main className="main">
        <div className="top-row">
          <header className="topbar topbar-compact">
            <div className="topbar-text">
              <p className="eyebrow">Dashboard mensile</p>
              <h1>{formatMonth(selectedDate.slice(0, 7))}</h1>
              <p className="muted">
                Totale mese <strong>{formatCurrency(monthTotal)}</strong>
              </p>
            </div>
            <div className="date-card topbar-date">
              <label>
                Giorno
                <input
                  type="date"
                  className="date-input"
                  value={selectedDate}
                  onChange={(event) =>
                    setSelectedDate(
                      event.target.value || new Date().toISOString().slice(0, 10),
                    )
                  }
                />
              </label>
              <span className="date-label">{formatDate(selectedDate)}</span>
              <span className="date-total">{formatCurrency(dayTotal)}</span>
            </div>
          </header>
          <aside className="user-card">
            <div>
              <p className="user-title">Utente</p>
              <div className="user-identity">
                <span className="user-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="img" focusable="false">
                    <path
                      d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4.42 0-8 2-8 4v2h16v-2c0-2-3.58-4-8-4Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span className="user-email user-email-accent">
                  {session.user.email}
                </span>
              </div>
              <p className="user-security">
                Autenticazione solida: recupero password, verifica email, policy
                sicurezza, rate limiting.
              </p>
            </div>
            <button type="button" onClick={handleSignOut} disabled={busy}>
              Esci
            </button>
          </aside>
        </div>

        <div className="compact-tools">
          <div className="compact-title">Export / Import CSV</div>
          <span className="compact-label">Esporta</span>
          <div className="compact-actions">
            <button type="button" onClick={() => handleExport('month')}>
              Mese
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => handleExport('year')}
            >
              Anno
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowImportedFiles((prev) => !prev)}
            >
              File importati
            </button>
          </div>
          <span className="compact-label">Importa</span>
          <div className="compact-actions">
            <label className="file-input">
              <span>Seleziona CSV</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) =>
                  setImportFile(event.target.files?.[0] ?? null)
                }
              />
            </label>
            <button
              type="button"
              className="ghost"
              onClick={handleImport}
              disabled={!importFile || busy}
            >
              {busy ? 'Importazione...' : 'Importa'}
            </button>
          </div>
          {showImportedFiles && (
            <div className="imported-list">
              {importedFiles.length === 0 ? (
                <span className="muted">Nessun file importato.</span>
              ) : (
                <ul>
                  {importedFiles.map((name, index) => (
                    <li key={`${name}-${index}`}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>


        <div className="year-panel">
          <div className="year-top">
            <div>
              <p className="eyebrow">Totale anno</p>
              <h2>{formatCurrency(yearTotal)}</h2>
            </div>
            <div className="months-row">
              {monthsOfYear.map((m) => {
                const mm = String(m).padStart(2, '0')
                const key = `${year}-${mm}`
                return (
                  <button
                    key={key}
                    type="button"
                    className={`month-chip ${selectedDate.slice(0, 7) === key ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedDate(`${key}-01`)
                      document
                        .querySelector('.panel.deadlines')
                        ?.scrollIntoView({ behavior: 'smooth' })
                    }}
                  >
                    <span className="month-label">{new Date(year, m - 1).toLocaleString('it-IT', { month: 'short' })}</span>
                    <small className="month-sum">{formatCurrency(monthSums[key] ?? 0)}</small>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <section className="stat-grid">
          {CATEGORY_META.map((category) => (
            <article key={category.value} className="stat-card">
              <p>{category.label}</p>
              <h2>{formatCurrency(monthTotals[category.value] ?? 0)}</h2>
              <span>{category.description}</span>
            </article>
          ))}
        </section>
        {selectedCategories.length > 0 && (
          <section className="content-grid grouped-panel-wrap">
            <article className="panel grouped-expenses">
              <div className="panel-header">
                <h3>Selezionate: {selectedCategories.map((c) => c).join(', ')}</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="muted">{Object.values(groupedByCategory).reduce((acc, arr) => acc + arr.length, 0)} risultati</span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setSelectedCategories([])}
                  >
                    Pulisci
                  </button>
                </div>
              </div>
              <div className="panel-body scroll">
                {Object.values(groupedByCategory).every((arr) => arr.length === 0) ? (
                  <div className="empty">Nessuna spesa per le categorie scelte.</div>
                ) : (
                  <div>
                    {CATEGORY_META.map((cat) => (
                      <div key={cat.value} className="category-group">
                        <h4 className="category-group-title">{cat.label} ({(groupedByCategory[cat.value] || []).length})</h4>
                        <ul className="expense-list">
                          {(groupedByCategory[cat.value] || []).map((expense) => (
                            <li key={expense.id}>
                              <div>
                                <span className={`badge ${expense.category}`}>
                                  {cat.label}
                                </span>
                                <p>{expense.note || 'Senza nota'}</p>
                              </div>
                              <div className="expense-meta">
                                <strong>{formatCurrency(Number(expense.amount))}</strong>
                                <div className="expense-actions">
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() => handleEditExpense(expense)}
                                    disabled={busy}
                                  >
                                    Modifica
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost danger"
                                    onClick={() => handleDeleteExpense(expense.id)}
                                    disabled={busy}
                                  >
                                    Elimina
                                  </button>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          </section>
        )}

        <section className="content-grid">
          <article className="panel new-expense">
            <div className="panel-header">
              <h3>{editingExpenseId ? 'Modifica spesa' : 'Nuova spesa'}</h3>
              <span className="pill">{formatDate(selectedDate)}</span>
            </div>
            <div className="panel-body">
              <form className="expense-form" onSubmit={handleSaveExpense}>
                <label>
                  Importo
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    value={formState.amount}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        amount: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Categoria
                  <select
                    value={formState.category}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        category: event.target.value as ExpenseCategory,
                      }))
                    }
                  >
                    {CATEGORY_META.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Note
                  <textarea
                    rows={3}
                    placeholder="Dettagli extra o contesto"
                    value={formState.note}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        note: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="form-actions">
                  <button type="submit" disabled={busy}>
                    {busy
                      ? 'Salvataggio...'
                      : editingExpenseId
                        ? 'Aggiorna spesa'
                        : 'Salva spesa'}
                  </button>
                  {editingExpenseId && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={handleCancelEdit}
                      disabled={busy}
                    >
                      Annulla
                    </button>
                  )}
                </div>
              </form>
            </div>
          </article>

          <article className="panel daily-expenses">
            <div className="panel-header">
              <h3>Spese del giorno</h3>
              <span className="muted">{dayExpenses.length} movimenti</span>
            </div>
            <div className="panel-body scroll">
              {dayExpenses.length === 0 ? (
                <div className="empty">Nessuna spesa ancora per oggi.</div>
              ) : (
                <ul className="expense-list">
                  {dayExpenses.map((expense) => (
                    <li key={expense.id}>
                      <div>
                        <span className={`badge ${expense.category}`}>
                          {
                            CATEGORY_META.find(
                              (category) =>
                                category.value === expense.category,
                            )?.label
                          }
                        </span>
                        <p>{expense.note || 'Senza nota'}</p>
                      </div>
                      <div className="expense-meta">
                        <strong>
                          {formatCurrency(Number(expense.amount))}
                        </strong>
                        <div className="expense-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleEditExpense(expense)}
                            disabled={busy}
                          >
                            Modifica
                          </button>
                          <button
                            type="button"
                            className="ghost danger"
                            onClick={() => handleDeleteExpense(expense.id)}
                            disabled={busy}
                          >
                            Elimina
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>

          <article className="panel deadlines">
            <div className="panel-header">
              <div>
                <h3>Scadenze</h3>
                <span className="muted">
                  Assicurazione, bollo, revisione, documenti
                </span>
              </div>
              {notificationPermission === 'default' && (
                <button
                  type="button"
                  className="ghost"
                  onClick={handleEnableNotifications}
                  disabled={busy}
                >
                  Abilita notifiche
                </button>
              )}
              {notificationPermission === 'denied' && (
                <span className="muted">Notifiche disattivate</span>
              )}
              {notificationPermission === 'unsupported' && (
                <span className="muted">Notifiche non supportate</span>
              )}
            </div>
            <div className="panel-body scroll">
              <form className="deadline-form" onSubmit={handleSaveDeadline}>
                <label>
                  Titolo
                  <input
                    type="text"
                    placeholder="Assicurazione auto"
                    value={deadlineForm.title}
                    onChange={(event) =>
                      setDeadlineForm((prev) => ({
                        ...prev,
                        title: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Data
                  <input
                    type="date"
                    value={deadlineForm.date}
                    onChange={(event) =>
                      setDeadlineForm((prev) => ({
                        ...prev,
                        date: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  Note
                  <textarea
                    rows={2}
                    placeholder="Dettagli o promemoria"
                    value={deadlineForm.note}
                    onChange={(event) =>
                      setDeadlineForm((prev) => ({
                        ...prev,
                        note: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="form-actions">
                  <button type="submit" disabled={busy}>
                    {busy
                      ? 'Salvataggio...'
                      : editingDeadlineId
                        ? 'Aggiorna scadenza'
                        : 'Salva scadenza'}
                  </button>
                  {editingDeadlineId && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={handleCancelDeadlineEdit}
                      disabled={busy}
                    >
                      Annulla
                    </button>
                  )}
                </div>
              </form>
              {sortedDeadlines.length === 0 ? (
                <div className="empty">Nessuna scadenza salvata.</div>
              ) : (
                <ul className="deadline-list">
                  {sortedDeadlines.map((item) => {
                    const status = getDeadlineStatus(item.date)
                    return (
                      <li key={item.id} className="deadline-item">
                        <div>
                          <p className="deadline-title">{item.title}</p>
                          <span className="deadline-note">
                            {item.note || 'Senza note'}
                          </span>
                        </div>
                        <div className="deadline-meta">
                          <span className="deadline-date">
                            {formatDate(item.date)}
                          </span>
                          <span className={`deadline-status ${status.tone}`}>
                            {status.label}
                          </span>
                          <div className="deadline-actions">
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => handleEditDeadline(item)}
                              disabled={busy}
                            >
                              Modifica
                            </button>
                            <button
                              type="button"
                              className="ghost danger"
                              onClick={() => handleDeleteDeadline(item.id)}
                              disabled={busy}
                            >
                              Elimina
                            </button>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </article>
        </section>

      </main>

      {status && <div className={`toast ${status.type}`}>{status.message}</div>}
    </div>
  )
}

export default App
