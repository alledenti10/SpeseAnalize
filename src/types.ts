export type ExpenseCategory = 'volute' | 'dovute' | 'necessarie'

export type Expense = {
  id: string
  user_id: string
  amount: number
  category: ExpenseCategory
  note: string | null
  date: string
  created_at: string
}

export type Deadline = {
  id: string
  user_id: string
  title: string
  note: string | null
  date: string
  created_at: string
  last_notified_at: string | null
}
