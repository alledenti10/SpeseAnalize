import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type DeadlineRow = {
  id: string
  user_id: string
  title: string
  date: string
  last_notified_at: string | null
}

type SubscriptionRow = {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })

serve(async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const cronSecret = Deno.env.get('CRON_SECRET')
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (cronSecret && token !== cronSecret) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: 'Missing server configuration' }, 500)
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)

  const admin = createClient(supabaseUrl, serviceRoleKey)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const upperDate = new Date(today)
  upperDate.setDate(today.getDate() + 10)

  const todayIso = today.toISOString().slice(0, 10)
  const upperIso = upperDate.toISOString().slice(0, 10)

  const { data: deadlines, error: deadlinesError } = await admin
    .from('deadlines')
    .select('id,user_id,title,date,last_notified_at')
    .gte('date', todayIso)
    .lte('date', upperIso)
    .or(`last_notified_at.is.null,last_notified_at.lt.${today.toISOString()}`)
    .returns<DeadlineRow[]>()

  if (deadlinesError) {
    return json({ error: deadlinesError.message }, 500)
  }

  if (!deadlines || deadlines.length === 0) {
    return json({ checked: 0, sent: 0, failed: 0 })
  }

  const userIds = [...new Set(deadlines.map((deadline) => deadline.user_id))]
  const { data: subscriptions, error: subscriptionsError } = await admin
    .from('notification_subscriptions')
    .select('id,user_id,endpoint,p256dh,auth')
    .in('user_id', userIds)
    .returns<SubscriptionRow[]>()

  if (subscriptionsError) {
    return json({ error: subscriptionsError.message }, 500)
  }

  const subscriptionsByUser = new Map<string, SubscriptionRow[]>()
  for (const subscription of subscriptions ?? []) {
    const userSubscriptions = subscriptionsByUser.get(subscription.user_id) ?? []
    userSubscriptions.push(subscription)
    subscriptionsByUser.set(subscription.user_id, userSubscriptions)
  }

  let sent = 0
  let failed = 0
  const notifiedDeadlineIds = new Set<string>()

  for (const deadline of deadlines) {
    const userSubscriptions = subscriptionsByUser.get(deadline.user_id) ?? []

    for (const subscription of userSubscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              auth: subscription.auth,
              p256dh: subscription.p256dh,
            },
          },
          JSON.stringify({
            body: `${deadline.title} - ${deadline.date}`,
            tag: `deadline-${deadline.id}-${deadline.date}`,
            title: 'Scadenza in arrivo',
            url: '/?section=deadlines',
          }),
        )
        sent += 1
        notifiedDeadlineIds.add(deadline.id)
      } catch (error) {
        failed += 1
        const statusCode = (error as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          await admin
            .from('notification_subscriptions')
            .delete()
            .eq('id', subscription.id)
        }
      }
    }
  }

  if (notifiedDeadlineIds.size > 0) {
    await admin
      .from('deadlines')
      .update({ last_notified_at: new Date().toISOString() })
      .in('id', [...notifiedDeadlineIds])
  }

  return json({ checked: deadlines.length, sent, failed })
})
