'use client'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useState } from 'react'

export interface PurchaseRequest {
  id: string
  requester_id: string
  item: string
  vendor: string
  amount: number
  justification: string
  status: 'pending' | 'approved' | 'rejected'
  decision_note: string | null
  created_at: string
}

// The client sends only the request fields; department, requester and status
// come from column defaults and are checked by the insert policy. Decisions go
// through decide_purchase_request, which runs as this user, so a non-manager
// or another department's manager gets an error back from the database.
export default function RequestsClient({
  initial,
  userId,
  isManager,
}: {
  initial: PurchaseRequest[]
  userId: string
  isManager: boolean
}) {
  const supabase = createClient()
  const [requests, setRequests] = useState(initial)
  const [item, setItem] = useState('')
  const [vendor, setVendor] = useState('')
  const [amount, setAmount] = useState('')
  const [justification, setJustification] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const { data, error } = await supabase
      .from('purchase_requests')
      .insert({ item, vendor, amount: Number(amount), justification })
      .select('id, requester_id, item, vendor, amount, justification, status, decision_note, created_at')
      .single()
    if (error) return setError(error.message)
    setRequests([data as PurchaseRequest, ...requests])
    setItem('')
    setVendor('')
    setAmount('')
    setJustification('')
  }

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setError(null)
    const { data, error } = await supabase.rpc('decide_purchase_request', { request_id: id, decision })
    if (error) return setError(error.message)
    const updated = data as PurchaseRequest
    setRequests(requests.map((r) => (r.id === id ? { ...r, status: updated.status } : r)))
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>New request</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="item">Item</Label>
              <Input id="item" value={item} onChange={(e) => setItem(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendor">Vendor</Label>
              <Input id="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="justification">Justification</Label>
              <Input
                id="justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Submit</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <div className="space-y-3">
        {requests.length === 0 && <p className="text-muted-foreground">No requests in your department yet.</p>}
        {requests.map((r) => (
          <Card key={r.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <div>
                <p className="font-medium">
                  {r.item} - {r.vendor}
                </p>
                <p className="text-sm text-muted-foreground">
                  {Number(r.amount).toFixed(2)} - {r.justification}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm">{r.status}</span>
                {isManager && r.status === 'pending' && r.requester_id !== userId && (
                  <>
                    <Button size="sm" onClick={() => decide(r.id, 'approved')}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => decide(r.id, 'rejected')}>
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
