// "Claim first, then send": flips a flag from false to true in one atomic update, and only the
// caller whose update changed a row goes on to send. Two near-simultaneous calls can't both send.

type Updater = {
  from: (table: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { select: (cols: string) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } }
    }
  }
}

/** True if this call won the claim (the flag was false and is now true). */
export async function claimOnce(db: Updater, table: string, id: string, flag: string): Promise<boolean> {
  const { data, error } = await db.from(table).update({ [flag]: true }).eq('id', id).eq(flag, false).select('id')
  if (error) throw new Error(error.message)
  return !!data && data.length > 0
}

/** Gives the claim back (used when every send failed, so a retry can go out). */
export async function releaseClaim(db: Updater, table: string, id: string, flag: string): Promise<void> {
  await db.from(table).update({ [flag]: false }).eq('id', id).eq(flag, true).select('id')
}
