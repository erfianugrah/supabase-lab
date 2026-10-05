import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-4xl font-bold">Purchase requests</h1>
      <p className="text-muted-foreground">An internal app built on the governed starter kit</p>
      <Button asChild>
        <Link href="/login">Sign in</Link>
      </Button>
    </div>
  )
}
