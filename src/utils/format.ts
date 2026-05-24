export const formatCurrency = (value: number) =>
  new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value)

const parseSafeDate = (value: string, suffix: string) => {
  if (!value) return null
  const date = new Date(`${value}${suffix}`)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDate = (value: string) => {
  const date = parseSafeDate(value, 'T00:00:00')
  if (!date) return ''
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(date)
}

export const formatMonth = (value: string) => {
  const date = parseSafeDate(value, '-01T00:00:00')
  if (!date) return ''
  return new Intl.DateTimeFormat('it-IT', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}
